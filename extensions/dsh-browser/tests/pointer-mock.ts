/**
 * Test helper: a fake `chrome.runtime.sendMessage` that records the CDP pointer
 * plans (`DSH_INPUT_MOUSE`) the content script hands to the background, so the
 * humanized-movement tests can assert on the REAL cursor step plan instead of
 * on synthetic DOM dispatch. The background is treated as replaying it
 * successfully by default (`ok: true`); call `setOk(false)` to exercise the
 * synthetic-event fallback.
 */

import { vi } from 'vitest'

interface CapturedStep {
  type: string
  x: number
  y: number
  button?: string
  buttons?: number
  clickCount?: number
  deltaY?: number
  pauseAfterMs?: number
}

export interface CapturedPointerPlan {
  steps: CapturedStep[]
}

export interface PointerCdpMock {
  /** Every `DSH_INPUT_MOUSE` plan the content script sent. */
  captured: CapturedPointerPlan[]
  sendMessage: ReturnType<typeof vi.fn>
  /** Flip the background's reply to control CDP success vs fallback. */
  setOk: (value: boolean) => void
  restore: () => void
}

export function installPointerCdpMock(initialOk: boolean = true): PointerCdpMock {
  const captured: CapturedPointerPlan[] = []
  let ok = initialOk
  const sendMessage = vi.fn(async (message: unknown): Promise<{ ok: boolean; error?: string }> => {
    const msg = message as { type?: string; steps?: unknown }
    if (msg?.type === 'DSH_INPUT_MOUSE' && Array.isArray(msg.steps)) {
      captured.push({ steps: msg.steps as CapturedStep[] })
    }
    return { ok, error: ok ? undefined : 'mock-cdp-failure' }
  })
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
  return {
    captured,
    sendMessage,
    setOk: (value: boolean) => { ok = value },
    restore: () => { vi.unstubAllGlobals() },
  }
}
