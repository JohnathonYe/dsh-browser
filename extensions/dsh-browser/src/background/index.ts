/**
 * Background service worker entry: owns the bridge connection, the gateway
 * RPC client, controlled-tab tool dispatch, and the panel port service.
 *
 * MV3 survival: after the user opens the panel, its port plus a half-minute
 * `alarms` keepalive re-arm the reconnect loop. Merely loading the extension
 * never probes or claims the single-connection bridge.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', settings: Partial<Settings> }
 *   panel → bg: { type: 'session.active', sessionId }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'tab-affinity.response', revision, decision, sessionId }
 *   panel → bg: { type: 'tab-affinity.rebind', id }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps? }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *   bg → panel: { type: 'session.resume-hint', sessionId }
 *   bg → panel: { type: 'tab-affinity', state }
 *   bg → panel: { type: 'tab-affinity.rebind.result', id, ok, error? }
 *
 * @module
 */

import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  isRespondResult,
  type BridgeCaps,
  type RespondResult,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import { dispatchToolCall, resetTabSnapshot, type ToolAnswer, type ToolCall } from './tools.ts'
import { debuggerSession } from './debugger-session.ts'
import { replayMouseSteps, type MouseStep } from './input.ts'
import {
  modelVisibleImageSize,
  pngSizeFromBase64,
} from './screenshot-meta.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'
import { InteractionResponseRouter } from './responses.ts'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
} from '../security/trusted-origins.ts'
import { TransientEventCache } from './transient-events.ts'
import {
  TabAffinityController,
  type AffinityTab,
  type TabAffinityDecision,
} from './tab-affinity.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'
import {
  RECENT_SESSION_STORAGE_KEY,
  RecentSessionTracker,
  sessionIdFromFrame,
} from './session-continuity.ts'
import {
  TabAuthorizationController,
  MAX_GROUP_TABS,
  normalizeGroupTitle,
  type TabAuthAction,
} from './tab-authorization.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no side panel can display an approval. */
  approvalNotifications: boolean
  /** Restore the last active browser conversation when the panel reopens. */
  autoResumeSession: boolean
  /** Master switch for the AI's ability to drive the browser. Off blocks browser_* tools. */
  controlEnabled: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoResumeSession: true,
  controlEnabled: true,
}

/** 自动探测的候选端口（dsh web 默认 3080；桌面应用常用 14389；--port 覆盖的常见值）。 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/** 探测本机 dsh 的桥地址：fetch /ext/bridge-config 直到成功。 */
async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) return body.wsUrl
    } catch {
      // 该端口没有 dsh 或未挂桥：试下一个。
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

const STORAGE_KEY = 'dshSettings'
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'
const TAB_AUTHORIZATION_STORAGE_KEY = 'dshTabAuthorization'
type StoredTabAuthorization = { groupIds: number[] }

type StoredTabAffinity =
  | { controlledTabId: number; keptActiveTabId?: number }
  | { lost: true }

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
let rpc: ReturnType<typeof createRpc> | null = null
const panelPorts = new Set<chrome.runtime.Port>()
const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
/**
 * Eager connect: the extension claims the bridge as soon as the service worker
 * loads (no side panel required) and keeps it up with automatic reconnect. The
 * keepalive alarm re-arms the worker so a sleeping service worker reconnects.
 * A connection is only given up when another owner replaces it (close code
 * 4000), which is terminal and not fought.
 */
const EAGER_BRIDGE = true
/** Invalidates an asynchronous discovery attempt when its panel lease ends. */
let bridgeStartRevision = 0
const interactionResponses = new InteractionResponseRouter()
const transientEvents = new TransientEventCache()
const tabAffinity = new TabAffinityController()
const tabAuthorization = new TabAuthorizationController()
const focusedWindow = new FocusedWindowTracker()
const recentSession = new RecentSessionTracker({
  read: async () => (await chrome.storage.session.get(RECENT_SESSION_STORAGE_KEY))[RECENT_SESSION_STORAGE_KEY],
  write: async (sessionId) => {
    await chrome.storage.session.set({ [RECENT_SESSION_STORAGE_KEY]: sessionId })
  },
})
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/** Stable per-install id reported in `hello` (persisted in chrome.storage.local). */
const INSTANCE_ID_STORAGE_KEY = 'dshInstanceId'
let instanceId = ''
const instanceIdReady = loadInstanceId()
async function loadInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get(INSTANCE_ID_STORAGE_KEY)
  const existing = stored[INSTANCE_ID_STORAGE_KEY]
  if (typeof existing === 'string' && existing.trim() !== '') {
    instanceId = existing
    return existing
  }
  const generated = crypto.randomUUID()
  instanceId = generated
  await chrome.storage.local.set({ [INSTANCE_ID_STORAGE_KEY]: generated })
  return generated
}
/** Human-friendly instance label for the panel's instance list. */
function extensionLabel(): string {
  try {
    const manifest = (chrome.runtime as { getManifest?: (() => { name?: string }) | undefined }).getManifest?.()
    return manifest?.name ?? 'Browser'
  } catch {
    return 'Browser'
  }
}
/** 浏览器内部页面判定：这些不是真实可操作的网页，不能代表业务页标题。 */
function isInternalBrowserPage(url: string): boolean {
  if (url.trim() === '') return false
  return url.startsWith('chrome:')
    || url.startsWith('chrome-extension://')
    || url.startsWith('edge:')
    || url.startsWith('edge-extension://')
    || url.startsWith('about:')
    || url.startsWith('moz-extension://')
}
/** 在给定标签页数组中挑选代表性的 tab：优先第一个真实可操作网页（http/https 且标题非空、非浏览器内部页），
 * 再沿用现有逻辑（当前活动且未固定 → 第一个未固定 → 第一个），便于多实例用各自业务页标题区分。 */
