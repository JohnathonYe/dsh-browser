// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CDP_REPLY_TIMEOUT_MS, sendMouseStepsToCdp, type MouseStep } from '../src/content/pointer.ts'

const STEP: MouseStep = { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: 120, buttons: 0 }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sendMouseStepsToCdp', () => {
  it('returns true when the background acks the CDP replay promptly', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: () => Promise.resolve({ ok: true }) },
    })

    const pending = sendMouseStepsToCdp([STEP])
    // Resolve the immediate ack, at any point before the reply cap.
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toBe(true)
  })

  it('returns false (fall back to synthetic) when the background never acks', async () => {
    // A hung `chrome.debugger.attach`/`sendCommand` means the ack never arrives;
    // the content must give up at the cap instead of holding the action until
    // the host tool budget (90s) expires.
    vi.useFakeTimers()
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: () => new Promise(() => {}) },
    })

    const pending = sendMouseStepsToCdp([STEP])
    let resolved = false
    void pending.then(() => { resolved = true })

    await vi.advanceTimersByTimeAsync(CDP_REPLY_TIMEOUT_MS - 1)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
  })

  it('returns false when there is no chrome runtime at all', async () => {
    vi.unstubAllGlobals()
    await expect(sendMouseStepsToCdp([STEP])).resolves.toBe(false)
  })
})
