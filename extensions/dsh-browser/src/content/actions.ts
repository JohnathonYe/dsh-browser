/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait, executed in
 * the content script against the real page (preserving login state), each
 * returning a short text status. Navigations return a fresh full snapshot
 * because the document — and the id registry — reset.
 *
 * All action results are pure text (DeepSeek models have no vision), so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import { accessibleName, collectInteractive, pageText, truncate } from './extract.ts'
import { findDom } from './find.ts'
import type { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'
import type { AxNodeInput } from '../ax-shared.ts'
import { buildSnapshot, renderSnapshot, roleOf } from './snapshot.ts'
import { selectNativeOption, type SelectResult } from './select.ts'
import { waitForCondition } from './wait-for.ts'
import { collectAxCandidates } from './ax.ts'
import {
  buildKeySteps,
  buildTypeSteps,
  selectAllSteps,
  sendKeyStepsToCdp,
} from './keyboard.ts'
import {
  clickElement,
  confirmElementHit,
  type ClickOptions,
  describeElementAt,
  dragFromTo,
  elementAtPoint,
  elementCenter,
  elementRandomPoint,
  ensureInViewport,
  hoverElement,
  humanWheelScroll,
  movePointerTo,
} from './movement.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
  /** Absolute ceiling on the whole settle wait, independent of the observer.
   *  Guards against a page whose mutations keep re-scheduling the quiet check
   *  so no timer ever observes the `maxAfterReadyMs`/`timeoutMs` escapes; the
   *  wait returns the current state instead of holding until the host tool
   *  budget (90s) expires. */
  maxSettleMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000, maxSettleMs: 12_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000, maxSettleMs: 12_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000, maxSettleMs: 12_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000, maxSettleMs: 12_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000

/** Runtime fallback ceiling for a policy built without an explicit maxSettleMs. */
const DEFAULT_MAX_SETTLE_MS = 12_000

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    // An absolute watchdog that is NOT clearable by `schedule`. The observer
    // re-schedules `check` on every mutation, which on a continuously-updating
    // page (an infinite feed, an animated dashboard) can keep `check` from ever
    // observing the `maxAfterReadyMs`/`timeoutMs` escapes, stalling the action
    // until the host tool budget. This timer is independent, so it always fires
    // and returns the current state instead of spinning to the 90s cap.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      if (watchdog !== undefined) clearTimeout(watchdog)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
    watchdog = setTimeout(() => finish(true), policy.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Append a stale-index resolution note to a result built by a helper. */
function withResolution(result: ActionResult, note: string | undefined): ActionResult {
  return note === undefined ? result : { ...result, text: `${result.text} ${note}` }
}

/** A resolved action target, with a note when a stale index was healed. */
interface TargetResolution {
  element: Element
  index: number
  note?: string
}

/** The role/name an index had in the last snapshot, used to re-find it. */
function lastIdentity(index: number): { role: string; name: string } | undefined {
  if (lastSnapshot === null) return undefined
  const item = lastSnapshot.items.find((candidate) => candidate.index === index)
  if (item !== undefined) return { role: item.role, name: item.name }
  const ax = lastSnapshot.axItems.find((candidate) => candidate.index === index)
  return ax === undefined ? undefined : { role: ax.role, name: ax.name }
}

/** Current candidates that still carry the recorded role + accessible name. */
function sameIdentity(role: string, name: string): Element[] {
  const candidates = [...collectInteractive(document), ...collectAxCandidates(document)]
  const seen = new Set<Element>()
  const matches: Element[] = []
  for (const element of candidates) {
    if (seen.has(element)) continue
    seen.add(element)
    if (roleOf(element) !== role) continue
    if (accessibleName(element) !== name) continue
    matches.push(element)
  }
  return matches
}

/**
 * Resolve an action index. If the element detached or the index vanished after
 * a page update, re-find the same role + accessible name in the current DOM
 * and return the element's new stable index. When several elements match, fail
 * with their current indices instead of clicking a guess. `fallbackText`
 * (optional) locates by visible/accessibility name when the index is entirely
 * unknown.
 */
function resolveTarget(ids: ElementIds, index: number | undefined, fallbackText?: string): TargetResolution {
  if (index !== undefined) {
    const element = ids.elementByIndex(index)
    const identity = lastIdentity(index)
    // A registered element that was never snapshotted (or has no recorded
    // identity) is still usable; only a removed element with a known
    // role/name is treated as a stale index to heal.
    if (element !== undefined && (element.isConnected || identity === undefined)) {
      return { element, index }
    }
    if (identity !== undefined) {
      const matches = sameIdentity(identity.role, identity.name)
      if (matches.length === 1) {
        const resolved = matches[0]!
        const next = ids.register(resolved)
        return {
          element: resolved,
          index: next,
          note: `Index [${index}] was stale after the page changed; re-resolved to [${next}] by ${identity.role} "${identity.name}".`,
        }
      }
      if (matches.length > 1) {
        const choices = matches.slice(0, 8).map((candidate) => {
          const id = ids.register(candidate)
          return `[${id}] ${identity.role} "${identity.name}"`
        })
        throw new ActionError(
          'action-failed',
          `Index [${index}] was stale and ${matches.length} current elements match ${identity.role} "${identity.name}": ${choices.join(', ')}. Act on one of those indices, or call browser_snapshot for the current layout.`,
        )
      }
    }
  }
  if (fallbackText !== undefined && fallbackText.trim() !== '') {
    const needle = fallbackText.trim().toLowerCase()
    const candidates = [...collectInteractive(document), ...collectAxCandidates(document)]
    const seen = new Set<Element>()
    const exact: Element[] = []
    const partial: Element[] = []
    for (const element of candidates) {
      if (seen.has(element)) continue
      seen.add(element)
      const name = accessibleName(element).toLowerCase()
      if (name === needle) exact.push(element)
      else if (name.includes(needle)) partial.push(element)
    }
    const matches = exact.length > 0 ? exact : partial
    if (matches.length === 1) {
      const element = matches[0]!
      const next = ids.register(element)
      return { element, index: next, note: `Located [${next}] by text "${fallbackText}".` }
    }
    if (matches.length > 1) {
      const choices = matches.slice(0, 8).map((candidate) => `[${ids.register(candidate)}] ${roleOf(candidate)} "${accessibleName(candidate)}"`)
      throw new ActionError(
        'action-failed',
        `Text "${fallbackText}" matches ${matches.length} elements: ${choices.join(', ')}. Use one of those indices.`,
      )
    }
  }
  throw new ActionError(
    'action-failed',
    index === undefined
      ? 'No target index or text was provided. Call browser_snapshot and pass an index.'
      : `Element [${index}] is gone and could not be re-resolved after the page changed. Call browser_snapshot for current indices.`,
  )
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** React-compatible value write: native setter + input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** A slider/range control we drag rather than click. */
function isRangeElement(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'range'
}

/** Read a range's min/max, tolerant of blank or `any` values. */
function rangeBounds(input: HTMLInputElement): { min: number; max: number } {
  const min = input.min === '' || input.min === undefined ? 0 : Number(input.min)
  const max = input.max === '' || input.max === undefined ? 100 : Number(input.max)
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) && max > min ? max : 100 }
}

/** Clamp and snap a target value to a range's min/max/step. */
function clampRangeValue(input: HTMLInputElement, value: number): number {
  const { min, max } = rangeBounds(input)
  const step = input.step === '' || input.step === undefined ? 1 : Number(input.step)
  let clamped = Math.min(max, Math.max(min, value))
  if (Number.isFinite(step) && step > 0) {
    clamped = Math.round((clamped - min) / step) * step + min
    clamped = Math.min(max, Math.max(min, clamped))
  }
  return clamped
}

/** The value corresponding to the element's centre (where a click cursor lands). */
function rangeClickValue(input: HTMLInputElement): number {
  const { min, max } = rangeBounds(input)
  return clampRangeValue(input, (min + max) / 2)
}

/** Pixel X on the track for a given value. */
function rangeValueToX(input: HTMLInputElement, value: number): number {
  const rect = input.getBoundingClientRect()
  const { min, max } = rangeBounds(input)
  const fraction = (value - min) / (max - min || 1)
  return rect.left + Math.max(0, Math.min(1, fraction)) * rect.width
}

/** Humanized slider drag: mousedown on the thumb, step mousemove, mouseup, then commit the value. */
async function dragRangeTo(input: HTMLInputElement, targetValue: number): Promise<void> {
  const target = clampRangeValue(input, targetValue)
  const center = elementCenter(input)
  // Small vertical jitter keeps the thumb press inside the track while never
  // landing on the exact midline every time.
  const yJitter = (Math.random() - 0.5) * input.getBoundingClientRect().height * 0.4
  const from = { x: rangeValueToX(input, Number(input.value) || 0), y: center.y + yJitter }
  const to = { x: rangeValueToX(input, target), y: center.y + yJitter }
  await dragFromTo(input, from, to, { steps: 7 })
  setNativeValue(input, String(target))
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_hover':
      return hoverAction(args, ctx)
    case 'browser_drag':
      return dragAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_select_option':
      return selectOptionAction(args, ctx)
    case 'browser_wait_for':
      return waitForAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args)
    case 'browser_find_dom':
      return findDomAction(args, ctx)
    case 'browser_get_dom':
      return getDomAction(args)
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  // Server-supplied AX semantic nodes (fetched via the debugger transport). The
  // model locates rich components by their AX role/name/bounds; when absent the
  // snapshot falls back to the DOM inventory untouched.
  const axNodes = Array.isArray(args.axNodes)
    ? args.axNodes as AxNodeInput[]
    : undefined
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(
    ctx.ids,
    { delta, region, budget: ctx.budget, ...axNodes !== undefined ? { axNodes } : {} },
    lastSnapshot,
  )
  lastSnapshot = view
  return { text: renderSnapshot(view, delta) }
}

