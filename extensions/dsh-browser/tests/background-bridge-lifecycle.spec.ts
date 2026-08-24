// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const port = {
    name: 'dsh-panel',
    postMessage: vi.fn(),
    onMessage,
    onDisconnect,
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port }
}

function mockChrome(options: {
  localSet?: (items: Record<string, unknown>) => Promise<void>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm,
  }
  vi.stubGlobal('chrome', {
    alarms,
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
    },
    sidePanel: {
      open: vi.fn(async () => {}),
      setPanelBehavior: vi.fn(async () => {}),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(options.localSet ?? (async () => {})),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Tab', url: 'https://example.com/' })),
      query: vi.fn(async () => [{ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' }]),
      sendMessage: vi.fn(async () => {}),
      create: vi.fn(async (props: chrome.tabs.CreateProperties) => ({ id: 42, windowId: 1, title: 'New Tab', url: props.url ?? '' }) as chrome.tabs.Tab),
      group: vi.fn(async () => 1),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
      onCreated: chromeEvent<[chrome.tabs.Tab]>(),
      onDetached: chromeEvent<[number]>(),
    },
    tabGroups: {
      update: vi.fn(async () => {}),
      onRemoved: chromeEvent<[chrome.tabGroups.TabGroup]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { alarms, onConnect }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background bridge lifecycle', () => {
  it('probes, connects, and arms the keepalive as soon as the extension loads (eager)', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await import('../src/background/index.ts')
    // Eager connect: loading the extension is enough to claim the bridge.
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    expect(fetchMock).toHaveBeenCalled()
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })
    // No stale schedule is torn down at boot in eager mode.
    expect(chromeMock.alarms.clear).not.toHaveBeenCalledWith('bridge-keepalive')
  })

  it('keeps the eager bridge connected when the last panel closes', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.waitFor(() => {
      expect(panel.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    })

    panel.onDisconnect.emit()
    // The eager bridge survives a closing panel; the keepalive stays armed.
    await Promise.resolve()
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(chromeMock.alarms.clear).not.toHaveBeenCalledWith('bridge-keepalive')
  })

  it('does not cold-start self-group from a dsh-web page', async () => {
    mockChrome()
    // The active tab is the dsh host itself (dsh-web UI), not a real page to operate.
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, windowId: 1, title: 'dsh', url: 'http://127.0.0.1:3080/' } as chrome.tabs.Tab,
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:3080/ext/bridge' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    const socket = FakeWebSocket.instances[0]!
    const sent: string[] = []
    socket.send = vi.fn((frame?: string) => { if (frame) sent.push(frame) }) as unknown as typeof socket.send
    socket.open()
    await Promise.resolve()
    socket.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await Promise.resolve()

    socket.receive({
      t: 'tool.call',
      id: 'c1',
      name: 'browser_navigate',
      args: { url: 'https://news.baidu.com' },
      expiresAt: Date.now() + 90_000,
      sessionId: 's1',
    })
    await vi.waitFor(() => {
      expect(sent.some((s) => s.includes('tool.result'))).toBe(true)
    })
    const sentFrame = sent.map((s) => JSON.parse(s) as { t: string; ok: boolean; error?: { code?: string } })
      .find((f) => f.t === 'tool.result')!
    // dsh-web is not an operable target: refuse and go to the open-a-target path.
    expect(sentFrame).toMatchObject({ t: 'tool.result', ok: false, error: { code: 'no-active-tab' } })
    expect(chrome.tabs.group).not.toHaveBeenCalled()
  })

  it('never self-groups/navigates the current regular page on browser_navigate when no group exists', async () => {
    mockChrome()
    // The active page is a real third-party page (NOT dsh-web): the worst case for the old bug,
    // where the current page was bound into DSH-AI and then navigated away from the user.
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, windowId: 1, title: 'Example', url: 'https://example.com/' } as chrome.tabs.Tab,
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    const socket = FakeWebSocket.instances[0]!
    const sent: string[] = []
    socket.send = vi.fn((frame?: string) => { if (frame) sent.push(frame) }) as unknown as typeof socket.send
    socket.open()
    await Promise.resolve()
    socket.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    // Let the budget push (DSH_BUDGET) flush to the tab before we start observing.
    await vi.waitFor(() => { expect(chrome.tabs.sendMessage).toHaveBeenCalled() })

    // Drop any bridge-init message so we can prove the current page is never dispatched/navigated.
    vi.mocked(chrome.tabs.sendMessage).mockClear()

    socket.receive({
      t: 'tool.call',
      id: 'nav1',
      name: 'browser_navigate',
      args: { url: 'https://news.baidu.com' },
      expiresAt: Date.now() + 90_000,
      sessionId: 's1',
    })
    await vi.waitFor(() => {
      expect(sent.some((s) => s.includes('tool.result'))).toBe(true)
    })
    const sentFrame = sent.map((s) => JSON.parse(s) as { t: string; ok: boolean; error?: { code?: string; message?: string } })
      .find((f) => f.t === 'tool.result')!
    // No auth group: the current page must never be grouped (the old hijack is gone).
    expect(chrome.tabs.group).not.toHaveBeenCalled()
    // Nor is it navigated: no content-script dispatch reached the tab.
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
    // Guidance points the AI to browser_new_tab instead of reusing the current page.
    expect(sentFrame).toMatchObject({ t: 'tool.result', ok: false, error: { code: 'no-active-tab' } })
    expect(sentFrame.error!.message).toContain('browser_new_tab')
  })

  it('cold-start builds a fresh DSH- group from browser_new_tab, never the current page', async () => {
    mockChrome()
    // The current page the user is viewing is a real page; it must stay untouched.
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, windowId: 1, title: 'Example', url: 'https://example.com/' } as chrome.tabs.Tab,
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    const socket = FakeWebSocket.instances[0]!
    const sent: string[] = []
    socket.send = vi.fn((frame?: string) => { if (frame) sent.push(frame) }) as unknown as typeof socket.send
    socket.open()
    await Promise.resolve()
    socket.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await Promise.resolve()

    socket.receive({
      t: 'tool.call',
      id: 'new1',
      name: 'browser_new_tab',
      args: { url: 'https://news.baidu.com/' },
      expiresAt: Date.now() + 90_000,
      sessionId: 's1',
    })
    await vi.waitFor(() => {
      expect(sent.some((s) => s.includes('tool.result'))).toBe(true)
    })
    // A brand-new tab is opened; the group is built on that NEW tab (id 42), never the current page (id 1).
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://news.baidu.com/' }))
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [42] })
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(1, { title: 'DSH-AI' })
    const sentFrame = sent.map((s) => JSON.parse(s) as { t: string; ok: boolean })
      .find((f) => f.t === 'tool.result')!
    expect(sentFrame).toMatchObject({ t: 'tool.result', ok: true })
  })

  it('does not let keepalive reclaim a bridge that replaced this client (4000)', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await Promise.resolve()
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await Promise.resolve()
    socket.close(4000, 'replaced')

    chromeMock.alarms.onAlarm.emit({ name: 'bridge-keepalive', scheduledTime: Date.now() })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // A 4000 replacement is terminal: this client must not fight for the slot.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reconnects to a changed bridge address even when the panel already closed (eager)', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const originalSocket = FakeWebSocket.instances[0]!
    originalSocket.open()
    await Promise.resolve()
    originalSocket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({
      type: 'settings',
      settings: { bridgeUrl: 'ws://127.0.0.1:3081', token: 'new-token' },
    })

    // Eager reconnect uses the new address without needing to reopen a panel.
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://127.0.0.1:3081/ext/bridge')
    expect(originalSocket.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('revokes authorization when a single tab in an authorized group closes', async () => {
    const chromeMock = mockChrome()
    const sessionGet = chrome.storage.session.get as unknown as Mock
    // Seed a stored authorization for group 5 containing two tabs.
    sessionGet.mockResolvedValue({ 'dshTabAuthorization': { groupIds: [5] } })
    vi.mocked(chrome.tabs.query).mockImplementation(async (queryInfo: chrome.tabs.QueryInfo) => {
      if ('groupId' in queryInfo && queryInfo.groupId === 5) {
        return [
          { id: 1, windowId: 1, title: 'A', url: 'https://a.example/' } as chrome.tabs.Tab,
          { id: 2, windowId: 1, title: 'B', url: 'https://b.example/' } as chrome.tabs.Tab,
        ]
      }
      return [{ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab]
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    // Wait for the stored authorization (group 5) to be restored + persisted.
    await vi.waitFor(() => {
      expect(chrome.storage.session.set).toHaveBeenCalledWith({ 'dshTabAuthorization': { groupIds: [5] } })
    })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // Close tab 1; group 5 still holds tab 2. The affinity mechanism is unbound so
    // `tabAffinity.removeTab(1)` returns false, which must NOT skip the auth cleanup.
    ;(chrome.tabs.onRemoved as unknown as { emit: (tabId: number) => void }).emit(1)
    await vi.waitFor(() => {
      expect(panel.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-authorization' }))
    })

    type AuthFrame = { type: string; state?: { groups: { groupId: number; tabIds: number[] }[] } }
    const lastAuth = vi.mocked(panel.port.postMessage).mock.calls
      .map(([msg]) => msg as AuthFrame)
      .filter((m) => m.type === 'tab-authorization')
      .at(-1)!
    // The closed tab is removed from the authorized group; the sibling tab remains.
    expect(lastAuth.state!.groups.find((g) => g.groupId === 5)?.tabIds).toEqual([2])
    // No authorized group still holds tab 1.
    expect(lastAuth.state!.groups.some((g) => g.tabIds.includes(1))).toBe(false)
  })

  it('cleans up an authorized group record when its last tab closes', async () => {
    const chromeMock = mockChrome()
    const sessionGet = chrome.storage.session.get as unknown as Mock
    // Seed a stored authorization for group 6 containing only one tab.
    sessionGet.mockResolvedValue({ 'dshTabAuthorization': { groupIds: [6] } })
    vi.mocked(chrome.tabs.query).mockImplementation(async (queryInfo: chrome.tabs.QueryInfo) => {
      if ('groupId' in queryInfo && queryInfo.groupId === 6) {
        return [{ id: 3, windowId: 1, title: 'C', url: 'https://c.example/' } as chrome.tabs.Tab]
      }
      return [{ id: 3, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab]
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    await vi.waitFor(() => {
      expect(chrome.storage.session.set).toHaveBeenCalledWith({ 'dshTabAuthorization': { groupIds: [6] } })
    })

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // Close the only remaining tab in group 6.
    ;(chrome.tabs.onRemoved as unknown as { emit: (tabId: number) => void }).emit(3)
    await vi.waitFor(() => {
      expect(panel.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-authorization' }))
    })

    type AuthFrame = { type: string; state?: { groups: { groupId: number }[] } }
    const lastAuth = vi.mocked(panel.port.postMessage).mock.calls
      .map(([msg]) => msg as AuthFrame)
      .filter((m) => m.type === 'tab-authorization')
      .at(-1)!
    // The now-empty group must disappear from the authorized snapshot.
    expect(lastAuth.state!.groups.some((g) => g.groupId === 6)).toBe(false)
  })
})
