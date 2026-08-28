/**
 * Side panel controller: a minimal two-button browser-control surface.
 *
 * No conversation UI. The agent conversation is driven by the dsh host
 * (e.g. dsh web); this panel only authorizes the current page into a
 * DSH- group and toggles browser control (which keeps the browser's native
 * "正在调试此浏览器" banner triggered so automation positions stay stable).
 * An approval overlay appears only when a background approval is pending.
 *
 * @module
 */

import './styles.css'
import { getUiLocale } from '../i18n.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { TabAuthSnapshot } from '../background/tab-authorization.ts'
import type { ApprovalRequest, ApprovalDecision } from '../security/approval.ts'
import type { Settings } from '../background/index.ts'

interface StatusMessage { type: 'status'; state: BridgeState }
interface TabAuthMessage { type: 'tab-authorization'; state: TabAuthSnapshot }
interface ApprovalRequestMessage { type: 'approval.request'; request: ApprovalRequest }
interface ApprovalResolvedMessage { type: 'approval.resolved'; id: string }
interface SettingsMessage { type: 'settings'; settings: Settings }
type BackgroundMessage = StatusMessage | TabAuthMessage | ApprovalRequestMessage | ApprovalResolvedMessage | SettingsMessage

const locale = getUiLocale()
const COPY = locale === 'zh' ? {
  title: 'dsh 浏览器控制',
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  stopped: '未连接',
  authorize: '授权当前页面',
  authorizeHint: '把当前页面加入 DSH- 授权组（已有组直接并入，无组则新建）',
  controlOff: '关闭控制',
  controlOn: '开启控制',
  controlHintOn: '控制开启：调试提示条常驻，浏览器自动化落点更稳定',
  controlHintOff: '控制关闭：AI 无法操作页面',
  noGroups: '未授权任何组',
  groups: (n: number) => `已授权 ${n} 个组`,
  operating: (title: string) => `AI 正在操作：${title}`,
  operatingUnknown: 'AI 正在操作受控标签页',
  approval: { eyebrow: '安全检查', request: '请求', origins: '涉及来源', unknownOrigin: '未知来源', deny: '拒绝', allowOnce: '仅允许这一次', alwaysAllowReads: '始终允许读取', trustSession: '本次会话信任此域' },
} : {
  title: 'dsh Browser Controller',
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  stopped: 'Disconnected',
  authorize: 'Authorize current page',
  authorizeHint: 'Add the current page to a DSH- authorized group (join existing or create one)',
  controlOff: 'Turn control off',
  controlOn: 'Turn control on',
  controlHintOn: 'Control on: debug banner stays up so automation positions stay stable',
  controlHintOff: 'Control off: the AI cannot operate the page',
  noGroups: 'No group authorized',
  groups: (n: number) => `${n} group(s) authorized`,
  operating: (title: string) => `AI is operating: ${title}`,
  operatingUnknown: 'AI is operating the controlled tab',
  approval: { eyebrow: 'Security check', request: 'Request', origins: 'Origins involved', unknownOrigin: 'Unknown origin', deny: 'Deny', allowOnce: 'Allow once', alwaysAllowReads: 'Always allow reads', trustSession: 'Trust this domain for this session' },
}

interface State {
  status: BridgeState
  controlEnabled: boolean
  auth: TabAuthSnapshot | null
  approval: ApprovalRequest | null
}

const state: State = { status: 'stopped', controlEnabled: true, auth: null, approval: null }

let port: chrome.runtime.Port | null = null
function attach(next: chrome.runtime.Port): void {
  port = next
  next.onMessage.addListener((message: unknown) => handleMessage(message))
  next.onDisconnect.addListener(() => { if (port === next) port = null; render() })
}
function ensurePort(): void {
  if (port !== null) return
  try {
    attach(chrome.runtime.connect({ name: 'dsh-panel' }))
    send({ type: 'request-status' })
  } catch {
    setTimeout(ensurePort, 150)
  }
}
function send(message: unknown): void {
  const current = port
  if (current !== null) {
    try { current.postMessage(message); return } catch { /* port closed */ }
  }
  setTimeout(() => { if (port === null) ensurePort() }, 150)
}

function handleMessage(message: unknown): void {
  if (typeof message !== 'object' || message === null) return
  const msg = message as BackgroundMessage
  if (msg.type === 'status') {
    state.status = msg.state
  } else if (msg.type === 'tab-authorization') {
    state.auth = msg.state
  } else if (msg.type === 'approval.request') {
    state.approval = msg.request
  } else if (msg.type === 'approval.resolved') {
    if (state.approval?.id === msg.id) state.approval = null
  } else if (msg.type === 'settings') {
    state.controlEnabled = msg.settings.controlEnabled
  } else {
    return
  }
  render()
}