function pickRepresentativeTab(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab | undefined {
  if (tabs.length === 0) return undefined
  const realPage = tabs.find((tab) => {
    const url = tab.url ?? ''
    return !isInternalBrowserPage(url) && isTargetableHttpUrl(url) && (tab.title ?? '').trim() !== ''
  })
  if (realPage !== undefined) return realPage
  const active = tabs.find((tab) => tab.active && !tab.pinned)
  if (active !== undefined) return active
  const unpinned = tabs.find((tab) => !tab.pinned)
  if (unpinned !== undefined) return unpinned
  return tabs[0]
}
/** 用扩展名 + 代表性标签页标题（缺省时退回标签页数量）拼出实例 label，便于多实例间区分。 */
function buildInstanceLabel(tabTitle: string | undefined, tabCount: number): string {
  const base = extensionLabel()
  const title = tabTitle?.trim() ?? ''
  if (title !== '') return `${base} · ${title}`
  const locale = getUiLocale()
  const suffix = locale === 'zh'
    ? `${tabCount} 个标签页`
    : tabCount === 1 ? '1 tab' : `${tabCount} tabs`
  return `${base} · ${suffix}`
}
/** 连接时基于当前代表标签页标题生成实例 label 与 tab 数（随 hello 上报，每次连接/重连刷新）。 */
async function resolveInstanceLabel(): Promise<{ label: string; tabCount: number }> {
  try {
    const tabs = await chrome.tabs.query({})
    const representative = pickRepresentativeTab(tabs)
    return { label: buildInstanceLabel(representative?.title, tabs.length), tabCount: tabs.length }
  } catch {
    // tabs 查询失败时退化为纯扩展名，不影响后续连接。
    return { label: extensionLabel(), tabCount: 0 }
  }
}
/** Latest `instances` frame for panel replays after a reconnect. */
let lastInstances: Extract<ServerFrame, { t: 'instances' }> | null = null
/** Tool calls that can still be withdrawn by a bridge `tool.cancel` frame. */
const activeToolCalls = new Map<string, AbortController>()
let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()
/** 最近一次解析出的 bridge URL（自动探测或手动配置）。用于识别 DSH 自身页面。 */
let lastResolvedBridgeUrl: string | undefined
/** The next prompt waits until an accepted follow has refreshed dsh context. */
let followedPageRefresh: Promise<void> = Promise.resolve()
let activeFollowRefresh: AbortController | null = null
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000

class TabAffinityRebindError extends Error {
  constructor(readonly code: 'no-active-tab' | 'timeout' | 'cancelled', message: string) {
    super(message)
    this.name = 'TabAffinityRebindError'
  }
}

function rebindAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new TabAffinityRebindError('cancelled', getUiLocale() === 'zh' ? '标签页绑定已取消' : 'Tab binding was cancelled')
}

function throwIfRebindAborted(signal: AbortSignal): void {
  if (signal.aborted) throw rebindAbortReason(signal)
}

/** Reject promptly on cancellation while safely consuming a late Chrome promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rebindAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(rebindAbortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(rebindAbortReason(signal))
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const loaded = normalizeSettings({ ...SETTINGS_DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) })
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
    await chrome.storage.local.set({ [STORAGE_KEY]: loaded })
  }
  return loaded
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  settings = normalizeSettings({ ...settings, ...next })
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
  broadcastSettings()
  void syncDebuggerHold()
}

function normalizeSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'auto' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : candidate.sharePageContent === 'ask' ? 'ask' : 'auto'
  return {
    ...candidate,
    sharePageContent,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    autoResumeSession: candidate.autoResumeSession !== false,
    controlEnabled: candidate.controlEnabled !== false,
  }
}

/** Settings load is shared by every lazy connection trigger. */
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
})

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

function disarmBridgeKeepalive(): void {
  void Promise.resolve(chrome.alarms.clear(BRIDGE_KEEPALIVE_ALARM)).catch(() => {})
}

function broadcastStatus(): void {
  const payload = { type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastTabAffinity(): void {
  const payload = { type: 'tab-affinity', state: tabAffinity.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* port already closed */ }
  }
}

function broadcastInstances(frame: Extract<ServerFrame, { t: 'instances' }>): void {
  lastInstances = frame
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'instances', instances: frame.instances, selected: frame.selected }) } catch { /* port already closed */ }
  }
}

function broadcastApprovalResolved(id: string): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* port already closed */ }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: 'approval.request', request })
      delivered = true
    } catch { /* port already closed */ }
  }
  return delivered
}

function notifyApproval(request: ApprovalRequest, _windowId: number): void {
  if (!settings.approvalNotifications) return
  const copy = getUiLocale() === 'zh'
    ? {
        title: '浏览器操作等待确认',
        message: '点击通知打开 dsh 浏览器助手，并在 60 秒内确认或拒绝。',
      }
    : {
        title: 'Browser action awaiting approval',
        message: 'Click to open dsh Browser Assistant, then allow or deny within 60 seconds.',
      }
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: copy.title,
    message: copy.message,
    requireInteraction: true,
  })).catch(() => {})
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: broadcastApprovalResolved,
})

function responseMessages(): { unavailable: string; timeout: string; duplicate: string; disconnected: string } {
  return getUiLocale() === 'zh'
    ? {
        unavailable: '未连接 dsh，无法提交回答',
        timeout: '提交回答超时，请重试',
        duplicate: '回答请求编号重复，请重试',
        disconnected: 'dsh 连接已断开，请重新连接后再试',
      }
    : {
        unavailable: 'dsh is not connected, so the answer could not be sent',
        timeout: 'Sending the answer timed out. Try again.',
        duplicate: 'The answer request ID was duplicated. Try again.',
        disconnected: 'The dsh connection was lost. Reconnect and try again.',
      }
}

function cancelPendingApprovals(): void {
  approvals.cancelAll()
}

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function storedAffinity(): StoredTabAffinity | null {
  const state = tabAffinity.snapshot()
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null
        ? { keptActiveTabId: state.active.tabId }
        : {}),
    }
  }
  return state.status === 'lost' ? { lost: true } : null
}

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const tabs = chrome.tabs.query(query)
    const [tab] = signal === undefined ? await tabs : await abortable(tabs, signal)
    if (signal !== undefined) throwIfRebindAborted(signal)
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    if (signal !== undefined) throwIfRebindAborted(signal)
    return tab
  } catch {
    if (signal !== undefined && signal.aborted) throw rebindAbortReason(signal)
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  // 跟随页面的绑定机制已废弃：不再从会话存储恢复受控 tab / lost 状态。affinity 保持
  // unbound，面板也不会因此弹出「跟随当前页」提示；浏览器操作只按授权组驱动。
  await syncActiveTab()
  persistTabAffinity()
  broadcastTabAffinity()
}

const affinityReady = restoreTabAffinity()

// ---- Tab authorization (DSH- 授权组) ----
let lastPersistedAuthorization: string | undefined
let authorizationPersistence = Promise.resolve()

function persistTabAuthorization(): void {
  const groups = tabAuthorization.snapshot().groups
  const serialized = JSON.stringify(groups.map((g) => g.groupId))
  if (serialized === lastPersistedAuthorization) return
  lastPersistedAuthorization = serialized
  authorizationPersistence = authorizationPersistence.catch(() => {}).then(async () => {
    if (groups.length === 0) {
      await chrome.storage.session.remove(TAB_AUTHORIZATION_STORAGE_KEY)
    } else {
      await chrome.storage.session.set({ [TAB_AUTHORIZATION_STORAGE_KEY]: { groupIds: groups.map((g) => g.groupId) } })
    }
  }).catch(() => {
    if (lastPersistedAuthorization === serialized) lastPersistedAuthorization = undefined
  })
}

function broadcastTabAuthorization(): void {
  const payload = { type: 'tab-authorization', state: tabAuthorization.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port closed */ }
  }
}