/** Module-level last snapshot state for delta mode (content-script lifetime). */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** Invalidate delta state after navigation (new document). */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext): ActionResult {
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
  }
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const point = pointArg(args)
  const clickOptions = clickOptionsArg(args)
  if (point !== undefined) return clickAtCoordinates(point, clickOptions, ctx)
  const indexArg = args.index === undefined ? undefined : numberArg(args, 'index')
  const resolution = resolveTarget(ctx.ids, indexArg, typeof args.text === 'string' ? args.text : undefined)
  const el = resolution.element
  const index = resolution.index
  const resolved = (text: string): string => resolution.note === undefined ? text : `${text} ${resolution.note}`
  // Never operate on an off-screen target: bring it into the viewport first.
  ensureInViewport(el)
  const plainLeftClick = clickOptions.button === 'left' && clickOptions.clickCount === 1 && clickOptions.modifiers === 0
  if (el instanceof HTMLAnchorElement && plainLeftClick) {
    // Humanized pointer: glide the REAL cursor along a curve to a random point
    // on the link so the page sees the arrival + `:hover`. Activation stays on
    // the existing logic below (a cross-document CDP press/release would race
    // the content script unload, and the link semantics are preserved here).
    await movePointerTo(el)
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: resolved(`Clicked link [${index}] using native browser activation. Call browser_snapshot to read the resulting state.`),
        }
      }
      // Dispatch the click handlers without its default navigation so a
      // client-side router can cancel synchronously and keep this document.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(resolved(`Clicked link [${index}].`), ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(resolved(`Clicked link [${index}].`), ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: resolved(`Clicked link [${index}]. Call browser_snapshot again after navigation settles.`),
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: resolved(`Clicked link [${index}]. The link may open outside the controlled frame.`) }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button [${index}] is disabled.`)
  }
  if (isRangeElement(el)) {
    // A slider/range is driven by dragging, not by a plain click: the drag
    // plan itself glides the real pointer to the thumb and drags it.
    const value = rangeClickValue(el)
    await dragRangeTo(el, value)
    await waitForPageSettled(ACTION_SETTLE)
    return withPageDelta(resolved(`Dragged slider [${index}] to ${value}.`), ctx)
  }
  // Real pointer: glide to a random point on the element, press, release. The
  // renderer synthesizes a genuine click (and `:active`), which synthetic
  // dispatchEvent can never do. Falls back to synthetic events only when CDP
  // input is unavailable. Before acting, confirm the landing coordinate hits the
  // target element (via document.elementFromPoint); the result names the element
  // under that point so the model can verify the pointer actually reached it.
  const target = elementRandomPoint(el)
  const hitInfo = confirmElementHit(el, target.x, target.y)
  await clickElement(el, { at: target, ...clickOptions })
  await waitForPageSettled(ACTION_SETTLE)
  const at = describeElementAt(hitInfo.under)
  const confirmNote = hitInfo.hit ? '' : ' Note: the coordinate did not resolve to the target element itself (it may be covered or mis-located).'
  return withPageDelta(resolved(`${clickVerb(clickOptions)} [${index}]. The pointer landed at (${Math.round(target.x)}, ${Math.round(target.y)}); the element at that coordinate is ${at}.${confirmNote}`), ctx)
}

/** Parse the button/clickCount/modifiers arguments into a CDP click plan. */
function clickOptionsArg(args: Record<string, unknown>): Required<ClickOptions> {
  const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left'
  const clickCount = typeof args.clickCount === 'number' && Number.isInteger(args.clickCount)
    ? Math.min(Math.max(args.clickCount, 1), 3)
    : 1
  let modifiers = 0
  if (Array.isArray(args.modifiers)) {
    for (const raw of args.modifiers) {
      if (typeof raw !== 'string') continue
      const token = raw.trim().toLowerCase()
      if (token === 'alt' || token === 'option') modifiers |= 1
      else if (token === 'control' || token === 'ctrl') modifiers |= 2
      else if (token === 'meta' || token === 'cmd' || token === 'command') modifiers |= 4
      else if (token === 'shift') modifiers |= 8
      else throw new ActionError('bad-args', `Unknown modifier "${raw}". Use Alt, Control, Meta, or Shift.`)
    }
  }
  return { button, clickCount, modifiers }
}

/** Model-facing verb for the click that actually happened. */
function clickVerb(options: Required<ClickOptions>): string {
  const base = options.button === 'right'
    ? 'Right-clicked'
    : options.button === 'middle'
      ? 'Middle-clicked'
      : options.clickCount >= 2 ? 'Double-clicked' : 'Clicked'
  const held = [
    options.modifiers & 4 ? 'Meta' : '',
    options.modifiers & 2 ? 'Control' : '',
    options.modifiers & 1 ? 'Alt' : '',
    options.modifiers & 8 ? 'Shift' : '',
  ].filter((name) => name !== '')
  return held.length === 0 ? base : `${base} with ${held.join('+')} held`
}

/**
 * Put the caret at the end of an editable element without changing its value.
 * `browser_type` without `replace` appends, which must not depend on where the
 * focusing click happened to land.
 */
function placeCaretAtEnd(el: Element): void {
  try {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.setSelectionRange(el.value.length, el.value.length)
      return
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  } catch {
    // Input types without a selection API (number/date in some engines) ignore
    // this; the real key events still land wherever the field places the caret.
  }
}

/** The current editable value of a field or contenteditable host. */
function editableValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  return el.textContent ?? ''
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const indexArg = args.index === undefined ? undefined : numberArg(args, 'index')
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const submit = args.submit === true
  const resolution = resolveTarget(ctx.ids, indexArg)
  const el = resolution.element
  const index = resolution.index
  const resolved = (status: string): string => resolution.note === undefined ? status : `${status} ${resolution.note}`
  ensureInViewport(el)
  const contentEditable = el instanceof HTMLElement && el.isContentEditable
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || contentEditable)) {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  if (el instanceof HTMLInputElement && (el.readOnly || el.disabled)) {
    throw new ActionError('action-failed', `Element [${index}] is ${el.disabled ? 'disabled' : 'read-only'} and cannot be edited.`)
  }
  if (el instanceof HTMLTextAreaElement && (el.readOnly || el.disabled)) {
    throw new ActionError('action-failed', `Element [${index}] is ${el.disabled ? 'disabled' : 'read-only'} and cannot be edited.`)
  }
  if (el instanceof HTMLInputElement) {
    const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'])
    if (!textTypes.has(el.type)) {
      throw new ActionError(
        'action-failed',
        `Element [${index}] is <input type="${el.type}">, which browser_type cannot type into. Use browser_click, browser_select_option, browser_drag, or browser_upload_file instead.`,
      )
    }
  }
  const owningForm = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.form : null
  if (submit && owningForm === null) {
    throw new ActionError('action-failed', `Element [${index}] is not inside a form, so submit=true has nothing to submit.`)
  }
  // Focus the field with a real click so the page sees a focused caret and the
  // keyboard plan below lands on the right control. The click also opens any
  // widget affordances (date pickers, custom editors) exactly like a person.
  try { await clickElement(el) } catch { /* focus via CDP failed; fall through */ }
  try { (el as HTMLElement).focus() } catch { /* some fields refuse focus; keyboard/value write still applies */ }
  // A real click lands at a random point and may place the caret mid-text.
  // `replace:false` means "append", so move the caret to the end before typing.
  if (!replace) placeCaretAtEnd(el)

  const before = editableValue(el)
  // Replace = select all, delete, then type. This is the same path a person
  // uses and keeps React/Vue controlled inputs (and contenteditable editors)
  // in their own event flow instead of mutating `value` behind their back.
  const steps = [
    ...replace ? [...selectAllSteps(), ...buildKeySteps('Backspace')] : [],
    ...buildTypeSteps(text),
  ]
  const viaCdp = await sendKeyStepsToCdp(steps)
  let synthetic = !viaCdp
  if (viaCdp) {
    // Give the page's input/validation handlers one frame to commit. If the
    // field still looks untouched, the control rejected real keystrokes (some
    // date/number widgets do) and the native value write below recovers.
    await sleep(16)
    if (editableValue(el) !== before || text === '') {
      await waitForPageSettled(TYPE_SETTLE)
      if (submit) return withResolution(submitTyped(el, text, index, replace), resolution.note)
      return withPageDelta(
        resolved(`Typed ${text.length} characters into [${index}] with real keyboard events${replace ? ' (replaced existing text)' : ''}.`),
        ctx,
      )
    }
    synthetic = true
  }
  if (contentEditable) {
    if (replace) el.textContent = ''
    el.textContent = `${el.textContent ?? ''}${text}`
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  if (submit) return withResolution(submitTyped(el, text, index, replace), resolution.note)
  return withPageDelta(
    resolved(`Entered ${text.length} characters into [${index}]${synthetic ? ' using the synthetic value fallback (real keyboard input was unavailable)' : ''}.`),
    ctx,
  )
}

/**
 * Submit the form owning a just-typed field. Answer first and submit in the
 * next task: a cross-document submit would unload this content script and
 * destroy the response port before the tool result is delivered.
 */
function submitTyped(el: Element, text: string, index: number, replace: boolean): ActionResult {
  const form = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.form : null
  if (form === null) {
    throw new ActionError('action-failed', `Element [${index}] is not inside a form, so there is nothing to submit.`)
  }
  setTimeout(() => { form.requestSubmit() }, 0)
  return {
    text: `Typed ${text.length} characters into [${index}]${replace ? ' (replacing existing text)' : ''} and submitted its form. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

