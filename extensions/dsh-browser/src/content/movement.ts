/**
 * Humanized pointer movement.
 *
 * The content script has no access to the real OS cursor; a synthetic
 * `click()` teleports the pointer instead of moving it. These helpers compute
 * a hand-like pointer plan: the cursor travels along an eased, slightly bowed
 * curve (fast-then-slow) with a little random perturbation, lands on a
 * RANDOM point inside the target element (not the dead-center), and pauses
 * randomly between steps. The plan is then replayed as REAL cursor events via
 * CDP `Input.dispatchMouseEvent` (see pointer.ts), so the page sees an actual
 * pointer, `:hover`/tooltips/dropdowns react, and `mousePressed`/`release`
 * produce a genuine click. Where real CDP input is unavailable (a protected
 * page, a subframe, or no `chrome.runtime` in a test), the same plan is
 * replayed as synthetic `dispatchEvent` events so behaviour degrades instead
 * of breaking.
 *
 * @module
 */

import { sendMouseStepsToCdp, type MouseStep } from './pointer.ts'
import { pointerOverlay } from './pointer-overlay.ts'

/** Current simulated cursor position (client coordinates). */
let lastMouse: { x: number; y: number } | undefined

interface Point {
  x: number
  y: number
}

/** Random pause ranges (ms) that shape the human rhythm. Configurable per op. */
type PauseRange = [number, number]
/** Glide between curve points: fast but not a teleport. */
const GLIDE_PAUSE: PauseRange = [30, 90]
/** Approach / press / release / settle holds: clearly non-robotic. */
const RHYTHM_PAUSE: PauseRange = [60, 200]

function randomPause(range: PauseRange): number {
  const [min, max] = range
  return min + Math.random() * (max - min)
}

/** Center of an element in client coordinates. */
export function elementCenter(el: Element): Point {
  const rect = el.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** A point is fully within the viewport when all four edges are visible. */
function fullyVisible(rect: DOMRect): boolean {
  return rect.top >= 0 && rect.left >= 0
    && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth
}

/** A point is at least partly within the viewport. */
function intersectsViewport(rect: DOMRect): boolean {
  return rect.bottom >= 0 && rect.top <= window.innerHeight
    && rect.right >= 0 && rect.left <= window.innerWidth
}

/**
 * Bring a target into the viewport before operating on it. Keeps the action
 * from blindly clicking an element that is currently off-screen.
 * @param el - target element.
 * @returns true when the element was (or already is) visible after the call.
 */
export function ensureInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (fullyVisible(rect)) return true
  const scrollable = el as HTMLElement
  if (typeof scrollable.scrollIntoView === 'function') {
    // `instant` avoids a CSS smooth animation that could still be running when
    // the next action's coordinates are read.
    scrollable.scrollIntoView({ block: 'center', behavior: 'instant' })
    return intersectsViewport(el.getBoundingClientRect())
  }
  return intersectsViewport(rect)
}

/**
 * Pick a random point inside an element's rect, biased away from the exact
 * centroid. A hand aims at a spot on the element rather than the geometric
 * center, so taps land on edges/corners and never cluster on the dead-center
 * that anti-bot heuristics learn to detect. The point is inset from the very
 * edge (a small safety margin so the hit-test still lands on the element).
 */
export function randomPointInRect(rect: DOMRect, opts: { insetRatio?: number; centerAvoid?: number } = {}): Point {
  const insetRatio = opts.insetRatio ?? 0.08
  const insetX = rect.width * insetRatio
  const insetY = rect.height * insetRatio
  const minX = rect.left + insetX
  const maxX = Math.max(minX, rect.right - insetX)
  const minY = rect.top + insetY
  const maxY = Math.max(minY, rect.bottom - insetY)

  let x = minX + Math.random() * (maxX - minX)
  let y = minY + Math.random() * (maxY - minY)

  // Nudge points that land too close to the centroid outward toward a random
  // edge/corner, so the hit-point is spread across the element.
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const avoidX = rect.width * (opts.centerAvoid ?? 0.14)
  const avoidY = rect.height * (opts.centerAvoid ?? 0.14)
  if (Math.abs(x - cx) < avoidX) {
    x = cx + (x >= cx ? avoidX : -avoidX) + (Math.random() - 0.5) * avoidX * 0.4
  }
  if (Math.abs(y - cy) < avoidY) {
    y = cy + (y >= cy ? avoidY : -avoidY) + (Math.random() - 0.5) * avoidY * 0.4
  }

  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  }
}