function broadcastSettings(): void {
  const payload = { type: 'settings', settings }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port closed */ }
  }
}

/** 保持「正在调试此浏览器」提示条常驻：控制开启时对 target tab 持久 attach，否则释放全部。
 *  调用方需容忍 hold 的 attach 失败（DevTools 占用/受保护页）：失败仅意味着无法常驻。 */
async function syncDebuggerHold(): Promise<void> {
  if (!settings.controlEnabled) {
    await debuggerSession.releaseAllHolds()
    return
  }
  const targetId = tabAuthorization.snapshot().targetTabId
  if (targetId === null) {
    await debuggerSession.releaseAllHolds()
    return
  }
  for (const held of debuggerSession.heldTabs()) {
    if (held !== targetId) await debuggerSession.releaseHold(held).catch(() => {})
  }
  await debuggerSession.hold(targetId).catch(() => {})
}

/** Re-enumerate live group membership so the authorized set stays current (new drags / AI new tabs). */
async function refreshAuthorizedTabs(groupId?: number): Promise<void> {
  const groups = groupId === undefined
    ? tabAuthorization.snapshot().groups
    : tabAuthorization.snapshot().groups.filter((g) => g.groupId === groupId)
  for (const g of groups) {
    try {
      const exists = await chrome.tabGroups.get(g.groupId).catch(() => null)
      if (exists === null) {
        tabAuthorization.revokeGroup(g.groupId)
        continue
      }
      const tabs = await chrome.tabs.query({ groupId: g.groupId }).catch(() => [])
      const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
      tabAuthorization.addTabsToGroup(g.groupId, ids)
    } catch { /* skip */ }
  }
  persistTabAuthorization()
  broadcastTabAuthorization()
}

async function restoreTabAuthorization(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(TAB_AUTHORIZATION_STORAGE_KEY)
    const candidate = stored[TAB_AUTHORIZATION_STORAGE_KEY] as Partial<StoredTabAuthorization> | undefined
    if (candidate && Array.isArray(candidate.groupIds)) {
      for (const groupId of candidate.groupIds) {
        try {
          const tabs = await chrome.tabs.query({ groupId }).catch(() => [])
          const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
          if (ids.length > 0) tabAuthorization.authorizeGroup(groupId, '', ids)
        } catch { /* skip missing group */ }
      }
    }
  } catch { /* best-effort */ }
  persistTabAuthorization()
  broadcastTabAuthorization()
}

const authorizationReady = restoreTabAuthorization()

/** Resolve the AI's current authorized target tab (no handoff; works on background tabs). */
async function resolveAuthorizedTab(call?: ToolCall): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'windowId'> | ToolAnswer> {
  await authorizationReady
  // Per-command tabId targeting (no separate browser_tab_switch): when the model
  // passes an authorized tabId, make it the current target before resolving.
  const sessionId = call?.sessionId ?? '_default'
  const requestedTabId = Number((call?.args as { tabId?: unknown } | undefined)?.tabId)
  if (Number.isInteger(requestedTabId) && tabAuthorization.isAuthorizedTabForSession(requestedTabId, sessionId)) {
    const t = await chrome.tabs.get(requestedTabId).catch(() => null)
    tabAuthorization.setTarget(requestedTabId, { title: t?.title ?? '', url: t?.url ?? '' })
    broadcastTabAuthorization()
    await syncDebuggerHold()
  }
  const tabId = tabAuthorization.resolveTargetForSession(sessionId)
  if (tabId === null) return affinityFailure('missing')
  try {
    const tab = await chrome.tabs.get(tabId)
    const summary = summarizeTab(tab)
    if (summary === null) return affinityFailure('missing')
    tabAuthorization.setTarget(tabId, { title: summary.title, url: summary.url })
    broadcastTabAuthorization()
    await syncDebuggerHold()
    return tab
  } catch {
    tabAuthorization.removeTab(tabId)
    persistTabAuthorization()
    broadcastTabAuthorization()
    await syncDebuggerHold()
    return affinityFailure('lost')
  }
}

/** 跟随页面的绑定能力已废弃：浏览器操作只按授权组 / 冷启动自建组驱动，不再把某个
 * tab 当作「要跟随的当前页」。返回 true 让 session.prompt 照常放行。 */
async function ensureInitialTabBinding(): Promise<boolean> {
  await affinityReady
  return true
}

function affinityFailure(kind: 'lost' | 'missing'): ToolAnswer {
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Select the current page in the side panel before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** 无授权组时的引导错误：绝不把当前活动页复用/自建/导航为受控目标，指引 AI 先打开一个目标页（browser_navigate / browser_new_tab）再操作。 */
function noAuthGroupError(): ToolAnswer {
  return { ok: false, error: { code: 'no-active-tab', message: 'No authorized group. Open a target page first with browser_navigate or browser_new_tab (a real URL), or authorize a group in the side panel.' } }
}

/** 解析为不含 scheme 的 "host:port" 标识；非 http(s)/ws(s) 返回 null。 */
function httpOriginKey(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    return u.host
  } catch {
    return null
  }
}

/** 把回环地址的常见写法归一（localhost / 127.0.0.1 / [::1]），避免同一 dsh 实例因主机写法不同被误判为第三方页。 */
function canonicalOriginKey(originKey: string): string {
  try {
    const u = new URL(`http://${originKey}/`)
    const host = u.hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
    const port = u.port
    const hostKey = loopback ? '127.0.0.1' : host
    return port !== '' ? `${hostKey}:${port}` : hostKey
  } catch {
    return originKey.toLowerCase()
  }
}

/** DSH 自身页面判定：扩展页 / chrome 原生页 / dsh-web UI。 */
function isDshOwnPage(url: string): boolean {
  if (url === '') return false
  // 扩展后台页、侧边栏、popup 等 chrome-extension:// 页面不是目标 Web 页。
  if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://') || url.startsWith('edge-extension://')) return true
  // chrome:// / edge:// / about: 等浏览器内部页同样不可作为受控目标。
  if (url.startsWith('chrome:') || url.startsWith('edge:') || url.startsWith('about:')) return true
  // dsh-web 托管在 bridge 对应的同源 host:port，所以只用 bridge URL 的 origin
  // 判定；用户另开的 localhost:8080 等本地开发服务器不会被误判。
  const originKey = httpOriginKey(url)
  if (originKey === null) return false
  const bridgeKey = httpOriginKey(lastResolvedBridgeUrl ?? '')
  if (bridgeKey === null) return false
  return canonicalOriginKey(originKey) === canonicalOriginKey(bridgeKey)
}

/** 是否为真实可操作的 http(s) URL（可用于 browser_new_tab 冷启动建组）。 */
function isTargetableHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Resolve one stable tool tab. 仅用于「已废弃」的跟随页面（keep-follow）刷新快照路径，
 * 不再作为冷启动自建目标：无授权组时 routeToolCall 已不经过这里，而是直接返回
 * noAuthGroupError 引导 AI 走 browser_new_tab。若当前活动页是 DSH 自身页（dsh-web /
 * 扩展页），则判定为无可用目标。 */