/** Modifier flags for the synthetic fallback, derived from a CDP key plan. */
function modifierFlags(steps: ReturnType<typeof buildKeySteps>): { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean } {
  const main = [...steps].reverse().find((step) => step.type === 'keyDown' || step.type === 'rawKeyDown')
  const mask = main?.modifiers ?? 0
  return {
    altKey: (mask & 1) !== 0,
    ctrlKey: (mask & 2) !== 0,
    metaKey: (mask & 4) !== 0,
    shiftKey: (mask & 8) !== 0,
  }
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const extraModifiers = Array.isArray(args.modifiers)
    ? (args.modifiers as unknown[]).filter((value): value is string => typeof value === 'string')
    : []
  let steps: ReturnType<typeof buildKeySteps>
  try {
    steps = buildKeySteps(key, extraModifiers)
  } catch (error: unknown) {
    throw new ActionError('bad-args', error instanceof Error ? error.message : String(error))
  }
  const viaCdp = await sendKeyStepsToCdp(steps)
  if (!viaCdp) {
    // Synthetic fallback: keep the same event sequence shape for pages and
    // jsdom, even though it cannot reproduce OS-level focus traversal.
    const flags = modifierFlags(steps)
    const main = [...steps].reverse().find((step) => step.type === 'keyDown' || step.type === 'rawKeyDown')
    const eventKey = main?.key ?? key
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { key: eventKey, bubbles: true, cancelable: true, ...flags }))
    target.dispatchEvent(new KeyboardEvent('keyup', { key: eventKey, bubbles: true, cancelable: true, ...flags }))
    if (eventKey === 'Enter' && target instanceof HTMLInputElement && target.form !== null) {
      target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(
    `Pressed "${key}"${extraModifiers.length > 0 ? ` with ${extraModifiers.join('+')}` : ''}${viaCdp ? ' as a real keyboard event' : ' (synthetic fallback)'}.`,
    ctx,
  )
}