/** A random tap point inside an element (using its live bounding rect). */
export function elementRandomPoint(el: Element, opts: { insetRatio?: number } = {}): Point {
  return randomPointInRect(el.getBoundingClientRect(), opts)
}

/** Cubic Bezier interpolation. */
function bezier(t: number, p0: number, c1: number, c2: number, p1: number): number {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return a * p0 + b * c1 + c * c2 + d * p1
}

/**
 * Build an eased, bowed curve between two points.
 *
 * The curve bends perpendicular to the travel direction (a "human elbow") and
 * applies a cubic ease-out so the pointer covers ground fast at first and
 * slows as it nears the target. Interior points receive a small random
 * perturbation so no two moves look identical.
 */
function curvePoints(from: Point, to: Point, steps: number): Point[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  const nx = -dy / distance
  const ny = dx / distance
  const bow = Math.min(distance * 0.3, 36) * (Math.random() < 0.5 ? 1 : -1)
  const c1 = { x: from.x + dx * 0.34 + nx * bow, y: from.y + dy * 0.34 + ny * bow }
  const c2 = { x: from.x + dx * 0.68 + nx * bow * 0.55, y: from.y + dy * 0.68 + ny * bow * 0.55 }

  const points: Point[] = []
  for (let i = 0; i <= steps; i += 1) {
    const raw = i / steps
    const t = 1 - (1 - raw) ** 3
    const x = bezier(t, from.x, c1.x, c2.x, to.x)
    const y = bezier(t, from.y, c1.y, c2.y, to.y)
    if (i > 0 && i < steps) {
      const jitter = 2.5
      points.push({
        x: x + (Math.random() - 0.5) * jitter,
        y: y + (Math.random() - 0.5) * jitter,
      })
    } else {
      points.push({ x, y })
    }
  }
  return points
}

function rememberMouse(point: Point): void {
  lastMouse = { x: point.x, y: point.y }
}

/** The point the cursor is assumed to start from. */
function startPoint(target: Point): Point {
  if (lastMouse !== undefined) return lastMouse
  // First interaction: approach from just outside the target, like a hand
  // arriving at the element rather than materializing on it.
  const seed = { x: target.x + 26, y: target.y + 26 }
  rememberMouse(seed)
  return seed
}

/** One `mouseMoved` step. */
function movedStep(point: Point, buttons: number, pauseAfterMs: number): MouseStep {
  return { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons, pauseAfterMs }
}

/** Glide along the curve as a sequence of `mouseMoved` steps with pauses. */
function moveSteps(from: Point, to: Point, opts: { points?: number; buttons?: number } = {}): MouseStep[] {
  const curve = curvePoints(from, to, opts.points ?? 9)
  const buttons = opts.buttons ?? 0
  return curve.map((point) => movedStep(point, buttons, randomPause(GLIDE_PAUSE)))
}

/**
 * Build a plan that glides the cursor to a random point on the element and
 * stops there (no press). Used to place the real pointer over a link before
 * its own activation, so the page sees the arrive + `:hover`.
 */
export function buildMoveToSteps(el: Element, opts: { points?: number } = {}): MouseStep[] {
  const to = elementRandomPoint(el)
  const from = startPoint(to)
  const steps = moveSteps(from, to, { points: opts.points ?? 9 })
  rememberMouse(to)
  return steps
}

