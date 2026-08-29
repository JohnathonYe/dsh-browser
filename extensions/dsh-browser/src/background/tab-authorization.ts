/**
 * 授权组状态机：把 dsh-browser 从「绑定单个受控标签页」升级为「授权一组 Chrome 标签组」。
 *
 * 纯状态机设计（不直接调用 chrome API），由 background/index.ts 提供 Chrome tab/tabGroups 事件
 * 并喂给它，便于独立测试和事件解耦。
 *
 * 语义：
 * - 授权单位是 Chrome 标签组（groupId）。授权后，组内所有 tab 都是 AI 可操作范围。
 * - 授权单个页：若该页已有组则授其组；否则由调用方先建一个新组（chrome.tabs.group），
 *   再把该组作为授权组登记。
 * - 组内新增 tab（用户拖入 / AI 开 tab 归组）自动纳入授权范围。
 * - 支持多组授权，AI 可在多个授权组内切换目标 tab。
 * - 无 handoff：用户切走 / 窗口失焦 / 后台，都不影响组内操作（Chrome 对后台 tab 仍可执行
 *   导航与内容脚本）。目标解析只依赖授权范围，不依赖前台激活状态。
 * - AI 开 Tab 策略：allow（默认）或 ask（每次新开需确认）。
 *
 * @module
 */

export type TabAuthMode = 'allow' | 'ask'

/** DSH 管理的授权组统一命名前缀，便于识别与审计。 */
export const DSH_GROUP_PREFIX = 'DSH-'

/** 把 AI 指定的组名强制归一为 DSH- 前缀（空名回退为 DSH-）。 */
export function normalizeGroupTitle(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return DSH_GROUP_PREFIX
  return trimmed.startsWith(DSH_GROUP_PREFIX) ? trimmed : DSH_GROUP_PREFIX + trimmed
}

export const MAX_GROUP_TABS = 10

export interface AuthorizedGroup {
  groupId: number
  title: string
  tabIds: number[]
  /** sessionId of the agent that owns this group; groups are not shared across agents. */
  ownerSessionId: string | null
}

export interface TabAuthSnapshot {
  revision: number
  mode: TabAuthMode
  groups: AuthorizedGroup[]
  targetTabId: number | null
  targetGroupId: number | null
  /** AI 当前正在操作的目标 tab 详情（供面板显示）。 */
  target: { tabId: number; groupId: number | null; title: string; url: string } | null
}

export type TabAuthAction =
  | { kind: 'authorize'; groupId?: number; title?: string; tabIds?: number[]; tabId?: number }
  | { kind: 'revoke'; groupId: number }
  | { kind: 'mode'; mode: TabAuthMode }
  | { kind: 'target'; tabId: number }

interface GroupRecord {
  groupId: number
  title: string
  tabIds: Set<number>
  ownerSessionId: string | null
}

/** Owns the authorized-group lifecycle for one extension/bridge connection. */
export class TabAuthorizationController {
  private groups = new Map<number, GroupRecord>()
  private tabToGroup = new Map<number, number>()
  private mode: TabAuthMode = 'allow'
  private targetTabId: number | null = null
  private targetGroupId: number | null = null
  private targetMeta: { title: string; url: string } | null = null
  private revision = 0

  snapshot(): TabAuthSnapshot {
    return {
      revision: this.revision,
      mode: this.mode,
      groups: [...this.groups.values()].map((g) => ({
        groupId: g.groupId,
        title: g.title,
        tabIds: [...g.tabIds],
        ownerSessionId: g.ownerSessionId,
      })),
      targetTabId: this.targetTabId,
      targetGroupId: this.targetGroupId,
      target: this.targetTabId === null
        ? null
        : {
            tabId: this.targetTabId,
            groupId: this.targetGroupId,
            title: this.targetMeta?.title ?? '',
            url: this.targetMeta?.url ?? '',
          },
    }
  }

  getMode(): TabAuthMode {
    return this.mode
  }

  setMode(mode: TabAuthMode): boolean {
    if (mode !== 'allow' && mode !== 'ask') return false
    if (this.mode === mode) return false
    this.mode = mode
    this.bump()
    return true
  }

  /** 授权一个（已存在的）组。 */
  authorizeGroup(groupId: number, title = '', tabIds: number[] = [], ownerSessionId: string | null = null): boolean {
    if (this.groups.has(groupId)) return false
    if (tabIds.length > MAX_GROUP_TABS) return false
    const record: GroupRecord = { groupId, title, tabIds: new Set(tabIds), ownerSessionId }
    this.groups.set(groupId, record)
    for (const tabId of tabIds) this.tabToGroup.set(tabId, groupId)
    if (this.targetTabId === null && tabIds.length > 0) {
      this.targetTabId = tabIds[0]
      this.targetGroupId = groupId
    }
    this.bump()
    return true
  }