async function waitForAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector : undefined
  const text = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : undefined
  const urlContains = typeof args.urlContains === 'string' && args.urlContains !== '' ? args.urlContains : undefined
  if (selector === undefined && text === undefined && urlContains === undefined) {
    throw new ActionError('bad-args', 'browser_wait_for requires selector, text, or urlContains.')
  }
  const state = args.state === 'hidden' ? 'hidden' : 'visible'
  const outcome = await waitForCondition({
    ...selector === undefined ? {} : { selector },
    ...text === undefined ? {} : { text },
    ...urlContains === undefined ? {} : { urlContains },
    state,
    ...args.ignoreCase === false ? { ignoreCase: false } : {},
    ...typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {},
  }, ctx.ids)
  if (!outcome.matched) {
    throw new ActionError(
      'action-failed',
      `Timed out after ${outcome.elapsedMs}ms waiting for ${outcome.description}. Call browser_snapshot to inspect the current page state.`,
    )
  }
  const index = outcome.element === undefined ? undefined : ctx.ids.indexOf(outcome.element)
  return withPageDelta(
    `Waited ${outcome.elapsedMs}ms: ${outcome.description}${index === undefined ? '' : ` matched element [${index}]`}.`,
    ctx,
  )
}

async function selectOptionAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const indexArg = args.index === undefined ? undefined : numberArg(args, 'index')
  const resolution = resolveTarget(ctx.ids, indexArg)
  const el = resolution.element
  const index = resolution.index
  const resolved = (status: string): string => resolution.note === undefined ? status : `${status} ${resolution.note}`
  ensureInViewport(el)
  if (!(el instanceof HTMLSelectElement)) {
    throw new ActionError(
      'action-failed',
      `Element [${index}] is not a native <select>. For a custom dropdown, click it, call browser_snapshot, then click the option index.`,
    )
  }
  const values = Array.isArray(args.values)
    ? (args.values as unknown[]).filter((value): value is string => typeof value === 'string')
    : undefined
  const request = {
    ...typeof args.value === 'string' ? { value: args.value } : {},
    ...typeof args.label === 'string' ? { label: args.label } : {},
    ...typeof args.optionIndex === 'number' && Number.isInteger(args.optionIndex) ? { optionIndex: args.optionIndex } : {},
    ...values !== undefined && values.length > 0 ? { values } : {},
  }
  if (request.value === undefined && request.label === undefined && request.optionIndex === undefined && request.values === undefined) {
    throw new ActionError('bad-args', 'Provide value, label, optionIndex, or values to choose an option.')
  }
  let result: SelectResult
  try {
    result = selectNativeOption(el, request)
  } catch (error: unknown) {
    throw new ActionError('action-failed', error instanceof Error ? error.message : String(error))
  }
  await waitForPageSettled(ACTION_SETTLE)
  const chosen = result.selected.length === 0 ? '(nothing)' : result.selected.map((label) => `"${label}"`).join(', ')
  return withPageDelta(
    resolved(`Selected ${chosen} in [${index}]${result.multiple ? ' (multiple)' : ''} using the select\'s own input/change events.`),
    ctx,
  )
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  let delta: number
  switch (direction) {
    case 'top':
      delta = -window.scrollY
      break
    case 'bottom':
      delta = document.documentElement.scrollHeight - window.scrollY
      break
    case 'up':
      delta = -amount
      break
    case 'down':
      delta = amount
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  // FAST scroll: park the real cursor on a humanized non-center anchor (a
  // short glide) then cover the requested distance with one or two real wheel
  // ticks, so the page still receives genuine wheel events without the slow
  // multi-segment crawl. `humanWheelScroll` falls back to a direct scrollBy
  // when CDP input is unavailable.
  await humanWheelScroll(delta)
  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.`, ctx)
}

async function hoverAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const point = pointArg(args)
  if (point !== undefined) return hoverAtCoordinates(point, ctx)
  const indexArg = args.index === undefined ? undefined : numberArg(args, 'index')
  const resolution = resolveTarget(ctx.ids, indexArg, typeof args.text === 'string' ? args.text : undefined)
  const el = resolution.element
  const index = resolution.index
  const resolved = (status: string): string => resolution.note === undefined ? status : `${status} ${resolution.note}`
  ensureInViewport(el)
  // Move the REAL pointer over a random point on the element and let
  // :hover-driven affordances (tooltips, dropdown previews) render before the
  // model decides whether to click. Confirm the landing coordinate hits the
  // target element and name the element under it so the model can verify.
  const target = elementRandomPoint(el)
  const hitInfo = confirmElementHit(el, target.x, target.y)
  await hoverElement(el, { at: target })
  await waitForPageSettled(ACTION_SETTLE)
  const at = describeElementAt(hitInfo.under)
  const confirmNote = hitInfo.hit ? '' : ' Note: the coordinate did not resolve to the target element itself (it may be covered or mis-located).'
  return withPageDelta(
    resolved(`Hovered [${index}]. The pointer is over (${Math.round(target.x)}, ${Math.round(target.y)}); the element at that coordinate is ${at}. Call browser_snapshot to read any hover effect.${confirmNote}`),
    ctx,
  )
}

async function dragAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const indexArg = args.index === undefined ? undefined : numberArg(args, 'index')
  const resolution = resolveTarget(ctx.ids, indexArg)
  const el = resolution.element
  const index = resolution.index
  const resolved = (status: string): string => resolution.note === undefined ? status : `${status} ${resolution.note}`
  ensureInViewport(el)
  if (isRangeElement(el)) {
    const value = typeof args.value === 'number' && Number.isFinite(args.value) ? args.value : undefined
    if (value === undefined) {
      throw new ActionError('bad-args', 'value is required to drag a slider/range element.')
    }
    await dragRangeTo(el, value)
    await waitForPageSettled(ACTION_SETTLE)
    return withPageDelta(resolved(`Dragged slider [${index}] to ${clampRangeValue(el, value)}.`), ctx)
  }
  const dx = typeof args.dx === 'number' && Number.isFinite(args.dx) ? args.dx : 0
  const dy = typeof args.dy === 'number' && Number.isFinite(args.dy) ? args.dy : 0
  if (dx === 0 && dy === 0) {
    throw new ActionError('bad-args', 'Provide value (for a slider/range) or dx/dy (for a generic drag).')
  }
  // Grab a random point on the element (a hand never takes the exact centre),
  // then drag by the requested delta with the real pointer.
  const from = elementRandomPoint(el)
  await dragFromTo(el, from, { x: from.x + dx, y: from.y + dy }, { steps: 7 })
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(resolved(`Dragged [${index}] by (${dx}, ${dy}).`), ctx)
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
  const truncated = truncate(text, 8_000)
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters.)` : '') }
}