function statusText(): string {
  switch (state.status) {
    case 'connected': return COPY.connected
    case 'connecting': return COPY.connecting
    case 'reconnecting': return COPY.reconnecting
    default: return COPY.stopped
  }
}

function render(): void {
  const app = document.getElementById('app')
  if (app === null) return

  const auth = state.auth
  const groupCount = auth?.groups.length ?? 0
  const target = auth?.target ?? null

  const authLine = groupCount === 0
    ? COPY.noGroups
    : (target !== null && target.title !== '' ? COPY.operating(target.title) : COPY.groups(groupCount))

  const approval = state.approval
  let html = '<header class="topbar"><span class="connection" role="status"><span class="dot ' + state.status + '"></span><span class="connection-label">' + statusText() + '</span></span><span class="title">' + COPY.title + '</span></header>'
  html += '<main class="controls">'
  html += '<section class="card"><div class="card-head"><strong>' + COPY.authorize + '</strong></div><p class="hint">' + COPY.authorizeHint + '</p><button id="authorize" class="primary">' + COPY.authorize + '</button></section>'
  html += '<section class="card"><div class="card-head"><strong>' + (state.controlEnabled ? COPY.controlOff : COPY.controlOn) + '</strong></div><p class="hint">' + (state.controlEnabled ? COPY.controlHintOn : COPY.controlHintOff) + '</p><button id="control" class="' + (state.controlEnabled ? 'danger' : 'primary') + '">' + (state.controlEnabled ? COPY.controlOff : COPY.controlOn) + '</button></section>'
  html += '<p class="auth-line" role="status">' + authLine + '</p>'
  html += '</main>'

  if (approval !== null) {
    html += '<div class="approval-backdrop"><section class="approval-dialog" role="alertdialog" aria-modal="true"><div class="approval-heading"><span class="eyebrow">' + COPY.approval.eyebrow + '</span></div><div class="approval-detail"><span>' + COPY.approval.request + '</span><strong>' + escapeHtml(approval.summary) + '</strong></div>'
    html += '<div class="approval-origins"><span>' + COPY.approval.origins + '</span>' + (approval.origins.length === 0 ? '<code class="unknown">' + COPY.approval.unknownOrigin + '</code>' : approval.origins.map((o) => '<code>' + escapeHtml(o) + '</code>').join('')) + '</div>'
    html += '<div class="approval-actions"><button class="deny" id="approval-deny">' + COPY.approval.deny + '</button><button class="allow" id="approval-allow">' + COPY.approval.allowOnce + '</button>'
    if (approval.kind === 'read') html += '<button class="read-always" id="approval-read">' + COPY.approval.alwaysAllowReads + '</button>'
    if (approval.kind === 'action' && approval.canTrust && approval.origins.length === 1) html += '<button class="session-trust" id="approval-trust">' + COPY.approval.trustSession + '</button>'
    html += '</div></section></div>'
  }

  app.innerHTML = html

  document.getElementById('authorize')?.addEventListener('click', () => void authorizeCurrentPage())
  document.getElementById('control')?.addEventListener('click', () => void toggleControl())
  document.getElementById('approval-deny')?.addEventListener('click', () => void decideApproval('deny'))
  document.getElementById('approval-allow')?.addEventListener('click', () => void decideApproval('allow-once'))
  document.getElementById('approval-read')?.addEventListener('click', () => void decideApproval('always-allow-reads'))
  document.getElementById('approval-trust')?.addEventListener('click', () => void decideApproval('trust-session'))
}

async function authorizeCurrentPage(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
  const tab = tabs[0]
  if (tab?.id === undefined) return
  send({ type: 'tab-authorization', action: { kind: 'authorize', tabId: tab.id, title: tab.title ?? '' } })
}

function toggleControl(): void {
  const next = !state.controlEnabled
  state.controlEnabled = next
  send({ type: 'settings', settings: { controlEnabled: next } })
  render()
}

function decideApproval(decision: ApprovalDecision): void {
  const request = state.approval
  if (request === null) return
  state.approval = null
  send({ type: 'approval.response', id: request.id, decision })
  render()
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch))
}

// Seed controlEnabled from persisted settings, then connect.
void chrome.storage.local.get('dshSettings').then((stored) => {
  const s = (stored.dshSettings as Partial<Settings> | undefined)
  if (typeof s?.controlEnabled === 'boolean') state.controlEnabled = s.controlEnabled
  render()
})

ensurePort()
render()

document.title = COPY.title
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'

