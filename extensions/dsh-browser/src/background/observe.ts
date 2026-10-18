/**
 * Page health observation: recent console errors, uncaught errors, and failed
 * requests.
 *
 * A silent front-end failure used to look identical to "the click did
 * nothing": the snapshot just showed the old page. These hooks run in the
 * page's MAIN world (via chrome.scripting) and keep small fixed-size ring
 * buffers, so `browser_observe` can explain what the page actually complained
 * about without attaching DevTools for the whole session.
 *
 * The injected functions are self-contained because Chrome serializes them;
 * they cannot reference module-level helpers.
 *
 * @module
 */

/** One buffered console entry. */
export interface ObserveConsoleEntry {
  level: string
  text: string
  ts: number
}

/** One buffered page error. */
export interface ObserveErrorEntry {
  kind: string
  text: string
  ts: number
}

/** One buffered failed request. */
export interface ObserveNetworkEntry {
  url: string
  status: number
  error?: string
  ts: number
}

/** Snapshot returned to the tool layer. */
export interface ObserveSnapshot {
  installed: boolean
  console: ObserveConsoleEntry[]
  network: ObserveNetworkEntry[]
  errors: ObserveErrorEntry[]
}

/** Install the page-world observer exactly once. Serialized into the page. */
function installObserver(): void {
  interface State {
    console: ObserveConsoleEntry[]
    network: ObserveNetworkEntry[]
    errors: ObserveErrorEntry[]
  }
  const key = '__dshObserveV1'
  const holder = window as unknown as Record<string, unknown>
  if (holder[key] !== undefined) return
  const state: State = { console: [], network: [], errors: [] }
  holder[key] = state
  const limit = 50
  const push = <T>(list: T[], entry: T): void => {
    list.push(entry)
    if (list.length > limit) list.splice(0, list.length - limit)
  }
  const stringify = (value: unknown): string => {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const textOf = (args: unknown[]): string => args.map(stringify).join(' ').slice(0, 500)
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      push(state.console, { level, text: textOf(args), ts: Date.now() })
      original(...args)
    }
  }
  window.addEventListener('error', (event) => {
    push(state.errors, { kind: 'error', text: String(event.message || event.error || 'error').slice(0, 500), ts: Date.now() })
  })
  window.addEventListener('unhandledrejection', (event) => {
    push(state.errors, { kind: 'rejection', text: String(event.reason ?? 'unhandled rejection').slice(0, 500), ts: Date.now() })
  })
  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const request = args[0]
      const url = request instanceof Request ? request.url : String(request)
      try {
        const response = await originalFetch(...args)
        if (!response.ok) {
          push(state.network, { url: url.slice(0, 300), status: response.status, ts: Date.now() })
        }
        return response
      } catch (error: unknown) {
        push(state.network, {
          url: url.slice(0, 300),
          status: 0,
          error: String(error).slice(0, 200),
          ts: Date.now(),
        })
        throw error
      }
    }
  }
  const XHR = window.XMLHttpRequest
  if (XHR?.prototype !== undefined) {
    const originalOpen = XHR.prototype.open
    const originalSend = XHR.prototype.send
    XHR.prototype.open = function open(this: XMLHttpRequest & { __dshUrl?: string }, method: string, url: string | URL, ...rest: unknown[]): void {
      this.__dshUrl = String(url)
      // The DOM signature has overloads with async/user/password; forward the
      // whole argument list unchanged.
      originalOpen.apply(this, [method, url, ...rest] as unknown as Parameters<typeof originalOpen>)
    }
    XHR.prototype.send = function send(this: XMLHttpRequest & { __dshUrl?: string }, ...args: unknown[]): void {
      this.addEventListener('loadend', () => {
        if (this.status === 0 || this.status >= 400) {
          push(state.network, {
            url: String(this.__dshUrl ?? '').slice(0, 300),
            status: this.status,
            ...this.status === 0 ? { error: 'network error' } : {},
            ts: Date.now(),
          })
        }
      })
      originalSend.apply(this, args as unknown as Parameters<typeof originalSend>)
    }
  }
}

/** Read (and optionally clear) the page-world observer buffers. */
function readObserver(clear: boolean): ObserveSnapshot {
  const holder = window as unknown as Record<string, unknown>
  const raw = holder.__dshObserveV1 as { console?: ObserveConsoleEntry[]; network?: ObserveNetworkEntry[]; errors?: ObserveErrorEntry[] } | undefined
  if (raw === undefined) return { installed: false, console: [], network: [], errors: [] }
  const snapshot: ObserveSnapshot = {
    installed: true,
    console: [...(raw.console ?? [])],
    network: [...(raw.network ?? [])],
    errors: [...(raw.errors ?? [])],
  }
  if (clear) {
    raw.console?.splice(0)
    raw.network?.splice(0)
    raw.errors?.splice(0)
  }
  return snapshot
}

/** Run one self-contained function in the page's main world and read its result. */
async function runInPage<T, A extends unknown[]>(tabId: number, func: (...args: A) => T, args: A): Promise<T> {
  const scripting = (globalThis as unknown as { chrome?: { scripting?: typeof chrome.scripting } }).chrome?.scripting
  if (scripting === undefined) throw new Error('Page observation requires chrome.scripting, which is unavailable in this browser.')
  const results = await scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func,
    args,
  })
  const first = results[0]
  if (first === undefined) throw new Error('The page did not return an observation result.')
  return first.result as T
}

/**
 * Install the observer on first use, then read its buffers.
 * @param tabId - controlled tab.
 * @param clear - reset the buffers after reading (default true).
 */
export async function observePage(tabId: number, clear: boolean = true): Promise<ObserveSnapshot> {
  await runInPage(tabId, installObserver, [])
  return runInPage(tabId, readObserver, [clear])
}

/** Format an observation snapshot as model-facing text. */
export function formatObservation(snapshot: ObserveSnapshot): string {
  if (!snapshot.installed) {
    return 'The page observer could not be installed (the observer hooks are unavailable on this page).'
  }
  const total = snapshot.console.length + snapshot.network.length + snapshot.errors.length
  if (total === 0) return 'No console errors, page errors, or failed network requests were recorded.'
  const lines: string[] = []
  if (snapshot.console.length > 0) {
    lines.push(`Console (${snapshot.console.length}):`)
    for (const entry of snapshot.console) lines.push(`  [${entry.level}] ${entry.text}`)
  }
  if (snapshot.errors.length > 0) {
    lines.push(`Page errors (${snapshot.errors.length}):`)
    for (const entry of snapshot.errors) lines.push(`  [${entry.kind}] ${entry.text}`)
  }
  if (snapshot.network.length > 0) {
    lines.push(`Failed requests (${snapshot.network.length}):`)
    for (const entry of snapshot.network) {
      lines.push(`  ${entry.status === 0 ? 'NETWORK ERROR' : entry.status} ${entry.url}${entry.error === undefined ? '' : ` (${entry.error})`}`)
    }
  }
  return lines.join('\n').slice(0, 6_000)
}
