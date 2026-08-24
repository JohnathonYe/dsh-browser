/**
 * CDP pointer replay for the controlled tab.
 *
 * The content script computes a humanized pointer plan (a curve walk over the
 * target, random in-element tap points, random inter-step pauses) as a list of
 * absolute CSS-pixel steps and hands it to the background. This module replays
 * that plan through the DevTools `Input.dispatchMouseEvent` command, which the
 * renderer treats as a REAL cursor event: the page observes the actual pointer,
 * `:hover`/tooltips/dropdowns react, and `mousePressed`/`mouseReleased` produce
 * a genuine click. Synthetic `dispatchEvent` cannot do any of that.
 *
 * The steps carry their own `pauseAfterMs`, so the background inserts the
 * random human rhythm between commands using one shared debugger session (the
 * same one used by `Page.captureScreenshot`), then detaches.
 *
 * @module
 */

import { debuggerSession } from './debugger-session.ts'

/** Cap (ms) for `chrome.debugger.attach` before the caller falls back to synthetic input. */
const CDP_ATTACH_TIMEOUT_MS = 3_000
/** Cap (ms) for one `Input.dispatchMouseEvent` round-trip. */
const CDP_STEP_TIMEOUT_MS = 2_000
/** Whole replay budget (ms); past this we stop dispatching and report failure. */
const CDP_REPLAY_BUDGET_MS = 5_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Reject after `ms` without abandoning the underlying promise. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** One absolute mouse input step, in CSS pixels relative to the viewport. */
export interface MouseStep {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle' | 'none'
  /** Bitfield of buttons currently pressed, sent to satisfy the CDP schema. */
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
  /** Pause (ms) that must elapse after this step is dispatched. */
  pauseAfterMs?: number
}

/** Translate a content-script step into `Input.dispatchMouseEvent` params. */
function toDispatchParams(step: MouseStep): Record<string, unknown> {
  const params: Record<string, unknown> = {
    type: step.type,
    x: step.x,
    y: step.y,
    pointerType: 'mouse',
  }
  switch (step.type) {
    case 'mousePressed':
      params.button = step.button ?? 'left'
      params.buttons = step.buttons ?? 1
      params.clickCount = step.clickCount ?? 1
      break
    case 'mouseReleased':
      params.button = step.button ?? 'left'
      params.buttons = step.buttons ?? 0
      params.clickCount = step.clickCount ?? 1
      break
    case 'mouseMoved':
      params.button = 'none'
      params.buttons = step.buttons ?? 0
      break
    case 'mouseWheel':
      params.deltaX = step.deltaX ?? 0
      params.deltaY = step.deltaY ?? 0
      break
  }
  return params
}

/**
 * Replay a pointer plan through CDP on `tabId`, attaching the debugger for the
 * whole sequence and detaching when it finishes. Throws on any CDP failure
 * (attach denied, command rejected, target closed) so the caller can fall back
 * to synthetic events.
 */
export async function replayMouseSteps(tabId: number, steps: MouseStep[]): Promise<void> {
  // If attach fails (protected page, DevTools holds the target), we never hold
  // a reference, so there is nothing to release; the error propagates and the
  // caller falls back to synthetic events. If attach times out we also skip
  // release so we never detach a debugger we did not acquire.
  let acquired = false
  try {
    await withTimeout(
      debuggerSession.acquire(tabId),
      CDP_ATTACH_TIMEOUT_MS,
      'CDP attach timed out',
    )
    acquired = true
    const deadline = Date.now() + CDP_REPLAY_BUDGET_MS
    for (const step of steps) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('CDP mouse replay budget exceeded')
      await withTimeout(
        debuggerSession.sendCommand(tabId, 'Input.dispatchMouseEvent', toDispatchParams(step)),
        Math.min(remaining, CDP_STEP_TIMEOUT_MS),
        'CDP mouse dispatch timed out',
      )
      const pause = step.pauseAfterMs ?? 0
      if (pause > 0) await sleep(Math.min(pause, remaining))
    }
  } finally {
    if (acquired) {
      await debuggerSession.release(tabId).catch(() => {})
    }
  }
}
