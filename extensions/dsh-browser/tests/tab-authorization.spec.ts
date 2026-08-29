// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MAX_GROUP_TABS, TabAuthorizationController } from '../src/background/tab-authorization.ts'

describe('TabAuthorizationController group capacity', () => {
  it('authorizes a group and lists only tabs owned by that session', () => {
    const c = new TabAuthorizationController()
    expect(c.authorizeGroup(1, 'DSH-任务', [10, 11, 12], 'sess1')).toBe(true)
    expect(c.listTabsForSession('sess1')).toEqual([10, 11, 12])
    expect(c.listTabsForSession('sess2')).toEqual([])
  })

  it('syncGroupTabs prunes closed tabs so capacity reflects real open tabs', () => {
    const c = new TabAuthorizationController()
    c.authorizeGroup(1, 'DSH-任务', [10, 11, 12], 'sess1')
    // Only 10 and 11 are still open; 12 was closed.
    c.syncGroupTabs(1, [10, 11])
    expect(c.snapshot().groups.find((g) => g.groupId === 1)?.tabIds).toEqual([10, 11])
    expect(c.sessionTabCount('sess1')).toBe(2)
    // 2 open tabs is far below the cap -> not "full".
    expect(c.snapshot().groups.find((g) => g.groupId === 1)?.tabIds.length).toBeLessThan(MAX_GROUP_TABS)
    // The closed tab is no longer authorized.
    expect(c.isAuthorizedTabForSession(12, 'sess1')).toBe(false)
  })

  it('syncGroupTabs adds newly-opened tabs into the group', () => {
    const c = new TabAuthorizationController()
    c.authorizeGroup(1, 'DSH-任务', [10, 11], 'sess1')
    c.syncGroupTabs(1, [10, 11, 12])
    expect(c.snapshot().groups.find((g) => g.groupId === 1)?.tabIds).toEqual([10, 11, 12])
    expect(c.isAuthorizedTabForSession(12, 'sess1')).toBe(true)
  })

  it('addTabsToGroup still enforces the per-agent cap on the live set', () => {
    const c = new TabAuthorizationController()
    const ids = Array.from({ length: MAX_GROUP_TABS }, (_, i) => 100 + i)
    c.authorizeGroup(1, 'DSH-任务', ids, 'sess1')
    expect(c.addTabsToGroup(1, [999])).toBe(false)
  })
})
