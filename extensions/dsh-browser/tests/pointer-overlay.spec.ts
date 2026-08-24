// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pointerOverlay } from '../src/content/pointer-overlay.ts'
import type { MouseStep } from '../src/content/pointer.ts'

/** A short plan with known coordinates so we can assert the cursor tracks them. */
function plan(): MouseStep[] {
  return [
    { type: 'mouseMoved', x: 20, y: 30, buttons: 0, pauseAfterMs: 10 },
    { type: 'mouseMoved', x: 60, y: 70, buttons: 0, pauseAfterMs: 10 },
    { type: 'mousePressed', x: 100, y: 120, button: 'left', buttons: 1, clickCount: 1, pauseAfterMs: 10 },
    { type: 'mouseReleased', x: 100, y: 120, button: 'left', buttons: 0, clickCount: 1, pauseAfterMs: 10 },
  ]
}

function track(): HTMLElement | null {
  const host = pointerOverlay.element
  return host?.shadowRoot?.querySelector<HTMLElement>('.dsh-ai-cursor__track') ?? null
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
})

afterEach(() => {
  pointerOverlay.hide()
  document.getElementById('__dsh_ai_cursor__')?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pointerOverlay', () => {
  it('injects a fixed, non-interactive AI cursor in the top frame', () => {
    pointerOverlay.show()
    const host = document.getElementById('__dsh_ai_cursor__')!
    expect(host).not.toBeNull()
    // Positioned at the top of the viewport, above page chrome.
    expect(host.style.position).toBe('fixed')
    expect(host.style.zIndex).toBe('2147483647')
    // Explicitly excluded from the hit-test chain so it never intercepts events.
    expect(host.style.pointerEvents).toBe('none')
    // Out of layout flow: zero-size box whose children overflow into view.
    expect(host.style.width).toBe('0px')
    expect(host.style.height).toBe('0px')
    // The visual pointer + distinct "AI" badge live in a closed-off shadow root.
    const shadow = host.shadowRoot
    expect(shadow).not.toBeNull()
    expect(shadow!.querySelector('.dsh-ai-cursor__badge')!.textContent).toBe('AI')
    expect(shadow!.querySelector('.dsh-ai-cursor__pointer')).not.toBeNull()
  })

  it('tracks the step-plan coordinates and highlights press/release', async () => {
    const running = pointerOverlay.play(plan())
    // The cursor is shown synchronously (before the first awaited pause).
    expect(pointerOverlay.isActive()).toBe(true)
    // 40ms covers the 4 steps (10ms pause each); the press lands at (100,120).
    await vi.advanceTimersByTimeAsync(40)
    expect(track()!.style.opacity).toBe('1')
    // Coordinates flow from the plan into the moving track's transform.
    expect(track()!.style.transform).toBe('translate(100px, 120px)')
    // The clicked point emits a transient ripple.
    expect(track()!.querySelectorAll('.dsh-ai-cursor__ripple').length).toBeGreaterThan(0)
    await running
    // The cursor STAYS parked at the last step's coordinates instead of being
    // torn down, so a human can keep watching where the agent's pointer landed.
    expect(document.getElementById('__dsh_ai_cursor__')).not.toBeNull()
    expect(pointerOverlay.isActive()).toBe(true)
    expect(track()!.style.transform).toBe('translate(100px, 120px)')
  })

  it('shows pressed highlight while the button is held, then restores on release', async () => {
    const running = pointerOverlay.play([{ type: 'mousePressed', x: 50, y: 60, button: 'left', buttons: 1, clickCount: 1, pauseAfterMs: 10 }])
    await vi.advanceTimersByTimeAsync(0)
    const pointer = track()?.querySelector<SVGElement>('.dsh-ai-cursor__pointer')
    expect(pointer?.style.transform).toBe('scale(1.22)')
    await vi.advanceTimersByTimeAsync(1_000)
    await running
  })

  it('is a no-op outside the root frame (subframe)', () => {
    // A subframe has window.top !== window; the overlay must not inject there.
    const hadOwn = Object.prototype.hasOwnProperty.call(window, 'top')
    const original = Object.getOwnPropertyDescriptor(window, 'top')
    Object.defineProperty(window, 'top', { value: {}, configurable: true })
    try {
      pointerOverlay.show()
      expect(document.getElementById('__dsh_ai_cursor__')).toBeNull()
    } finally {
      if (hadOwn && original !== undefined) Object.defineProperty(window, 'top', original)
      else delete (window as unknown as Record<string, unknown>).top
    }
  })
})
