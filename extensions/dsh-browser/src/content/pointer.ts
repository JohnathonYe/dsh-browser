/**
 * CDP pointer transport for the content script.
 *
 * The content script cannot attach `chrome.debugger`; only the background can.
 * So a humanized pointer plan is computed here as a list of absolute
 * CSS-pixel steps and handed to the background, which replays them as REAL
 * cursor events (`Input.dispatchMouseEvent`). `sendMouseStepsToCdp` returns
 * whether the background applied them; on failure the caller falls back to
 * synthetic `dispatchEvent` (see movement.ts).
 *
 * @module
 */

/** One absolute mouse input step, in CSS pixels relative to the viewport. */
export interface MouseStep {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle' | 'none'
  /** Bitfield of buttons currently pressed. */
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
  /** Pause (ms) to insert after this step; honored by CDP or the fallback. */
  pauseAfterMs?: number
}

/** Best-effort access to the extension runtime, absent in jsdom/no-chrome envs. */
function extensionRuntime(): { sendMessage?: (message: unknown) => Promise<unknown> } | undefined {
  const chromeRuntime = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome?.runtime
  return chromeRuntime
}

/**
 * Hard cap (ms) on how long the content waits for the background to acknowledge
 * a CDP pointer replay. Rejecting via `Promise.race` settles this promise; the
 * chrome.runtime.sendMessage channel is left to the runtime to close.
 */
export const CDP_REPLY_TIMEOUT_MS = 6_000

/** Reject after `ms` without abandoning the underlying promise. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Ask the background to replay a pointer plan as real CDP cursor events.
 *
 * The background ack comes only after `replayMouseSteps` finishes the whole
 * `Input.dispatchMouseEvent` plan. If `chrome.debugger.attach`/`sendCommand`
 * hangs (a protected page, a renderer stall, or a target another debugger
 * holds), the ack never arrives, so this bounds the wait and lets the caller
 * fall back to synthetic events instead of holding the action until the host
 * tool budget (90s) expires.
 * @returns true when the plan was applied via `Input.dispatchMouseEvent`;
 *   false when the background is unavailable, declined the tab, or the CDP
 *   dispatch failed or timed out (in which case the caller should fall back
 *   to synthetic).
 */
export async function sendMouseStepsToCdp(steps: MouseStep[]): Promise<boolean> {
  const runtime = extensionRuntime()
  if (runtime === undefined || typeof runtime.sendMessage !== 'function') return false
  try {
    const response = await withTimeout(
      runtime.sendMessage({ type: 'DSH_INPUT_MOUSE', steps }) as Promise<unknown>,
      CDP_REPLY_TIMEOUT_MS,
      'CDP mouse replay timed out waiting for the background acknowledge',
    ) as { ok?: unknown; error?: unknown }
    return response?.ok === true
  } catch {
    // Could not reach the background (or the frame navigated mid-dispatch, or
    // the replay never acked within the cap); let the caller fall back to
    // synthetic events rather than stalling the tool.
    return false
  }
}
