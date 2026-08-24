/**
 * Visible AI-cursor overlay.
 *
 * CDP `Input.dispatchMouseEvent` moves a REAL pointer in the renderer, but the
 * user watching the page cannot see it (the physical OS cursor never moves
 * from the real input device). This module injects a decorative, fully
 * non-interactive virtual pointer into the controlled (root) frame and drives
 * it off the SAME step plan the content script hands to the background, so a
 * human can watch the agent's pointer glide, hover, press and release without
 * touching the physical mouse and without stealing any page event.
 *
 * Isolation guarantees:
 *  - The overlay lives inside a SHADOW ROOT on a zero-size host element. The
 *    page's `MutationObserver` (used to detect "page is quiet" before an
 *    action returns) observes documentElement's COMPOSED tree but not shadow
 *    trees, so the overlay's constant transform/opacity updates never make the
 *    page look unsettled. Shadow content is also invisible to `textContent`/
 *    `querySelectorAll`, so it can never leak into a text snapshot, and it is
 *    excluded from `elementFromPoint` because every node is `pointer-events:
 *    none` and the host has zero footprint.
 *  - `pointer-events: none` on the host and every shadow node: the overlay is
 *    skipped by the hit-test, never captures a click/drag/hover, and cannot
 *    change the synthetic fallback's target lookup.
 *  - `position: fixed` + max `z-index` + `width/height: 0`: it floats above
 *    page chrome but stays out of layout flow. The moving element (`track`)
 *    lives inside the shadow, so `translate(x,y)` pins the pointer tip to each
 *    step's clientX/clientY without mutating the page-observable host.
 *  - All styling flows through the CSSOM (`el.style.…`), never a `<style>` tag
 *    or an HTML `style` attribute, so the overlay survives pages whose CSP
 *    blocks inline styles (MV3 content-script DOM is subject to page
 *    `style-src`; shadow content is additionally isolated from page CSS).
 *
 * Only the root frame hosts it: subframe pointer plans are replayed as the
 * synthetic fallback (frame-relative coordinates) and have no CDP pointer; a
 * subframe has `window.top !== window`, so it is skipped. This module never
 * touches `chrome.runtime`, so it stays importable (and a no-op) outside a
 * browser page context.
 *
 * @module
 */

import type { MouseStep } from './pointer.ts'

const CURSOR_ID = '__dsh_ai_cursor__'
const OVERLAY_Z_INDEX = 2147483647
/** Duration of the transient click ripple. */
const RIPPLE_MS = 520

/** Pointer arrow with its tip at the track origin (0,0), so `translate(x,y)` pins the tip to (x,y). */
const POINTER_SVG =
  '<svg class="dsh-ai-cursor__pointer" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M0 0 L0 18 L5.2 13.8 L8.4 21.4 L11.6 20.1 L8.3 12.6 L15.2 12.6 Z" ' +
  'fill="#6d5ef5" stroke="#0b1026" stroke-width="1.4" stroke-linejoin="round"/></svg>'

const TRACK_TEMPLATE = `${POINTER_SVG}<span class="dsh-ai-cursor__badge">AI</span><span class="dsh-ai-cursor__ripple"></span>`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

class AICursorOverlay {
  private host: HTMLElement | null = null
  private active = false
  /** Monotonic token so a cancelled animation cannot hide a newer one. */
  private animation = 0

  /** Only the top frame may host the visual cursor. */
  private supported(): boolean {
    return typeof document !== 'undefined'
      && typeof window !== 'undefined'
      && window.top === window
  }

  private shadow(): ShadowRoot | null {
    return this.host?.shadowRoot ?? null
  }

  private track(): HTMLElement | null {
    return this.shadow()?.querySelector<HTMLElement>('.dsh-ai-cursor__track') ?? null
  }

