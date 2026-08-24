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
 * Ask the background to replay a pointer plan as real CDP cursor events.
 * @returns true when the plan was applied via `Input.dispatchMouseEvent`;
 *   false when the background is unavailable, declined the tab, or the CDP
 *   dispatch failed (in which case the caller should fall back to synthetic).
 */
export async function sendMouseStepsToCdp(steps: MouseStep[]): Promise<boolean> {
  const runtime = extensionRuntime()
  if (runtime === undefined || typeof runtime.sendMessage !== 'function') return false
  try {
    const response = await runtime.sendMessage({ type: 'DSH_INPUT_MOUSE', steps }) as { ok?: unknown; error?: unknown }
    return response?.ok === true
  } catch {
    // Could not reach the background (or the frame navigated mid-dispatch);
    // let the caller fall back to synthetic events.
    return false
  }
}