/** 读取元素完整原始 outerHTML（不剥离/不脱敏），供「难处理场景」直接取完整 DOM 片段（如完整 href、data-* 属性）。 */
async function getDomAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  if (selector === undefined) throw new ActionError('bad-args', 'browser_get_dom requires a selector.')
  const source = document.querySelector(selector)
  if (source === null) throw new ActionError('action-failed', `No element matched selector: ${selector}`)
  const html = source.outerHTML
  const maxChars = typeof args.maxChars === 'number' && Number.isInteger(args.maxChars) ? Math.min(Math.max(args.maxChars, 1_000), 40_000) : 16_000
  if (html.length <= maxChars) return { text: html }
  return {
    text: html.slice(0, maxChars) + `\n…(browser_get_dom truncated; full element length ${html.length})`,
  }
}

async function findDomAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const keyword = typeof args.keyword === 'string' ? args.keyword : ''
  if (keyword.trim() === '') throw new ActionError('bad-args', 'keyword must not be empty.')
  const mode = args.mode === 'css' ? 'css' : 'text'
  const root = typeof args.root === 'string' && args.root !== '' ? args.root : undefined
  const count = typeof args.count === 'number' && Number.isInteger(args.count) ? args.count : undefined
  const text = findDom(keyword, { mode, root, count }, ctx.ids)
  return { text }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  if (ms > 0) await sleep(ms)
  return withPageDelta(`The page is stable${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`, ctx)
}