async function resolveToolTab(): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'windowId'> | ToolAnswer> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab === undefined || tab.id === undefined) return affinityFailure('missing')
    if (summarizeTab(tab) === null) return affinityFailure('missing')
    if (isDshOwnPage(tab.url ?? '')) return affinityFailure('missing')
    return tab
  } catch {
    return affinityFailure('missing')
  }
}

async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  sessionId?: string,
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (actionCoveredByTrustedOrigins(
    prompt,
    sessionTrustedActionOrigins,
    settings.trustedActionOrigins,
  )) {
    return 'approved'
  }
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  // Retain wire compatibility with panels from the previous build. The new UI
  // manages permanent trust explicitly in Settings instead of offering it in
  // the action dialog.
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/** Capture the newly controlled tab and seed it into this session's next Agent step. */
async function refreshFollowedPage(sessionId: string, tabId: number): Promise<void> {
  activeFollowRefresh?.abort()
  const controller = new AbortController()
  activeFollowRefresh = controller
  try {
    const target = await resolveToolTab()
    if ('ok' in target || target.id !== tabId || controller.signal.aborted) return
    const budget = caps === null
      ? undefined
      : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
    const answer = await dispatchToolCall(
      { id: crypto.randomUUID(), name: 'browser_snapshot', args: {} },
      settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, sessionId),
      controller.signal,
      target,
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id),
    )
    if (!answer.ok || controller.signal.aborted || !tabAffinity.allowsTarget(tabId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
  } finally {
    if (activeFollowRefresh === controller) activeFollowRefresh = null
  }
}

async function resolveTabAffinityResponse(response: {
  revision: number
  decision: TabAffinityDecision
  sessionId: unknown
}): Promise<void> {
  await affinityReady
  await syncActiveTab()
  const accepted = tabAffinity.decide(response.decision, response.revision)
  const controlled = accepted && response.decision === 'follow'
    ? tabAffinity.snapshot().controlled
    : null
  if (controlled !== null) resetTabSnapshot(controlled.tabId)
  if (accepted) persistTabAffinity()
  broadcastTabAffinity()
  if (controlled !== null && typeof response.sessionId === 'string' && response.sessionId.trim() !== '') {
    await refreshFollowedPage(response.sessionId, controlled.tabId)
  }
}

/** Move browser control to the current tab only after a fresh, valid query. */
async function rebindTabAffinityToActive(signal: AbortSignal): Promise<void> {
  await abortable(affinityReady, signal)
  const tab = await syncActiveTab(undefined, signal)
  throwIfRebindAborted(signal)
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new TabAffinityRebindError('no-active-tab', getUiLocale() === 'zh'
      ? '无法确定当前标签页，原会话和标签页绑定保持不变'
      : 'The current tab could not be determined; the existing session and tab binding were left unchanged')
  }

  const previousControlledTabId = tabAffinity.snapshot().controlled?.tabId
  activeFollowRefresh?.abort()
  cancelAllToolCalls()
  cancelPendingApprovals()
  tabAffinity.rebindActive(summary)
  if (previousControlledTabId !== undefined && previousControlledTabId !== summary.tabId) {
    resetTabSnapshot(previousControlledTabId)
  }
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
}

/** 把协商的快照预算下发到受控页（尚未绑定时使用活动页）。 */
async function pushBudgetToControlledTab(negotiated: BridgeCaps): Promise<void> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget()
  const tabId = resolution.kind === 'target'
    ? resolution.tab.tabId
    : resolution.kind === 'initial'
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
      : undefined
  if (tabId === undefined) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // 页面尚未注入 content script：下一次快照仍用默认预算，可接受。
  }
}

/** Bound on one screenshot's debugger round-trips so a hung renderer cannot stall a call forever. */
const SCREENSHOT_TIMEOUT_MS = 15_000

/** Reject after `ms` without abandoning the underlying promise. */
async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 冷启动建组：无授权组时，为「带目标 URL 的浏览器操作」自动新开一个标签页并建成 DSH- 授权组。
 * 只对新建的 tab 建组授权，绝不触碰当前活动页；dsh 自身页（dsh-web / 扩展页）不是合法目标。
 * @returns 成功时返回新开的 tab 与其 groupId；否则返回 ToolAnswer 错误。
 */
async function openColdStartAuthorizedTab(url: string, ownerSessionId: string | null = '_default', name?: string): Promise<{ tab: chrome.tabs.Tab; groupId: number } | ToolAnswer> {
  // dsh 自身页（dsh-web / 扩展页）绝不能成为受控目标。
  if (isDshOwnPage(url)) {
    return { ok: false, error: { code: 'no-active-tab', message: 'The target URL is a dsh page and cannot be an authorized target. Open a real third-party URL instead.' } }
  }
  if (!isTargetableHttpUrl(url)) {
    return { ok: false, error: { code: 'no-active-tab', message: 'Open a real http(s) URL to start a new authorized target.' } }
  }
  if (!tabAuthorization.mayOpenTab()) {
    return { ok: false, error: { code: 'action-failed', message: 'Open-tab policy is "ask"; switch it to allow in the panel, or allow once here.' } }
  }
  const tab = await chrome.tabs.create({ url, active: false }).catch(() => null)
  if (tab === null || tab.id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'Could not open a new tab.' } }
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] }).catch(() => -1)
  if (groupId < 0) {
    return { ok: false, error: { code: 'action-failed', message: 'Could not group the new tab into a DSH- group.' } }
  }
  const shown = normalizeGroupTitle(name && name.trim() !== '' ? name : 'AI')
  await chrome.tabGroups.update(groupId, { title: shown }).catch(() => {})
  tabAuthorization.authorizeGroup(groupId, shown, [tab.id], ownerSessionId)
  tabAuthorization.setTarget(tab.id, { title: tab.title ?? '', url: tab.url ?? '' })
  persistTabAuthorization()
  broadcastTabAuthorization()
  void syncDebuggerHold()
  return { tab, groupId }
}

/**
 * 冷启动导航：无授权组时，带目标 URL 的 browser_navigate 自动新开一个标签页打开该 URL，
 * 并把它建成 DSH- 授权组后直接返回成功（新 tab 已被授权，可直接被后续 browser_* 使用）。
 * 绝不触碰当前活动页，也绝不对 dsh 页建组。
 */