  /** 授权单个页：调用方确保 groupId 是新建/已存在的组。 */
  authorizeTab(groupId: number, tabId: number, title = '', ownerSessionId: string | null = null): boolean {
    return this.authorizeGroup(groupId, title, [tabId], ownerSessionId)
  }

  /** 取消授权一个组，并把组内 tab 从授权范围移除。 */
  revokeGroup(groupId: number): boolean {
    const record = this.groups.get(groupId)
    if (record === undefined) return false
    this.groups.delete(groupId)
    for (const tabId of record.tabIds) this.tabToGroup.delete(tabId)
    if (this.targetGroupId === groupId) {
      this.targetGroupId = null
      this.targetTabId = null
    }
    this.bump()
    return true
  }

  /** 清空全部授权。 */
  clear(): void {
    if (this.groups.size === 0) return
    this.groups.clear()
    this.tabToGroup.clear()
    this.targetTabId = null
    this.targetGroupId = null
    this.bump()
  }

  /** 组内新增 tab（动态增员：用户拖入 / AI 开 tab 归组）。 */
  addTabsToGroup(groupId: number, tabIds: number[]): boolean {
    const record = this.groups.get(groupId)
    if (record === undefined || tabIds.length === 0) return false
    const newOnes = tabIds.filter((tabId) => !record.tabIds.has(tabId)).length
    if (record.tabIds.size + newOnes > MAX_GROUP_TABS) return false
    let changed = false
    for (const tabId of tabIds) {
      const prev = this.tabToGroup.get(tabId)
      if (prev !== undefined && prev !== groupId) {
        // 该 tab 已在其它授权组：从原组移除，改归本组。
        this.groups.get(prev)?.tabIds.delete(tabId)
        this.tabToGroup.delete(tabId)
        changed = true
      }
      if (!record.tabIds.has(tabId)) {
        record.tabIds.add(tabId)
        this.tabToGroup.set(tabId, groupId)
        changed = true
      }
    }
    if (this.targetTabId === null && changed) {
      this.targetTabId = tabIds[0]
      this.targetGroupId = groupId
    }
    if (changed) this.bump()
    return changed
  }

  /** 把组的授权集合同步为「当前打开」的 tab 集合：剔除已关闭的、补入新打开的，使
   *  组容量（MAX_GROUP_TABS）始终按真实打开的页数计算，避免「只见 2 个 tab 却报满」
   *  这类幽灵计数导致的假满。 */
  syncGroupTabs(groupId: number, tabIds: number[]): boolean {
    const record = this.groups.get(groupId)
    if (record === undefined) return false
    let changed = false
    const next = new Set(tabIds)
    // 剔除已关闭的 tab（不在当前打开集合中）。
    for (const tabId of [...record.tabIds]) {
      if (!next.has(tabId)) {
        record.tabIds.delete(tabId)
        this.tabToGroup.delete(tabId)
        if (this.targetTabId === tabId) {
          this.targetTabId = null
          this.targetGroupId = null
        }
        changed = true
      }
    }
    // 补入新打开的 tab。
    for (const tabId of next) {
      const prev = this.tabToGroup.get(tabId)
      if (prev !== undefined && prev !== groupId) {
        // 该 tab 已在其它授权组：从原组移除，改归本组。
        this.groups.get(prev)?.tabIds.delete(tabId)
        this.tabToGroup.delete(tabId)
      }
      if (!record.tabIds.has(tabId)) {
        record.tabIds.add(tabId)
        this.tabToGroup.set(tabId, groupId)
        changed = true
      }
    }
    if (changed) this.bump()
    return changed
  }

  /** 组内移除 tab。 */
  removeTabsFromGroup(groupId: number, tabIds: number[]): boolean {
    const record = this.groups.get(groupId)
    if (record === undefined || tabIds.length === 0) return false
    let changed = false
    for (const tabId of tabIds) {
      if (record.tabIds.delete(tabId)) {
        this.tabToGroup.delete(tabId)
        if (this.targetTabId === tabId) {
          this.targetTabId = null
          this.targetGroupId = null
        }
        changed = true
      }
    }
    // Chrome 不允许空标签组：组内最后一个 tab 关闭后该组即消失（通常触发
    // tabGroups.onRemoved）。这里顺手清理已变空的授权 group record，避免
    // isAuthorizedGroup 对「组还在但已空」的残留组继续返回 true。
    if (changed && record.tabIds.size === 0) {
      this.groups.delete(groupId)
    }
    if (changed) this.bump()
    return changed
  }

