// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction, waitForPageSettled, type PageSettlePolicy } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

const POLICY: PageSettlePolicy = {
  minimumMs: 20,
  quietMs: 20,
  maxAfterReadyMs: 60,
  timeoutMs: 100,
  // Absolute watchdog ceiling; larger than the post-readiness cap (60) and the
  // not-ready timeout (100), so the fake-timer advancement windows below never
  // reach it and the existing assertions stay valid.
  maxSettleMs: 500,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('waitForPageSettled', () => {
  it('returns as soon as the minimum quiet window completes', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    let resolved = false
    const pending = waitForPageSettled(POLICY).then((value) => {
      resolved = true
      return value
    })

    await vi.advanceTimersByTimeAsync(19)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(true)
  })

  it('extends the quiet window when the DOM changes', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    let resolved = false
    const pending = waitForPageSettled(POLICY).then((value) => {
      resolved = true
      return value
    })
    setTimeout(() => { document.body.setAttribute('data-state', 'updated') }, 15)

    await vi.advanceTimersByTimeAsync(34)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(true)
  })

  it('uses the post-readiness cap on continuously changing pages', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    let tick = 0
    const mutations = setInterval(() => {
      tick += 1
      document.body.setAttribute('data-tick', String(tick))
    }, 10)
    const pending = waitForPageSettled(POLICY)

    await vi.advanceTimersByTimeAsync(60)
    clearInterval(mutations)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(true)
  })

  it('returns the current state when the absolute watchdog ceiling is reached', async () => {
    // A policy whose normal escapes (quiet/maxAfterReady/timeout) all sit far
    // above the watchdog so only the absolute ceiling can resolve it. This
    // guards against a continuously-mutating page that keeps re-scheduling the
    // quiet check and would otherwise hold the tool until the host budget.
    vi.useFakeTimers()
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const WATCHDOG_POLICY: PageSettlePolicy = {
      minimumMs: 10_000,
      quietMs: 10_000,
      maxAfterReadyMs: 10_000,
      timeoutMs: 10_000,
      maxSettleMs: 40,
    }
    const pending = waitForPageSettled(WATCHDOG_POLICY)

    await vi.advanceTimersByTimeAsync(39)
    // Still pending: the quiet window has not even begun and the watchdog is
    // the only escape still in the future.
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(true)
  })
})

describe('navigation action responses', () => {
  it('answers a link click before starting a potentially unloading navigation', async () => {
    vi.useFakeTimers()
    const link = document.createElement('a')
    link.href = 'https://example.com/next'
    link.scrollIntoView = vi.fn()
    const dispatch = vi.spyOn(link, 'dispatchEvent').mockReturnValue(true)
    const ids = { elementByIndex: vi.fn(() => link) } as unknown as ElementIds

    await expect(runAction('browser_click', { index: 1 }, {
      ids,
      budget: { maxItems: 20, maxForms: 10, maxChars: 2_000 },
    })).resolves.toMatchObject({
      text: expect.stringContaining('Clicked link [1]'),
      navigationPending: true,
    })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }))
  })

  it('does not wait for a replacement document when a link opens a new tab', async () => {
    vi.useFakeTimers()
    const link = document.createElement('a')
    link.href = 'https://example.com/next'
    link.target = '_blank'
    link.scrollIntoView = vi.fn()
    link.click = vi.fn()
    const ids = { elementByIndex: vi.fn(() => link) } as unknown as ElementIds

    await expect(runAction('browser_click', { index: 1 }, {
      ids,
      budget: { maxItems: 20, maxForms: 10, maxChars: 2_000 },
    })).resolves.toEqual({ text: expect.stringContaining('outside the controlled frame') })

    await vi.advanceTimersByTimeAsync(0)
    expect(link.click).toHaveBeenCalledOnce()
  })

  it('preserves native referrer policy without waiting for a guaranteed navigation', async () => {
    vi.useFakeTimers()
    const link = document.createElement('a')
    link.href = 'https://example.com/private'
    link.rel = 'noreferrer'
    link.scrollIntoView = vi.fn()
    link.click = vi.fn()
    const ids = { elementByIndex: vi.fn(() => link) } as unknown as ElementIds

    const result = await runAction('browser_click', { index: 1 }, {
      ids,
      budget: { maxItems: 20, maxForms: 10, maxChars: 2_000 },
    })

    expect(result.text).toContain('native browser activation')
    expect(result.navigationPending).toBeUndefined()

    await vi.advanceTimersByTimeAsync(0)
    expect(link.click).toHaveBeenCalledOnce()
  })

  it('preserves hyperlink auditing without entering the replacement-document wait', async () => {
    vi.useFakeTimers()
    const link = document.createElement('a')
    link.href = 'https://example.com/next'
    link.setAttribute('ping', 'https://audit.example/link')
    link.scrollIntoView = vi.fn()
    link.click = vi.fn()
    const dispatch = vi.spyOn(link, 'dispatchEvent')
    const ids = { elementByIndex: vi.fn(() => link) } as unknown as ElementIds

    const result = await runAction('browser_click', { index: 1 }, {
      ids,
      budget: { maxItems: 20, maxForms: 10, maxChars: 2_000 },
    })

    expect(result.navigationPending).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(link.click).toHaveBeenCalledOnce()
  })
})
