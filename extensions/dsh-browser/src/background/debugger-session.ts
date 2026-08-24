/**
 * Shared chrome.debugger attachment lifecycle for the controlled tab.
 *
 * Both the screenshot capture (`Page.captureScreenshot`) and the humanized
 * pointer input (`Input.dispatchMouseEvent`) attach to the tab. Chrome rejects
 * a second attach to an already-attached target ("Another debugger is already
 * attached"), so every consumer goes through this single reference-counted
 * session: the first `acquire` attaches, the last `release` detaches. This
 * keeps exactly one debugger session alive per operation and removes the
 * attach/detach churn (and the "正在调试此浏览器" yellow bar flicker) that two
 * independent attach/detach paths would otherwise cause.
 *
 * Screenshot and pointer input run in the same service worker and can overlap,
 * so attach/detach (and the refcount mutation) are serialized per tab with a
 * small mutex: concurrent `acquire` calls queue, the first attaches, and each
 * caller bumps the count exactly once.
 *
 * @module
 */

/** The DevTools protocol version the debugger session speaks. */
const PROTOCOL_VERSION = '1.3'

/** Per-tab reference counts so a shared attach is held until all users settle. */
class DebuggerSession {
  private readonly refs = new Map<number, number>()
  private readonly attached = new Set<number>()
  /** Per-tab serialization tail so acquire/release never interleave. */
  private readonly locks = new Map<number, Promise<void>>()

  /** Run `fn` for a tab after the previous acquire/release for it completes. */
  private async withLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(tabId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(tabId, next)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(tabId) === next) this.locks.delete(tabId)
    }
  }

  /**
   * Attach to a tab if it is not already attached, then bump its reference
   * count. Fails (throws) when Chrome cannot attach (for example the tab is a
   * protected page or DevTools already owns it); callers must treat a thrown
   * error as "CDP input is unavailable" and fall back to synthetic events.
   */
  async acquire(tabId: number): Promise<void> {
    await this.withLock(tabId, async () => {
      const count = this.refs.get(tabId) ?? 0
      if (count === 0) {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION)
        this.attached.add(tabId)
      }
      this.refs.set(tabId, count + 1)
    })
  }

  /** Drop one reference; the last release detaches our own session. */
  async release(tabId: number): Promise<void> {
    await this.withLock(tabId, async () => {
      const count = this.refs.get(tabId) ?? 0
      if (count > 1) {
        this.refs.set(tabId, count - 1)
        return
      }
      this.refs.delete(tabId)
      this.attached.delete(tabId)
      // Only detach when we actually held a reference (an `acquire` that threw
      // never attached, so there is nothing to clean up).
      if (count === 1) {
        // A failed detach (target closed mid-operation) is not worth surfacing.
        await chrome.debugger.detach({ tabId }).catch(() => {})
      }
    })
  }

  /** Send a CDP command on the tab, assuming the caller holds a reference. */
  async sendCommand<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>
  }

  /** True when this session currently has the tab attached. */
  isAttached(tabId: number): boolean {
    return this.attached.has(tabId)
  }
}

export const debuggerSession = new DebuggerSession()