async function coldStartNavigate(call: ToolCall): Promise<ToolAnswer> {
  await authorizationReady
  const url = typeof (call.args as { url?: unknown })?.url === 'string'
    ? (call.args as { url?: unknown }).url as string
    : undefined
  if (url === undefined) {
    return noAuthGroupError()
  }
  const opened = await openColdStartAuthorizedTab(url, call.sessionId ?? '_default')
  if ('ok' in opened) return opened
  return {
    ok: true,
    result: {
      text: `Opened ${url} in a new authorized tab (id ${opened.tab.id}) and navigated it. Call browser_snapshot again after the page loads.`,
    },
  }
}

/** Run the authorization-level browser tools (list/switch/new tab) without content-script dispatch. */
async function runBrowserControlTool(call: ToolCall): Promise<ToolAnswer> {
  await authorizationReady
  if (call.name === 'browser_tab_list') {
    const sessionId = call.sessionId ?? '_default'
    const groups = tabAuthorization.snapshot().groups.filter((g) => g.ownerSessionId === sessionId)
    const lines: string[] = []
    for (const g of groups) {
      for (const tabId of g.tabIds) {
        try {
          const tab = await chrome.tabs.get(tabId)
          lines.push(`[tabId ${tabId}] ${tab.title || '(untitled)'} — ${tab.url || ''}`)
        } catch { /* tab closed */ }
      }
    }
    return { ok: true, result: { text: lines.join('\n') || 'No authorized tabs yet.' } }
  }
  if (call.name === 'browser_close_tab') {
    const tabId = Number((call.args as { tabId?: unknown })?.tabId)
    if (!Number.isInteger(tabId)) {
      return { ok: false, error: { code: 'bad-args', message: 'browser_close_tab requires a numeric tabId.' } }
    }
    if (!tabAuthorization.isAuthorizedTabForSession(tabId, call.sessionId ?? '_default')) {
      return { ok: false, error: { code: 'no-active-tab', message: 'The tab is not authorized for this agent. Use browser_tab_list first.' } }
    }
    await chrome.tabs.remove(tabId).catch(() => {})
    tabAuthorization.removeTab(tabId)
    persistTabAuthorization()
    broadcastTabAuthorization()
    await syncDebuggerHold()
    return { ok: true, result: { text: `Closed tab ${tabId}.` } }
  }
  if (call.name === 'browser_new_tab') {
    const url = typeof (call.args as { url?: unknown })?.url === 'string' ? (call.args as { url?: unknown }).url as string : undefined
    const name = typeof (call.args as { name?: unknown })?.name === 'string' ? (call.args as { name?: unknown }).name as string : undefined
    const sessionId = call.sessionId ?? '_default'
    const myGroupIds = tabAuthorization.groupsForSession(sessionId)
    // dsh 自身页（dsh-web / 扩展页）绝不能成为受控目标：无论冷启动还是已有授权组下，
    // browser_new_tab 都不把 dsh 页建成授权组，只应打开真实第三方页。
    if (url !== undefined && isDshOwnPage(url)) {
      return { ok: false, error: { code: 'no-active-tab', message: 'The target URL is a dsh page and cannot be an authorized target. Open a real third-party URL instead.' } }
    }
    if (myGroupIds.length === 0) {
      // 冷启动建组：该 agent 还没有自己的组，仅当明确打开真实 http(s) 目标时才建组并归属本 agent。
      const hasRealUrl = url !== undefined && isTargetableHttpUrl(url)
      if (!hasRealUrl) {
        return { ok: false, error: { code: 'no-active-tab', message: 'No authorized group for this agent. Open a real URL, or authorize a group in the panel first.' } }
      }
      const opened = await openColdStartAuthorizedTab(url, sessionId, name)
      if ('ok' in opened) return opened
      return { ok: true, result: { text: `Opened a new tab (id ${opened.tab.id}) in a new DSH- group.` } }
    }
    if (!tabAuthorization.mayOpenTab()) {
      return { ok: false, error: { code: 'action-failed', message: 'Open-tab policy is "ask"; switch it to allow in the panel, or allow once here.' } }
    }
    // 每个 agent 只用自己的组；组满 MAX_GROUP_TABS 时要求先关闭/复用，避免页面堆积与争用。
    const groupId = myGroupIds[myGroupIds.length - 1]
    const group = tabAuthorization.snapshot().groups.find((g) => g.groupId === groupId)
    if (group !== undefined && group.tabIds.length >= MAX_GROUP_TABS) {
      return { ok: false, error: { code: 'action-failed', message: `Your group already has ${MAX_GROUP_TABS} tabs (the per-agent maximum). Close a tab with browser_close_tab or reuse an existing one first.` } }
    }
    const tab = await chrome.tabs.create({ url: url || 'about:blank', active: false }).catch(() => null)
    if (tab && tab.id !== undefined) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId }).catch(() => {})
      const added = tabAuthorization.addTabsToGroup(groupId, [tab.id])
      if (!added) {
        await chrome.tabs.remove(tab.id).catch(() => {})
        return { ok: false, error: { code: 'action-failed', message: `Your group is full (${MAX_GROUP_TABS} max). Close or reuse a tab first.` } }
      }
      tabAuthorization.setTarget(tab.id, { title: tab.title ?? '', url: tab.url ?? '' })
      persistTabAuthorization()
      broadcastTabAuthorization()
      return { ok: true, result: { text: `Opened a new tab (id ${tab.id}) in your group ${groupId}.` } }
    }
    return { ok: false, error: { code: 'action-failed', message: 'Could not open a new tab.' } }
  }
  if (call.name === 'browser_screenshot') {
    // Page content sharing off blocks every page-content read, screenshots included.
    if (settings.sharePageContent === 'off') {
      return { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' } }
    }
    if (tabAuthorization.snapshot().groups.length === 0) return noAuthGroupError()
    const target = await resolveAuthorizedTab(call)
    if ('ok' in target) return target
    const tabId = target.id
    if (tabId === undefined) {
      return { ok: false, error: { code: 'action-failed', message: 'Screenshot capture failed: the controlled tab has no id.' } }
    }
    // captureVisibleTab only captures the window's visible active tab, so it
    // cannot hit a background tab the model targeted. The chrome.debugger
    // transport captures the exact tab regardless of what is on screen and
    // reports failures (e.g. "Another debugger is already attached") as errors.
    // It shares one reference-counted debugger session with CDP pointer input.
    try {
      await debuggerSession.acquire(tabId)
      await withTimeout(
        debuggerSession.sendCommand(tabId, 'Page.enable'),
        SCREENSHOT_TIMEOUT_MS,
        'Enabling the page domain timed out',
      )
      const capture = await withTimeout(
        debuggerSession.sendCommand(tabId, 'Page.captureScreenshot', { format: 'png' }),
        SCREENSHOT_TIMEOUT_MS,
        'Capturing the screenshot timed out',
      )
      const data = typeof capture === 'object' && capture !== null
        ? (capture as { data?: unknown }).data
        : undefined
      if (typeof data !== 'string' || data === '') {
        return { ok: false, error: { code: 'content-unavailable', message: 'Screenshot capture returned no image data.' } }
      }
      const title = (await chrome.tabs.get(tabId).catch(() => null))?.title ?? ''
      // Derive the model-visible size (and the raw PNG size) for the screenshot
      // result metadata. Locating is DOM-driven, so no per-tab coordinate basis
      // is recorded and no screenshot-pixel conversion is performed.
      const originalDimensions = pngSizeFromBase64(data)
      const imageSize = originalDimensions === undefined ? undefined : modelVisibleImageSize(originalDimensions)
      return {
        ok: true,
        result: {
          text: title === '' ? 'Captured the controlled tab.' : `Captured ${title}.`,
          image: { mediaType: 'image/png', data },
          ...imageSize === undefined ? {} : { imageSize },
          ...originalDimensions === undefined ? {} : { originalDimensions },
        },
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'action-failed', message: `Screenshot capture failed: ${message}` } }
    } finally {
      // Detach only our own session so a failed attach cannot tear down a
      // debugger owned by someone else (e.g. an open DevTools window).
      await debuggerSession.release(tabId)
    }
  }
  return { ok: false, error: { code: 'action-failed', message: 'Unknown browser control tool.' } }
}

