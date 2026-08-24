// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureInViewport,
  humanWheelScroll,
  moveMouseSynchronous,
} from '../src/content/movement.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ensureInViewport', () => {
  it('leaves a fully visible element alone', () => {
    // setup.ts stubs getBoundingClientRect to a fully visible rect.
    const el = document.createElement('button')
    const scroll = vi.fn()
    Object.defineProperty(el, 'scrollIntoView', { value: scroll, configurable: true })
    expect(ensureInViewport(el)).toBe(true)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('scrolls an off-viewport element into view before operating on it', () => {
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({
      top: 1200, left: 0, right: 100, bottom: 1300, width: 100, height: 100, x: 0, y: 1200,
      toJSON: () => ({}),
    }) as DOMRect
    const scroll = vi.fn()
    Object.defineProperty(el, 'scrollIntoView', { value: scroll, configurable: true })
    ensureInViewport(el)
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
  })
})

describe('moveMouseSynchronous', () => {
  it('glides a curved path of mousemove events toward the element (no teleport)', () => {
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({
      top: 100, left: 100, right: 200, bottom: 140, width: 100, height: 40, x: 100, y: 100,
      toJSON: () => ({}),
    }) as DOMRect
    const dispatch = vi.spyOn(document.body, 'dispatchEvent')
    // A single synthetic click would be one event; a human move must be many.
    moveMouseSynchronous(el)
    const moves = dispatch.mock.calls.filter(([event]) => (event as MouseEvent).type === 'mousemove')
    expect(moves.length).toBeGreaterThan(5)
    // Intermediate positions are distinct, so the pointer is not teleported.
    const xs = moves.map(([event]) => (event as MouseEvent).clientX)
    expect(new Set(xs).size).toBeGreaterThan(2)
  })
})

describe('humanWheelScroll', () => {
  it('applies the scroll as several wheel segments with pauses', async () => {
    vi.useFakeTimers()
    const scrollBy = vi.fn()
    vi.spyOn(window, 'scrollBy').mockImplementation(scrollBy)
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    const pending = humanWheelScroll(400, { segments: 4, stepMs: 10 })
    await vi.advanceTimersByTimeAsync(200)

    await pending
    expect(scrollBy).toHaveBeenCalled()
    expect(scrollBy.mock.calls.length).toBeGreaterThanOrEqual(4)
    const wheel = dispatch.mock.calls.filter(([event]) => (event as Event).type === 'wheel')
    expect(wheel.length).toBeGreaterThanOrEqual(4)
  })
})