/** A viewport point {x,y} from the click/hover `point` argument (AX bounds centre). */
function pointArg(args: Record<string, unknown>): { x: number; y: number } | undefined {
  const point = args.point
  if (typeof point === 'object' && point !== null && !Array.isArray(point)) {
    const record = point as Record<string, unknown>
    const x = record.x
    const y = record.y
    if (typeof x === 'number' && typeof y === 'number') return { x, y }
  }
  if (Array.isArray(point) && point.length >= 2 && typeof point[0] === 'number' && typeof point[1] === 'number') {
    return { x: point[0], y: point[1] }
  }
  return undefined
}

/** Small random jitter so a bounds-centre click never lands dead on the centre. */
function jitterPoint(point: { x: number; y: number }): { x: number; y: number } {
  const jitter = 3
  return { x: point.x + (Math.random() - 0.5) * jitter, y: point.y + (Math.random() - 0.5) * jitter }
}

/** Click at a raw viewport point (the AX bounds centre of a snapshot item). */
async function clickAtCoordinates(point: { x: number; y: number }, clickOptions: Required<ClickOptions>, ctx: ActionContext): Promise<ActionResult> {
  const target = jitterPoint(point)
  if (target.x < 0 || target.y < 0 || target.x > window.innerWidth || target.y > window.innerHeight) {
    throw new ActionError('action-failed', 'The point is outside the viewport; scroll to bring it into view first.')
  }
  const under = elementAtPoint(target.x, target.y)
  // No registered element exists for a raw coordinate; fall back to the page so
  // the humanized plan still has a synthetic target when CDP input is absent.
  await clickElement(under ?? (document.body ?? document.documentElement), { at: target, ...clickOptions })
  await waitForPageSettled(ACTION_SETTLE)
  const at = describeElementAt(under)
  const confirmNote = under === null ? ' Note: the coordinate resolved to nothing (page background or blank area).' : ''
  return withPageDelta(`${clickVerb(clickOptions)} at (${Math.round(target.x)}, ${Math.round(target.y)}); the element at that coordinate is ${at}.${confirmNote}`, ctx)
}

/** Hover at a raw viewport point (the AX bounds centre of a snapshot item). */
async function hoverAtCoordinates(point: { x: number; y: number }, ctx: ActionContext): Promise<ActionResult> {
  const target = jitterPoint(point)
  if (target.x < 0 || target.y < 0 || target.x > window.innerWidth || target.y > window.innerHeight) {
    throw new ActionError('action-failed', 'The point is outside the viewport; scroll to bring it into view first.')
  }
  const under = elementAtPoint(target.x, target.y)
  await hoverElement(under ?? (document.body ?? document.documentElement), { at: target })
  await waitForPageSettled(ACTION_SETTLE)
  const at = describeElementAt(under)
  const confirmNote = under === null ? ' Note: the coordinate resolved to nothing (page background or blank area).' : ''
  return withPageDelta(`Hovered at (${Math.round(target.x)}, ${Math.round(target.y)}); the element at that coordinate is ${at}. Call browser_snapshot to read any hover effect.${confirmNote}`, ctx)
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