/** Route one tool.call frame to the user-approved controlled tab. */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  // 控制开关：关闭时所有 browser_* 工具 fail-closed，禁止 AI 操作页面。
  if (!settings.controlEnabled) {
    bridge.send({
      t: 'tool.result',
      id: call.id,
      ok: false,
      error: {
        code: 'control-disabled',
        message: getUiLocale() === 'zh'
          ? '浏览器控制已关闭，请在扩展面板开启'
          : 'Browser control is off. Enable it in the extension panel.',
      },
    })
    return
  }
  if (call.name === 'browser_tab_list' || call.name === 'browser_new_tab' || call.name === 'browser_screenshot' || call.name === 'browser_close_tab') {
    const controller = new AbortController()
    activeToolCalls.set(call.id, controller)
    const timer = setTimeout(() => { controller.abort() }, 90_000)
    void runBrowserControlTool(call).then(
      (answer) => {
        if (controller.signal.aborted || bridge === null) return
        if (answer.ok) bridge.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
        else bridge.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      },
      (error: unknown) => {
        if (controller.signal.aborted || bridge === null) return
        bridge.send({ t: 'tool.result', id: call.id, ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
      },
    ).finally(() => { clearTimeout(timer); activeToolCalls.delete(call.id) })
    return
  }
  recentSession.remember(call.sessionId)
  activeToolCalls.get(call.id)?.abort()
  const controller = new AbortController()
  activeToolCalls.set(call.id, controller)
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => { controller.abort() }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  // 无授权组时，绝不把当前活动页复用/导航/建组。带目标 URL 的 browser_navigate 走冷启动自建
  //（自动新开 tab 建组授权）；其余 browser_* 工具在下方直接返回「请先打开目标页」引导，避免劫持用户当前页（尤其 dsh-web）。
  const hasAuthGroups = tabAuthorization.snapshot().groups.length > 0
  const resolveTarget = hasAuthGroups
    ? resolveAuthorizedTab(call)
    : call.name === 'browser_navigate'
      ? coldStartNavigate(call)
      : Promise.resolve(noAuthGroupError())
  void resolveTarget.then(async (target) => {
    if ('ok' in target) return target
    // 到达这里说明 hasAuthGroups 为 true，resolveAuthorizedTab() 解析到了受控 tab，
    // 按授权组 dispatch；冷启动导航分支只会返回成功/错误 ToolAnswer，不会走到这里。
    const authorized = tabAuthorization.snapshot().groups.length > 0
    const answer = await dispatchToolCall(
      call,
      authorized ? 'auto' : settings.sharePageContent,
      budget,
      async (prompt) => authorized ? 'approved' : authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId),
      controller.signal,
      target,
      () => target.id !== undefined
        && (!authorized || tabAuthorization.isAuthorizedTabForSession(target.id, call.sessionId ?? '_default')),
    )
    return answer
  }).then(
    (answer) => {
      if (controller.signal.aborted) return
      const socket = bridge
      if (socket === null) return
      if (answer.ok) {
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      if (controller.signal.aborted) return
      bridge?.send({
        t: 'tool.result',
        id: call.id,
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    },
  ).finally(() => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    if (activeToolCalls.get(call.id) === controller) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  activeToolCalls.get(id)?.abort()
}

function cancelAllToolCalls(): void {
  for (const controller of activeToolCalls.values()) controller.abort()
  activeToolCalls.clear()
}

/** (Re)start the bridge with the current settings. 零配置：地址留空时自动探测；回环连接无需 token。 */
async function startBridge(): Promise<void> {
  const revision = ++bridgeStartRevision
  // 确保 instanceId 已从 chrome.storage.local 加载，才可随 hello 上报。
  await instanceIdReady
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge(() => revision === bridgeStartRevision && EAGER_BRIDGE) ?? ''
  }
  // Discovery is asynchronous. A newer settings update may have started while
  // its fetches were in flight (the revision invalidates the stale attempt).
  if (revision !== bridgeStartRevision) return
  if (url === '') {
    bridge?.stop()
    bridge = null
    rpc = null
    broadcastStatus()
    return
  }
  // 手动填的地址常只有主机部分（如 ws://127.0.0.1:3080）；桥路径是协议
  // 常量，缺省时自动补全，避免连到根路径失败。
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
  } catch {
    // 非法 URL 原样交给 WebSocket 构造函数报错。
  }
  // 记录解析后的 bridge URL，供 DSH 自身页判定使用。
  lastResolvedBridgeUrl = url
  if (bridge === null) {
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== 'connected') {
          cancelAllToolCalls()
          interactionResponses.failAll(responseMessages().disconnected)
          transientEvents.clear()
        }
        broadcastStatus()
        if (state === 'stopped' && !EAGER_BRIDGE && panelPorts.size === 0) disarmBridgeKeepalive()
      },
      onFrame: (frame) => {
        if (frame.t === 'event') {
          recentSession.noteActivity(sessionIdFromFrame(frame))
          transientEvents.ingest(frame)
          broadcastEvent(frame)
        }
        else if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
        else if (frame.t === 'respond.result') interactionResponses.route(frame)
        else if (frame.t === 'instances') broadcastInstances(frame)
        // rpc.result is settled by the rpc facade (wrapped below).
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        broadcastStatus()
        void pushBudgetToControlledTab(negotiated)
      },
    }, probeBridge, () => EAGER_BRIDGE)
    bridge = client
    rpc = createRpc(client)
  }
  // 上报本实例的稳定身份，供服务端连接注册表分组/选择。label 用代表性标签页标题，便于多实例间区分。
  if (bridge !== null) {
    bridge.instanceId = instanceId
    const instance = await resolveInstanceLabel()
    bridge.instanceLabel = instance.label
    bridge.instanceTabCount = instance.tabCount
  }
  bridge.start(url, settings.token)
}