/** Build a plan that clicks a random point on the element: glide, press, release. */
export function buildClickSteps(el: Element): MouseStep[] {
  const to = elementRandomPoint(el)
  const from = startPoint(to)
  const steps: MouseStep[] = [
    ...moveSteps(from, to, { points: 9 }),
    movedStep(to, 0, randomPause(RHYTHM_PAUSE)),
    { type: 'mousePressed', x: to.x, y: to.y, button: 'left', buttons: 1, clickCount: 1, pauseAfterMs: randomPause(RHYTHM_PAUSE) },
    { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pauseAfterMs: randomPause(RHYTHM_PAUSE) },
  ]
  rememberMouse(to)
  return steps
}

/** Build a hover plan: glide to a random point, then rest so `:hover` renders. */
export function buildHoverSteps(el: Element): MouseStep[] {
  const to = elementRandomPoint(el)
  const from = startPoint(to)
  const steps: MouseStep[] = [
    ...moveSteps(from, to, { points: 8 }),
    movedStep(to, 0, randomPause(RHYTHM_PAUSE)),
  ]
  rememberMouse(to)
  return steps
}

/**
 * Build a drag plan: press at `from`, trail along the curve to `to` (left
 * button held so the browser treats it as a real drag), then release.
 */
export function buildDragSteps(from: Point, to: Point, opts: { steps?: number } = {}): MouseStep[] {
  const pressPause = randomPause(RHYTHM_PAUSE)
  const move = moveSteps(from, to, { points: opts.steps ?? 7, buttons: 1 })
  move[0] = movedStep(from, 1, pressPause)
  const steps: MouseStep[] = [
    movedStep(from, 0, randomPause(GLIDE_PAUSE)),
    { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pauseAfterMs: pressPause },
    ...move,
    { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pauseAfterMs: randomPause(RHYTHM_PAUSE) },
  ]
  rememberMouse(to)
  return steps
}

/**
 * Build a wheel-scroll plan: split the total delta into a few random
 * sub-deltas (a "grab" can rest on a zero segment) applied at the current
 * cursor so the page scrolls the container under the pointer.
 */
export function buildWheelSteps(totalDelta: number, opts: { segments?: number } = {}): MouseStep[] {
  const segments = opts.segments ?? 6
  const anchor = lastMouse ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const weights = Array.from({ length: segments }, () => 0.25 + Math.random())
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  let remaining = totalDelta

  const steps: MouseStep[] = [movedStep(anchor, 0, randomPause(GLIDE_PAUSE))]
  for (let i = 0; i < segments; i += 1) {
    const fraction = i === segments - 1 ? 1 : weights[i]! / totalWeight
    const delta = i === segments - 1
      ? remaining
      : Math.round(totalDelta * fraction * (0.85 + Math.random() * 0.3))
    remaining -= delta
    steps.push({
      type: 'mouseWheel',
      x: anchor.x,
      y: anchor.y,
      deltaX: 0,
      deltaY: delta,
      buttons: 0,
      pauseAfterMs: randomPause(RHYTHM_PAUSE),
    })
  }
  return steps
}

/**
 * Replay a step plan as synthetic DOM events. Only used when real CDP input
 * is unavailable (a protected page, a subframe, or no `chrome.runtime`), so
 * the action degrades instead of breaking: the pointer still moves through the
 * SAME coordinates and lands on the same random tap point, so the humanized
 * geometry is preserved. Wall-clock pacing is deliberately not inserted here:
 * synthetic events cannot move the real cursor anyway, and pacing is applied
 * by the CDP replay (the main anti-detection path). A press-then-release with
 * no movement in between emits a `click` so the action still activates; a drag
 * (movement while held) does not.
 */