  /** 移除一个 tab（跨组：任何授权组）。 */
  removeTab(tabId: number): boolean {
    const groupId = this.tabToGroup.get(tabId)
    if (groupId === undefined) return false
    return this.removeTabsFromGroup(groupId, [tabId])
  }

  isAuthorizedGroup(groupId: number): boolean {
    return this.groups.has(groupId)
  }

  isAuthorizedTab(tabId: number): boolean {
    return this.tabToGroup.has(tabId)
  }

  groupOf(tabId: number): number | null {
    return this.tabToGroup.get(tabId) ?? null
  }

  /** 当前 AI 可操作的所有授权 tab（多组并集）。 */
  listTabs(): number[] {
    const out: number[] = []
    for (const group of this.groups.values()) {
      for (const tabId of group.tabIds) out.push(tabId)
    }
    return out
  }

  /** 设置 AI 当前目标 tab（browser_tab_switch 用）。可附带元数据供面板显示。 */
  setTarget(tabId: number, meta?: { title?: string; url?: string }): boolean {
    const groupId = this.tabToGroup.get(tabId)
    if (groupId === undefined) return false
    this.targetTabId = tabId
    this.targetGroupId = groupId
    if (meta) this.targetMeta = { title: meta.title ?? '', url: meta.url ?? '' }
    this.bump()
    return true
  }

  /** 解析当前目标 tab；无有效目标时自动选一个授权 tab；无授权则返回 null。无 handoff。 */
  resolveTarget(): number | null {
    if (this.targetTabId !== null && this.tabToGroup.has(this.targetTabId)) {
      return this.targetTabId
    }
    const all = this.listTabs()
    if (all.length === 0) return null
    this.targetTabId = all[0]
    this.targetGroupId = this.tabToGroup.get(all[0]) ?? null
    this.targetMeta = null
    this.bump()
    return this.targetTabId
  }

  /** 是否允许 AI 开新 tab（按策略）。 */
  mayOpenTab(): boolean {
    return this.mode === 'allow'
  }

  /** 属于某个 agent 的组 id 列表。 */
  groupsForSession(sessionId: string): number[] {
    const out: number[] = []
    for (const g of this.groups.values()) if (g.ownerSessionId === sessionId) out.push(g.groupId)
    return out
  }

  /** 某 agent 最近一个可加入的组；无则 null。 */
  lastGroupForSession(sessionId: string): number | null {
    const ids = this.groupsForSession(sessionId)
    return ids.length === 0 ? null : ids[ids.length - 1]
  }

  /** 某 agent 可操作的所有 tab（只含它自己组的 tab）。 */
  listTabsForSession(sessionId: string): number[] {
    const out: number[] = []
    for (const groupId of this.groupsForSession(sessionId)) {
      const record = this.groups.get(groupId)
      if (record !== undefined) for (const tabId of record.tabIds) out.push(tabId)
    }
    return out
  }

  /** 某 tab 是否属于某 agent（在该 agent 自己的组内）。 */
  isAuthorizedTabForSession(tabId: number, sessionId: string): boolean {
    const groupId = this.tabToGroup.get(tabId)
    if (groupId === undefined) return false
    return this.groups.get(groupId)?.ownerSessionId === sessionId
  }

  /** 解析某 agent 的目标 tab：仅限它自己的组；无则 null。 */
  resolveTargetForSession(sessionId: string): number | null {
    if (this.targetTabId !== null && this.isAuthorizedTabForSession(this.targetTabId, sessionId)) return this.targetTabId
    const all = this.listTabsForSession(sessionId)
    return all.length === 0 ? null : all[0]
  }

  /** 某 agent 当前已用页数（跨它所有组，用于组上限提示）。 */
  sessionTabCount(sessionId: string): number {
    return this.listTabsForSession(sessionId).length
  }

  private bump(): void {
    this.revision += 1
  }
}

/** 应用一次授权动作（跨 RPC 的简化入口）。 */
export function applyAuthAction(controller: TabAuthorizationController, action: TabAuthAction): boolean {
  switch (action.kind) {
    case 'authorize':
      if (action.groupId === undefined) return false
      return controller.authorizeGroup(action.groupId, action.title ?? '', action.tabIds ?? [])
    case 'revoke':
      return controller.revokeGroup(action.groupId)
    case 'mode':
      return controller.setMode(action.mode)
    case 'target':
      return controller.setTarget(action.tabId)
    default:
      return false
  }
}