/** Gateway RPC with a helpful error when the bridge is down. */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与 token）'
      : 'dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

// ---- Panel ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-panel') return
  const wasIdle = panelPorts.size === 0
  const tabAffinityRebinds = new Map<string, {
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  }>()
  panelPorts.add(port)
  if (wasIdle) armBridgeKeepalive()
  void settingsReady.then(() => {
    if (!panelPorts.has(port)) return
    if (bridge === null || bridge.state === 'stopped') return startBridge()
  })
  try { port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }) } catch { /* port closed */ }
  void affinityReady.then(async () => {
    await syncActiveTab()
    try { port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() }) } catch { /* port closed */ }
  })
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        const refresh = followedPageRefresh
        const prepare = rpcMsg.method === 'session.prompt'
          ? ensureInitialTabBinding().then(async (bound) => {
              await refresh
              return bound
            })
          : Promise.resolve(true)
        void prepare.then(() => gatewayRpc(rpcMsg.method, rpcMsg.payload)).then(
          (result) => {
            try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'rpc.result',
                id: rpcMsg.id,
                ok: false,
                error: { code: 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'respond': {
        const response = message as { id?: unknown; rpcId?: unknown; result?: unknown }
        if (typeof response.id !== 'string' || typeof response.rpcId !== 'string' || !isRespondResult(response.result)) break
        const messages = responseMessages()
        interactionResponses.begin(
          port,
          response.id,
          () => bridge?.send({
            t: 'respond',
            id: response.id as string,
            rpcId: response.rpcId as string,
            result: response.result as RespondResult,
          }) === true,
          messages,
        )
        break
      }
      case 'settings': {
        const settingsMsg = message as { settings: Partial<Settings> }
        void settingsReady.then(async () => {
          const previousConnection = { bridgeUrl: settings.bridgeUrl, token: settings.token }
          await persistSettings(settingsMsg.settings)
          const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
            || settings.token !== previousConnection.token
          // Only a changed bridge address/token must rebuild the socket (eager mode,
          // even with no side panel open), so the next reconnect uses the new values.
          // Every other setting (e.g. the control toggle) keeps the healthy socket
          // untouched — restarting on every panel setting change would drop the
          // bridge mid-automation and destabilize the very control it toggles.
          if (connectionChanged) {
            await startBridge()
            broadcastStatus()
          }
        })
        break
      }
      case 'session.active': {
        const session = message as { sessionId?: unknown }
        recentSession.remember(session.sessionId)
        break
      }
      case 'select.instance': {
        const selection = message as { instanceId?: unknown }
        if (typeof selection.instanceId === 'string' && selection.instanceId.trim() !== '') {
          bridge?.send({ t: 'select.instance', instanceId: selection.instanceId })
        }
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number'
          || (response.decision !== 'keep' && response.decision !== 'follow')) break
        const decision = resolveTabAffinityResponse({
          revision: response.revision,
          decision: response.decision,
          sessionId: response.sessionId,
        })
        if (response.decision === 'follow') followedPageRefresh = decision.catch(() => {})
        void decision.catch(() => {})
        break
      }
      case 'tab-affinity.rebind': {
        const request = message as { id?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        if (tabAffinityRebinds.has(requestId)) break
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(new TabAffinityRebindError('timeout', getUiLocale() === 'zh'
            ? '绑定当前标签页超时，请重试'
            : 'Binding the current tab timed out. Try again.'))
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        tabAffinityRebinds.set(requestId, { controller, timer })
        void rebindTabAffinityToActive(controller.signal).then(
          () => {
            try { port.postMessage({ type: 'tab-affinity.rebind.result', id: requestId, ok: true }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'tab-affinity.rebind.result',
                id: requestId,
                ok: false,
                error: {
                  code: error instanceof TabAffinityRebindError ? error.code : 'no-active-tab',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            } catch { /* port closed */ }
          },
        ).finally(() => {
          const current = tabAffinityRebinds.get(requestId)
          if (current?.controller !== controller) return
          clearTimeout(current.timer)
          tabAffinityRebinds.delete(requestId)
        })
        break
      }
      case 'tab-authorization': {
        const action = (message as { action?: unknown }).action as (TabAuthAction & { tabId?: number; title?: string }) | undefined
        if (!action || typeof action.kind !== 'string') break
        const handle = async (): Promise<void> => {
          if (action.kind === 'authorize') {
            const tabId = action.tabId
            if (typeof tabId !== 'number') return
            const tab = await chrome.tabs.get(tabId).catch(() => null)
            if (tab === null) return
            let groupId = tab.groupId
            if (groupId === undefined || groupId < 0) {
              groupId = await chrome.tabs.group({ tabIds: [tabId] }).catch(() => -1)
              if (groupId < 0) return
              await chrome.tabGroups.update(groupId, { title: normalizeGroupTitle(action.title ?? '') }).catch(() => {})
            }
            const tabs = await chrome.tabs.query({ groupId }).catch(() => [])
            const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
            if (tabAuthorization.isAuthorizedGroup(groupId)) tabAuthorization.addTabsToGroup(groupId, ids)
            else tabAuthorization.authorizeGroup(groupId, normalizeGroupTitle(action.title ?? ''), ids)
            await refreshAuthorizedTabs()
          } else if (action.kind === 'revoke') {
            tabAuthorization.revokeGroup(action.groupId)
          } else if (action.kind === 'mode') {
            tabAuthorization.setMode(action.mode)
          } else if (action.kind === 'target') {
            tabAuthorization.setTarget(action.tabId)
          }
          persistTabAuthorization()
          broadcastTabAuthorization()
          void syncDebuggerHold()
        }
        void handle().catch(() => {})
        break
      }
      case 'request-status':
        try {
          port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps })
          port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() })
          port.postMessage({ type: 'tab-authorization', state: tabAuthorization.snapshot() })
          if (lastInstances !== null) {
            port.postMessage({ type: 'instances', instances: lastInstances.instances, selected: lastInstances.selected })
          }
          for (const frame of transientEvents.replay()) port.postMessage({ type: 'event', frame })
          approvals.replay((request) => {
            port.postMessage({ type: 'approval.request', request })
            return true
          })
          void recentSession.ready.then(() => {
            try {
              port.postMessage({ type: 'session.resume-hint', sessionId: recentSession.current() })
            } catch { /* port closed */ }
          })
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    for (const operation of tabAffinityRebinds.values()) {
      clearTimeout(operation.timer)
      operation.controller.abort(new TabAffinityRebindError('cancelled', getUiLocale() === 'zh'
        ? '后台连接已断开，标签页绑定已取消'
        : 'The background connection was lost, so tab binding was cancelled'))
    }
    tabAffinityRebinds.clear()
    panelPorts.delete(port)
    interactionResponses.removePort(port)
    if (panelPorts.size === 0) {
      sessionTrustedActionOrigins.clear()
      approvals.notifyPending()
      if (!EAGER_BRIDGE) {
        // Legacy lease model: the bridge is only held while a panel is open.
        bridgeStartRevision += 1
        bridge?.suspendReconnect()
        if (bridge?.state !== 'connected') disarmBridgeKeepalive()
      }
    }
  })
})

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; both panel APIs require
  // the call to remain inside this handler.
  openAssistantPanel(windowId)
})