async function synthesizeMouseSteps(steps: MouseStep[], target?: Element): Promise<void> {
  let pressed = false
  let movedWhilePressed = false
  for (const step of steps) {
    const under = target ?? document.elementFromPoint?.(step.x, step.y) ?? document.body ?? document
    switch (step.type) {
      case 'mouseMoved':
        if (step.buttons !== undefined && step.buttons >= 1) movedWhilePressed = true
        under.dispatchEvent(new MouseEvent('mousemove', {
          clientX: step.x, clientY: step.y, bubbles: true, cancelable: true, composed: true,
        }))
        break
      case 'mousePressed':
        under.dispatchEvent(new MouseEvent('mousedown', {
          clientX: step.x, clientY: step.y, bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
        }))
        pressed = true
        break
      case 'mouseReleased':
        under.dispatchEvent(new MouseEvent('mouseup', {
          clientX: step.x, clientY: step.y, bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0,
        }))
        if (pressed && !movedWhilePressed) {
          under.dispatchEvent(new MouseEvent('click', {
            clientX: step.x, clientY: step.y, bubbles: true, cancelable: true, composed: true, button: 0,
          }))
        }
        pressed = false
        movedWhilePressed = false
        break
      case 'mouseWheel':
        window.scrollBy({ top: step.deltaY ?? 0, behavior: 'instant' })
        window.dispatchEvent(new WheelEvent('wheel', {
          deltaY: step.deltaY ?? 0, clientX: step.x, clientY: step.y, bubbles: true, cancelable: true, composed: true,
        }))
        break
    }
  }
}

/**
 * Dispatch a pointer plan: attempt real CDP cursor events first; on failure
 * replay the same plan as synthetic DOM events targeting `target` so the
 * activation still lands on the element (jsdom has no layout engine and
 * `elementFromPoint` returns null there). Returns whether CDP applied.
 */
export async function dispatchMouseSteps(steps: MouseStep[], target?: Element): Promise<boolean> {
  if (steps.length === 0) return true
  // Drive the visible AI-cursor overlay off the SAME plan coordinates/pauses the
  // CDP replay uses. It is fire-and-forget: the overlay is a pure visual layer
  // (pointer-events: none) and must never gate or mutate the humanized event
  // sequence. It is also a no-op outside the root frame (see pointer-overlay).
  void pointerOverlay.play(steps)
  if (await sendMouseStepsToCdp(steps)) return true
  await synthesizeMouseSteps(steps, target)
  return false
}

/** Glide the real pointer to a random point on the element (no activation).
 * The glide dispatches on whatever is under the cursor; it deliberately is not
 * pinned to the element, so a pure cursor arrival never fires the element's
 * own listeners (the link activation step handles that). */
export async function movePointerTo(el: Element, opts: { points?: number } = {}): Promise<void> {
  await dispatchMouseSteps(buildMoveToSteps(el, opts))
}

/** Real click a random point on the element (glide + press + release). */
export async function clickElement(el: Element): Promise<void> {
  await dispatchMouseSteps(buildClickSteps(el), el)
}

/** Real hover a random point on the element (glide + rest). */
export async function hoverElement(el: Element): Promise<void> {
  await dispatchMouseSteps(buildHoverSteps(el), el)
}

/**
 * Drag interaction for a slider/range or any moveable control: `mousedown` at
 * the origin, several `mousemove` steps toward the destination, then
 * `mouseup`, all as real CDP events. Keeps the traversal progressive (with
 * jitter) so it reads as a hand dragging rather than an instant jump.
 */
export async function dragFromTo(
  el: Element,
  from: Point,
  to: Point,
  opts: { steps?: number } = {},
): Promise<void> {
  await dispatchMouseSteps(buildDragSteps(from, to, opts), el)
}

/**
 * Humanized wheel scrolling as a handful of real `mouseWheel` steps with
 * pauses in between. The viewport moves via the real input event (CDP) or an
 * explicit `scrollBy` in the synthetic fallback.
 */
export async function humanWheelScroll(totalDelta: number, opts: { segments?: number } = {}): Promise<void> {
  await dispatchMouseSteps(buildWheelSteps(totalDelta, opts))
}
