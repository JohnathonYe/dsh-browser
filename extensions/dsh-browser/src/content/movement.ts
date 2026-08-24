/**
 * Humanized pointer movement.
 *
 * The content script has no access to the real OS cursor, and a synthetic
 * `click()` teleports the pointer instead of moving it. These helpers make
 * interacting elements approximate a hand: the pointer travels along an
 * eased, slightly bowed curve (fast-then-slow) with a little perturbation,
 * and — where a real pause matters (hover, slider drag) — settles in small
 * timed steps before the actual activation.
 *
 * Two modes are exposed:
 *  - Synchronous (`moveMouseSynchronous`): every curve point is dispatched in
 *    one tick. Used right before a click so the action still answers within
 *    its settle budget (the click may navigate and must not stall).
 *  - Human (`moveMouseHuman` / `dragFromTo`): dispatches `mouseover`/
 *    `mouseenter`/`mousemove` across the element with small pauses, so
 *    JS-driven hover affordances (tooltips, menu previews) have time to
 *    render. Used by `browser_hover` and slider drags.
 *
 * @module
 */

/** Current simulated cursor position (client coordinates). */
let lastMouse: { x: number; y: number } | undefined

interface Point {
  x: number
  y: number
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
 *
 * @param from - start point.
 * @param to - end point.
 * @param steps - number of intermediate positions (inclusive of endpoints).
 */
function curvePoints(from: Point, to: Point, steps: number): Point[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  const nx = -dy / distance
  const ny = dx / distance
  // Bowing toward a random side, bounded so large drags do not sweep away.
  const bow = Math.min(distance * 0.3, 36) * (Math.random() < 0.5 ? 1 : -1)
  const c1 = { x: from.x + dx * 0.34 + nx * bow, y: from.y + dy * 0.34 + ny * bow }
  const c2 = { x: from.x + dx * 0.68 + nx * bow * 0.55, y: from.y + dy * 0.68 + ny * bow * 0.55 }

  const points: Point[] = []
  for (let i = 0; i <= steps; i += 1) {
    const raw = i / steps
    // cubic ease-out: fast start, gentle landing
    const t = 1 - (1 - raw) ** 3
    const x = bezier(t, from.x, c1.x, c2.x, to.x)
    const y = bezier(t, from.y, c1.y, c2.y, to.y)
    // Perturb interior points only; keep the endpoints exact.
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

/**
 * Dispatch one synthetic mouse event at a point.
 * @param type - event type (`mousemove`, `mouseover`, `mouseenter`, ...).
 * @param x - client X.
 * @param y - client Y.
 * @param target - the element to dispatch on; defaults to the element under the
 *   point (falling back to `document.body`), which lets the pointer pass over
 *   whatever is actually underneath it.
 */
function dispatchMouseEvent(type: string, point: Point, target?: Element): void {
  const under = target ?? document.elementFromPoint?.(point.x, point.y) ?? document.body ?? document
  const event = new MouseEvent(type, {
    clientX: point.x,
    clientY: point.y,
    bubbles: true,
    cancelable: true,
    composed: true,
  })
  under.dispatchEvent(event)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Move the (simulated) pointer to an element in a single synchronous pass,
 * dispatching each curve point as a `mousemove`. No wall-clock pauses: used
 * directly before a click so the action can answer within its settle budget.
 * @param el - element to reach.
 */
export function moveMouseSynchronous(el: Element): void {
  const to = elementCenter(el)
  const from = startPoint(to)
  const path = curvePoints(from, to, 9)
  for (const point of path) dispatchMouseEvent('mousemove', point)
  rememberMouse(to)
}

/**
 * Move the pointer to an element with human timing: a `mouseover`/`mouseenter`
 * burst on the element, then a curved `mousemove` path with small pauses.
 * JS-driven hover affordances react to these events even though the browser's
 * `:hover` pseudo-class is not updated by synthetic events.
 * @param el - element to hover.
 * @param opts - step delay (ms) and the settle pause before returning.
 */
export async function moveMouseHuman(el: Element, opts: { stepMs?: number; settleMs?: number } = {}): Promise<void> {
  const stepMs = opts.stepMs ?? 12
  const settleMs = opts.settleMs ?? 140
  const to = elementCenter(el)
  const from = startPoint(to)
  const path = curvePoints(from, to, 8)

  // Announce an enter on the element so its own listeners see the hover before
  // the pointer arrives over it.
  dispatchMouseEvent('mouseover', path[0] ?? to, el)
  dispatchMouseEvent('mouseenter', path[0] ?? to, el)

  for (const point of path) {
    dispatchMouseEvent('mousemove', point, el)
    if (stepMs > 0) await sleep(stepMs)
  }
  rememberMouse(to)
  if (settleMs > 0) await sleep(settleMs)
}

/**
 * Drag interaction for a slider/range or any moveable control: `mousedown` at
 * the origin, several `mousemove` steps toward the destination, then
 * `mouseup`. Keeps the traversal progressive (with jitter) so it reads as a
 * hand dragging rather than an instant jump.
 * @param el - control element (or the element to press on).
 * @param from - start client point.
 * @param to - end client point.
 * @param opts - step delay and how many intermediate positions to take.
 */
export async function dragFromTo(
  el: Element,
  from: Point,
  to: Point,
  opts: { stepMs?: number; steps?: number } = {},
): Promise<void> {
  const stepMs = opts.stepMs ?? 12
  const steps = opts.steps ?? 7
  dispatchMouseEvent('mousedown', from, el)
  const path = curvePoints(from, to, steps)
  for (const point of path) {
    dispatchMouseEvent('mousemove', point, el)
    if (stepMs > 0) await sleep(stepMs)
  }
  dispatchMouseEvent('mouseup', to, el)
  rememberMouse(to)
}

/**
 * Humanized wheel scrolling: split the total scroll into a handful of
 * `wheel` events with real `window.scrollBy` applied and small pauses in
 * between. Synthetic `wheel` events do not move the viewport by themselves,
 * so the scroll is applied explicitly and the event is dispatched for
 * whatever listeners care.
 * @param totalDelta - net vertical pixels to scroll (positive scrolls down).
 * @param opts - how many segments and the inter-segment pause.
 */
export async function humanWheelScroll(
  totalDelta: number,
  opts: { segments?: number; stepMs?: number } = {},
): Promise<void> {
  const segments = opts.segments ?? 6
  const stepMs = opts.stepMs ?? 14
  // Distribute into random sub-deltas that sum to the total (one segment is
  // allowed to be zero so a "grab" does not always move).
  const weights = Array.from({ length: segments }, () => 0.25 + Math.random())
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  let remaining = totalDelta
  for (let i = 0; i < segments; i += 1) {
    const fraction = i === segments - 1 ? 1 : weights[i]! / totalWeight
    const delta = i === segments - 1
      ? remaining
      : Math.round(totalDelta * fraction * (0.85 + Math.random() * 0.3))
    remaining -= delta
    // Applying `instant` keeps each segment exact; the inter-segment pause is
    // what makes the motion read as human rather than a teleport.
    window.scrollBy({ top: delta, behavior: 'instant' })
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaY: delta,
      clientX: 0,
      clientY: 0,
      bubbles: true,
      cancelable: true,
      composed: true,
    }))
    if (stepMs > 0) await sleep(stepMs)
  }
}