// ---- CDP pointer input from the content script ----
// The content script computes a humanized pointer plan (curve movement, random
// in-element tap point, random pauses) and hands it to the background, which
// replays it as REAL cursor events via `Input.dispatchMouseEvent`. This is the
// only way the page sees an actual pointer and reacts to `:hover`/tooltips.
// Only the top frame (frameId 0) drives CDP input; subframe coordinates are
// frame-relative and cannot be addressed by a top-level Input dispatch, so a
// subframe request is declined and the content script falls back to synthetic
// events. The pointer plan is replayed to the tab that sent it, reusing the
// same debugger session as screenshots.
if (chrome.runtime.onMessage !== undefined) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: unknown }
    if (msg.type !== 'DSH_INPUT_MOUSE') return
    const payload = message as { steps?: unknown }
    const tabId = sender.tab?.id
    if (tabId === undefined || !Array.isArray(payload.steps) || payload.steps.length === 0) {
      sendResponse({ ok: false, error: 'no-tab' })
      return
    }
    // Only the root frame produces viewport coordinates usable by CDP Input.
    if ((sender as { frameId?: number }).frameId !== 0) {
      sendResponse({ ok: false, error: 'subframe' })
      return
    }
    const steps = payload.steps as MouseStep[]
    // Reply immediately on the same message channel; the CDP replay runs in the
    // worker but must not hold the content script's action hostage on failure.
    void replayMouseSteps(tabId, steps).then(
      () => { sendResponse({ ok: true }) },
      (error: unknown) => {
        const messageText = error instanceof Error ? error.message : String(error)
        sendResponse({ ok: false, error: messageText })
      },
    )
    return true // async response
  })
}

// ---- Tab authorization event wiring ----
chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void authorizationReady.then(async () => {
    if (tab.groupId !== undefined && tab.groupId >= 0 && tabAuthorization.isAuthorizedGroup(tab.groupId)) {
      if (tab.id !== undefined) {
        tabAuthorization.addTabsToGroup(tab.groupId, [tab.id])
        persistTabAuthorization()
        broadcastTabAuthorization()
      }
    } else if (tabAuthorization.isAuthorizedTab(tabId)) {
      await refreshAuthorizedTabs()
    }
  })
})
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.groupId !== undefined && tab.groupId >= 0 && tabAuthorization.isAuthorizedGroup(tab.groupId) && tab.id !== undefined) {
    tabAuthorization.addTabsToGroup(tab.groupId, [tab.id])
    persistTabAuthorization()
    broadcastTabAuthorization()
  }
})
chrome.tabs.onDetached.addListener((tabId) => {
  if (tabAuthorization.isAuthorizedTab(tabId)) {
    tabAuthorization.removeTab(tabId)
    persistTabAuthorization()
    broadcastTabAuthorization()
  }
})
if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
  chrome.tabGroups.onRemoved.addListener((tabGroup) => {
    const groupId = tabGroup.id
    if (tabAuthorization.isAuthorizedGroup(groupId)) {
      tabAuthorization.revokeGroup(groupId)
      persistTabAuthorization()
      broadcastTabAuthorization()
    }
  })
}

// ---- Tab affinity ----

// 用户切换标签页不再触发「是否跟随当前页」提示，也不再暂停浏览器操作；浏览器
// 操作只按授权组 / 冷启动自建组驱动。onActivated 的 affinity 观察已移除。

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void affinityReady.then(() => {
    if (!tabAffinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const controlledReplaced = tabAffinity.snapshot().controlled?.tabId === removedTabId
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    // Only work targeting the replaced controlled page is stale. Replacing a
    // merely visible background-affinity tab must not cancel work on the
    // separately controlled page.
    if (controlledReplaced) {
      activeFollowRefresh?.abort()
      cancelPendingApprovals()
    }
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastTabAffinity()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void affinityReady.then(() => {
    // 组内单个 tab 关闭也必须同步撤销对应授权：即便旧亲和机制（tabAffinity）已
    // 弃用且 `tabAffinity.removeTab` 返回 false，也不能因此跳过授权清理，否则被
    // 关闭的 tab 会残留在授权组里，AI 拿到的授权/信息不准确。授权移除要放在
    // affinity 的提前返回之前，保证一定会执行。
    if (tabAuthorization.isAuthorizedTab(tabId)) {
      tabAuthorization.removeTab(tabId)
      persistTabAuthorization()
      broadcastTabAuthorization()
    }
    if (!tabAffinity.removeTab(tabId)) return
    activeFollowRefresh?.abort()
    cancelPendingApprovals()
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  if (!EAGER_BRIDGE) {
    // Legacy lease model: without a panel there is nothing to keep alive.
    if (panelPorts.size === 0) {
      if (bridge === null || bridge.state !== 'connected') disarmBridgeKeepalive()
      return
    }
  }
  // Eager mode: the keepalive wakes a sleeping/restarted service worker so it
  // reconnects. A `stopped` bridge is only restarted when it was not replaced
  // by another owner (close code 4000) — that situation is terminal and must
  // not be fought in a tight reconnect/evict loop.
  if (bridge === null
    || bridge.state === 'reconnecting'
    || (bridge.state === 'stopped' && bridge.replacedByAnother !== true)) {
    void settingsReady.then(() => startBridge())
  }
})

// ---- Boot ----

interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function openAssistantPanel(windowId?: number): void {
  if (import.meta.env.EXT_TARGET === 'firefox') {
    const sidebar = (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
    if (sidebar === undefined) return
    void Promise.resolve(sidebar.open()).catch(() => {})
    return
  }
  if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).catch(() => {})
}

// Open the side panel when the toolbar icon is clicked.
// Chrome 116+ uses chrome.sidePanel; Firefox has no sidePanel API, so the
// action click opens the sidebar via sidebarAction.open() (user gesture).
if (import.meta.env.EXT_TARGET === 'firefox') {
  chrome.action.onClicked.addListener(() => { openAssistantPanel() })
} else {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
}

// Eager connect: arm the keepalive and claim the bridge as soon as the
// service worker loads, without waiting for a side panel. The keepalive wakes
// the worker on a half-minute cadence so a sleeping service worker reconnects.
armBridgeKeepalive()
void settingsReady.then(() => { startBridge() })