  /** Create (or re-create after a navigation) the overlay DOM. */
  private ensureElement(): HTMLElement {
    if (this.host !== null && this.host.isConnected) return this.host
    // A reload/re-injection may have left a stale host in the DOM; drop it so
    // there is never a duplicate id or a lingering pointer someone can see.
    document.getElementById(CURSOR_ID)?.remove()

    const host = document.createElement('div')
    host.id = CURSOR_ID
    host.setAttribute('aria-hidden', 'true')
    // Non-interactive, fixed, out-of-flow, zero-size host. It never moves, so
    // the page never sees a constant stream of attribute mutations.
    host.style.position = 'fixed'
    host.style.top = '0'
    host.style.left = '0'
    host.style.width = '0'
    host.style.height = '0'
    host.style.pointerEvents = 'none'
    host.style.zIndex = String(OVERLAY_Z_INDEX)
    host.style.overflow = 'visible'

    const shadow = host.attachShadow({ mode: 'open' })
    const track = document.createElement('div')
    track.className = 'dsh-ai-cursor__track'
    track.innerHTML = TRACK_TEMPLATE
    // The moving pointer lives in the shadow, so its constant transform/opacity
    // updates are invisible to the page's MutationObserver and to text/snapshot
    // extraction.
    track.style.position = 'absolute'
    track.style.left = '0'
    track.style.top = '0'
    track.style.pointerEvents = 'none'
    track.style.willChange = 'transform'
    track.style.opacity = '0'
    track.style.transition = 'transform 110ms cubic-bezier(.25,.1,.25,1), opacity 140ms ease'
    shadow.appendChild(track)

    const pointer = track.querySelector<SVGElement>('.dsh-ai-cursor__pointer')
    if (pointer !== null) {
      pointer.style.position = 'absolute'
      pointer.style.left = '0'
      pointer.style.top = '0'
      pointer.style.width = '28px'
      pointer.style.height = '28px'
      pointer.style.display = 'block'
      pointer.style.pointerEvents = 'none'
      pointer.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,.35))'
      pointer.style.transition = 'transform 90ms ease'
    }

    const badge = track.querySelector<HTMLElement>('.dsh-ai-cursor__badge')
    if (badge !== null) {
      badge.style.position = 'absolute'
      badge.style.left = '2px'
      badge.style.top = '-10px'
      badge.style.pointerEvents = 'none'
      badge.style.background = '#22d3ee'
      badge.style.color = '#082f49'
      badge.style.font = '700 8px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
      badge.style.padding = '2px 4px'
      badge.style.borderRadius = '5px'
      badge.style.letterSpacing = '.2px'
      badge.style.boxShadow = '0 1px 2px rgba(0,0,0,.3)'
    }

    ;(document.body ?? document.documentElement).appendChild(host)
    this.host = host
    return host
  }

  /** The current host element (null when unsupported / not yet built). For tests. */
  get element(): HTMLElement | null {
    return this.host
  }

  /** True while a cursor session is visible. */
  isActive(): boolean {
    return this.active
  }

  /** Show the cursor (no movement). Safe no-op outside the top frame. */
  show(): void {
    if (!this.supported()) return
    const host = this.ensureElement()
    host.shadowRoot?.querySelector<HTMLElement>('.dsh-ai-cursor__track')?.style.setProperty('opacity', '1')
    this.active = true
  }

  /** Fade the cursor out and tear down the host so nothing lingers in the DOM. */
  hide(): void {
    if (this.host === null) return
    this.host.shadowRoot?.querySelector<HTMLElement>('.dsh-ai-cursor__track')?.style.setProperty('opacity', '0')
    this.host.remove()
    this.host = null
    this.active = false
  }

  /** Position the cursor tip at a viewport CSS pixel (inside the shadow). */
  moveTo(x: number, y: number): void {
    if (!this.active) return
    const track = this.track()
    if (track === null) return
    track.style.transform = `translate(${x}px, ${y}px)`
  }

  /** Pressed highlight: the arrow scales up and brightens. */
  press(): void {
    const pointer = this.shadow()?.querySelector<SVGElement>('.dsh-ai-cursor__pointer') ?? null
    if (pointer === null) return
    pointer.style.transform = 'scale(1.22)'
    pointer.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,.35)) brightness(1.18)'
  }

  /** Release: restore the arrow and emit a transient ripple at the click point. */
  release(): void {
    const pointer = this.shadow()?.querySelector<SVGElement>('.dsh-ai-cursor__pointer') ?? null
    if (pointer !== null) {
      pointer.style.transform = 'scale(1)'
      pointer.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,.35))'
    }
    this.ripple()
  }

  private ripple(): void {
    const shadow = this.shadow()
    if (shadow === null) return
    const track = this.track()
    if (track === null) return
    for (const existing of track.querySelectorAll('.dsh-ai-cursor__ripple')) existing.remove()
    const ripple = document.createElement('span')
    ripple.className = 'dsh-ai-cursor__ripple'
    ripple.style.position = 'absolute'
    ripple.style.left = '-18px'
    ripple.style.top = '-18px'
    ripple.style.width = '36px'
    ripple.style.height = '36px'
    ripple.style.borderRadius = '50%'
    ripple.style.border = '2px solid rgba(109,94,245,.8)'
    ripple.style.pointerEvents = 'none'
    ripple.style.transform = 'scale(.2)'
    ripple.style.opacity = '.85'
    ripple.style.transition = `transform ${RIPPLE_MS}ms ease-out, opacity ${RIPPLE_MS}ms ease-out`
    track.appendChild(ripple)
    // Force a reflow so the transition runs from the initial state to the end state.
    void ripple.offsetWidth
    ripple.style.transform = 'scale(1.6)'
    ripple.style.opacity = '0'
    setTimeout(() => { ripple.remove() }, RIPPLE_MS + 10)
  }

  /**
   * Play a pointer plan as a visual progression over the same coordinates (and
   * the same `pauseAfterMs` rhythm) the plan carries, so the on-screen cursor
   * tracks the agent's pointer. When the plan finishes the cursor STAYS parked
   * at the last step's position instead of being torn down, so a human can keep
   * watching where the agent's pointer landed after an action completes. Running
   * it is fire-and-forget from the action's perspective; it is intentionally
   * NOT awaited by dispatch, so the overlay never gates the action or the
   * humanized event sequence (and a plan with no visual change is a no-op).
   */
  async play(steps: MouseStep[]): Promise<void> {
    if (!this.supported() || steps.length === 0) return
    this.show()
    const token = ++this.animation
    const first = steps[0]!
    this.moveTo(first.x, first.y)
    for (const step of steps) {
      // A newer plan started: stop animating the stale one (the new one owns
      // the cursor now).
      if (token !== this.animation) return
      switch (step.type) {
        case 'mouseMoved':
          this.moveTo(step.x, step.y)
          break
        case 'mousePressed':
          this.moveTo(step.x, step.y)
          this.press()
          break
        case 'mouseReleased':
          this.moveTo(step.x, step.y)
          this.release()
          break
        case 'mouseWheel':
          // Keep the pointer parked on the anchor while the page scrolls under it.
          this.moveTo(step.x, step.y)
          break
      }
      const pause = step.pauseAfterMs ?? 0
      if (pause > 0) await sleep(pause)
    }
    // The cursor stays hovering at the last step's coordinates. It is NOT hidden
    // here: the overlay's whole purpose is for a human to keep seeing where the
    // agent's pointer landed after a move/click completes. Cleanup (if any) is
    // left to the page lifetime (a reload that re-injects, or the DOM releasing
    // the host) rather than a new timeout, per the design constraint.
  }
}

/** Shared singleton for the whole content script. */
export const pointerOverlay = new AICursorOverlay()
