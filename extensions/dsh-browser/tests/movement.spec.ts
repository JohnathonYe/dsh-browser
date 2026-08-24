// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildClickAtSteps,
  buildClickSteps,
  buildMoveToSteps,
  buildWheelSteps,
  clickAt,
  dispatchMouseSteps,
  ensureInViewport,
  humanWheelScroll,
  jitterPoint,
} from '../src/content/movement.ts'
import { installPointerCdpMock, type PointerCdpMock } from './pointer-mock.ts'

let pointerMock: PointerCdpMock | undefined

beforeEach(() => {
  vi.useFakeTimers()
  pointerMock = installPointerCdpMock(true)
})

afterEach(() => {
  pointerMock?.restore()
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

describe('buildClickSteps', () => {
  it('glides a curved path, presses and releases at a random point inside the element', () => {
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({
      top: 100, left: 100, right: 200, bottom: 160, width: 100, height: 60, x: 100, y: 100,
      toJSON: () => ({}),
    }) as DOMRect

    const steps = buildClickSteps(el)
    const moves = steps.filter((step) => step.type === 'mouseMoved')
    // A single synthetic click would be one event; a human click must be many.
    expect(moves.length).toBeGreaterThan(5)
    // Intermediate positions are distinct, so the pointer is not teleported.
    const xs = moves.map((step) => step.x)
    expect(new Set(xs).size).toBeGreaterThan(2)

    // Every step carries a real random pause => non-robotic rhythm.
    expect(steps.every((step) => (step.pauseAfterMs ?? 0) > 0)).toBe(true)

    // A press and a release close the plan, each at the target point.
    expect(steps.some((step) => step.type === 'mousePressed' && step.button === 'left' && step.buttons === 1)).toBe(true)
    expect(steps.some((step) => step.type === 'mouseReleased' && step.buttons === 0)).toBe(true)
    const press = steps.find((step) => step.type === 'mousePressed')!
    // The tap point sits inside the element rect.
    expect(press.x).toBeGreaterThanOrEqual(100)
    expect(press.x).toBeLessThanOrEqual(200)
    expect(press.y).toBeGreaterThanOrEqual(100)
    expect(press.y).toBeLessThanOrEqual(160)
  })

  it('does not always tap the exact centroid (dead center)', () => {
    const el = document.createElement('button')
    const rect = { top: 100, left: 100, right: 200, bottom: 160, width: 100, height: 60, x: 100, y: 100, toJSON: () => ({}) } as DOMRect
    el.getBoundingClientRect = () => rect
    const points = new Set<string>()
    for (let i = 0; i < 40; i += 1) {
      const press = buildClickSteps(el).find((step) => step.type === 'mousePressed')!
      points.add(`${press.x},${press.y}`)
    }
    // The tap points vary across many samples and never all collapse to the
    // geometric center (150, 130).
    expect(points.size).toBeGreaterThan(5)
    expect(points.has('150,130')).toBe(false)
  })
})

describe('buildClickAtSteps', () => {
  it('glides to a small perturbation of the requested viewport point, then presses and releases there', () => {
    const steps = buildClickAtSteps(500, 300)
    const moves = steps.filter((step) => step.type === 'mouseMoved')
    // A coordinate click is still a humanized glide with many steps, not a teleport.
    expect(moves.length).toBeGreaterThan(5)
    expect(steps.every((step) => (step.pauseAfterMs ?? 0) > 0)).toBe(true)

    const press = steps.find((step) => step.type === 'mousePressed')!
    const release = steps.find((step) => step.type === 'mouseReleased')!
    expect(press.button).toBe('left')
    expect(press.buttons).toBe(1)
    expect(release.buttons).toBe(0)
    // The tap lands within the default jitter (±4 CSS px) of the confirmed point.
    expect(Math.abs(press.x - 500)).toBeLessThanOrEqual(4)
    expect(Math.abs(press.y - 300)).toBeLessThanOrEqual(4)
    // Press and release share the same tap point so the renderer synthesizes a click.
    expect(press.x).toBe(release.x)
    expect(press.y).toBe(release.y)
  })

  it('honours an explicit jitter radius', () => {
    const steps = buildClickAtSteps(100, 100, { jitter: 12 })
    const press = steps.find((step) => step.type === 'mousePressed')!
    expect(Math.abs(press.x - 100)).toBeLessThanOrEqual(12)
    expect(Math.abs(press.y - 100)).toBeLessThanOrEqual(12)
  })

  it('does not always land on the exact confirmed pixel (dead-point avoidance)', () => {
    const points = new Set<string>()
    for (let i = 0; i < 40; i += 1) {
      const press = buildClickAtSteps(500, 300).find((step) => step.type === 'mousePressed')!
      points.add(`${press.x},${press.y}`)
    }
    expect(points.size).toBeGreaterThan(5)
    expect(points.has('500,300')).toBe(false)
  })
})

describe('clickAt', () => {
  it('sends a real CDP coordinate-click plan (moves, press, release) to the background', async () => {
    await clickAt(420, 260)
    expect(pointerMock!.sendMessage).toHaveBeenCalled()
    const plan = pointerMock!.captured[0]!
    expect(plan.steps.some((step) => step.type === 'mouseMoved')).toBe(true)
    expect(plan.steps.some((step) => step.type === 'mousePressed')).toBe(true)
    expect(plan.steps.some((step) => step.type === 'mouseReleased')).toBe(true)
    // The press/release tap lands at (or a few px from) the confirmed point.
    const press = plan.steps.find((step) => step.type === 'mousePressed')!
    const release = plan.steps.find((step) => step.type === 'mouseReleased')!
    expect(Math.abs(press.x - 420)).toBeLessThanOrEqual(10)
    expect(Math.abs(press.y - 260)).toBeLessThanOrEqual(10)
    expect(press.x).toBe(release.x)
    expect(press.y).toBe(release.y)
  })

  it('falls back to synthetic DOM events when CDP input is declined', async () => {
    pointerMock!.setOk(false)
    const dispatch = vi.spyOn(document.body, 'dispatchEvent')
    const pending = clickAt(200, 120)
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    const moves = dispatch.mock.calls.filter(([event]) => (event as MouseEvent).type === 'mousemove')
    expect(moves.length).toBeGreaterThan(5)
  })
})

describe('jitterPoint', () => {
  it('perturbs a coordinate within the requested radius', () => {
    for (let i = 0; i < 50; i += 1) {
      const p = jitterPoint(50, 70, 6)
      expect(p.x).toBeGreaterThanOrEqual(44)
      expect(p.x).toBeLessThanOrEqual(56)
      expect(p.y).toBeGreaterThanOrEqual(64)
      expect(p.y).toBeLessThanOrEqual(76)
    }
  })
})

describe('dispatchMouseSteps', () => {
  it('sends the pointer plan to the background as a real CDP plan', async () => {
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({
      top: 100, left: 100, right: 200, bottom: 160, width: 100, height: 60, x: 100, y: 100,
      toJSON: () => ({}),
    }) as DOMRect

    await dispatchMouseSteps(buildClickSteps(el))
    expect(pointerMock!.sendMessage).toHaveBeenCalled()
    const plan = pointerMock!.captured[0]!
    expect(plan.steps.some((step) => step.type === 'mouseMoved')).toBe(true)
    expect(plan.steps.some((step) => step.type === 'mousePressed')).toBe(true)
    expect(plan.steps.some((step) => step.type === 'mouseReleased')).toBe(true)
  })

  it('falls back to synthetic DOM events when CDP input is declined', async () => {
    pointerMock!.setOk(false)
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({
      top: 100, left: 100, right: 200, bottom: 160, width: 100, height: 60, x: 100, y: 100,
      toJSON: () => ({}),
    }) as DOMRect
    const dispatch = vi.spyOn(document.body, 'dispatchEvent')

    const pending = dispatchMouseSteps(buildClickSteps(el))
    // The synthetic fallback sleeps between steps; drive the fake clock.
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    // Synthetic fallback re-dispatches the events on the page.
    const moves = dispatch.mock.calls.filter(([event]) => (event as MouseEvent).type === 'mousemove')
    expect(moves.length).toBeGreaterThan(5)
  })
})

describe('buildWheelSteps / humanWheelScroll', () => {
  it('splits the scroll into several real wheel ticks that sum to the delta', async () => {
    const steps = buildWheelSteps(400, { segments: 4 })
    const wheels = steps.filter((step) => step.type === 'mouseWheel')
    expect(wheels.length).toBe(4)
    const total = wheels.reduce((sum, step) => sum + (step.deltaY ?? 0), 0)
    expect(total).toBe(400)
    expect(steps[0]!.type).toBe('mouseMoved')
  })

  it('dispatches real wheel steps via the CDP plan', async () => {
    await humanWheelScroll(400, { segments: 6 })
    const plan = pointerMock!.captured[0]!
    const wheels = plan.steps.filter((step) => step.type === 'mouseWheel')
    expect(wheels.length).toBeGreaterThanOrEqual(6)
  })

  it('parks the cursor on a non-center, lower/side point before wheeling (never the viewport dead-center)', () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    for (let i = 0; i < 40; i += 1) {
      const steps = buildWheelSteps(300, { segments: 4 })
      const firstWheel = steps.find((step) => step.type === 'mouseWheel')!
      const ax = firstWheel.x
      const ay = firstWheel.y
      // Neither axis may sit on the midpoint, so the anchor is never (w/2, h/2).
      expect(Math.abs(ax - vw / 2) > 1).toBe(true)
      expect(Math.abs(ay - vh / 2) > 1).toBe(true)
      // x avoids the vertical center column (a hand side/track, never the midpoint).
      const inLeftBand = ax >= vw * 0.35 && ax <= vw * 0.47
      const inRightBand = ax >= vw * 0.53 && ax <= vw * 0.68
      expect(inLeftBand || inRightBand).toBe(true)
      // y is biased toward the lower half.
      expect(ay).toBeGreaterThanOrEqual(vh * 0.55)
      expect(ay).toBeLessThanOrEqual(vh * 0.85)
    }
  })

  it('glides the real cursor to the anchor (several moves + a settle) before the first wheel tick', async () => {
    await humanWheelScroll(300, { segments: 4 })
    const plan = pointerMock!.captured[0]!
    const firstWheelIndex = plan.steps.findIndex((step) => step.type === 'mouseWheel')
    expect(firstWheelIndex).toBeGreaterThan(-1)
    // A hand glides to the anchor first, not a single teleport: many moves precede the first tick.
    const movesBeforeWheel = plan.steps.slice(0, firstWheelIndex).filter((step) => step.type === 'mouseMoved')
    expect(movesBeforeWheel.length).toBeGreaterThan(5)
    // The cursor parks exactly where it will wheel (glide's last point == first wheel anchor).
    const moves = plan.steps.filter((step) => step.type === 'mouseMoved')
    const lastMove = moves[moves.length - 1]!
    const firstWheel = plan.steps[firstWheelIndex]!
    expect(Math.abs(lastMove.x - firstWheel.x)).toBeLessThanOrEqual(0.001)
    expect(Math.abs(lastMove.y - firstWheel.y)).toBeLessThanOrEqual(0.001)
    // And that anchor is not the viewport dead-center.
    const vw = window.innerWidth
    const vh = window.innerHeight
    expect(Math.abs(firstWheel.x - vw / 2) > 1 && Math.abs(firstWheel.y - vh / 2) > 1).toBe(true)
  })
})

describe('buildMoveToSteps', () => {
  it('glides to a random point without pressing (for link activation)', () => {
    const el = document.createElement('a')
    el.getBoundingClientRect = () => ({
      top: 30, left: 40, right: 240, bottom: 70, width: 200, height: 40, x: 40, y: 30,
      toJSON: () => ({}),
    }) as DOMRect
    const steps = buildMoveToSteps(el)
    expect(steps.every((step) => step.type === 'mouseMoved')).toBe(true)
    expect(steps.some((step) => step.type === 'mousePressed')).toBe(false)
    expect(steps.length).toBeGreaterThan(5)
  })
})
