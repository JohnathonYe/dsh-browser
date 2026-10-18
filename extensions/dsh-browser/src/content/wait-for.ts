/**
 * Deterministic condition waits.
 *
 * `browser_wait` only asks "is the page momentarily quiet?" — useful after an
 * action, useless when the model must wait for a specific result (a row, a
 * toast, a URL change). `browser_wait_for` polls real page state and returns as
 * soon as the requested condition holds, so a lazy list or a redirect costs one
 * short wait instead of guess-and-re-snapshot loops.
 *
 * Conditions are AND-ed: selector (visible/hidden), text, and URL substring.
 *
 * @module
 */

import { clean, elementText, isVisible } from './extract.ts'
import type { ElementIds } from './ids.ts'

/** What to wait for. At least one condition must be present. */
export interface WaitForArgs {
  /** CSS selector to wait for. */
  selector?: string
  /** Substring of visible text (within selector when both are given). */
  text?: string
  /** Substring of the current URL. */
  urlContains?: string
  /** For selector: wait until it is visible (default) or hidden/removed. */
  state?: 'visible' | 'hidden'
  /** Case-insensitive text matching; defaults to true. */
  ignoreCase?: boolean
  /** Upper bound in ms; clamped to 100..15000. Defaults to 5000. */
  timeoutMs?: number
}

/** Outcome of a condition wait. */
export interface WaitOutcome {
  matched: boolean
  elapsedMs: number
  /** Human-readable description of the requested condition. */
  description: string
  /** The matching element, when the condition was selector-based. */
  element?: Element
}

/** Elements that can be addressed by a snapshot index. */
const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],[contenteditable=""]'

/** Clamp a caller timeout to a bounded, predictable range. */
function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 5_000
  return Math.min(15_000, Math.max(100, Math.round(value)))
}

/** Describe what is being waited for, for status and timeout messages. */
function describe(args: WaitForArgs): string {
  const parts: string[] = []
  if (args.selector !== undefined) parts.push(`selector ${JSON.stringify(args.selector)} to be ${args.state === 'hidden' ? 'hidden or removed' : 'visible'}`)
  if (args.text !== undefined) parts.push(`text ${JSON.stringify(args.text)}`)
  if (args.urlContains !== undefined) parts.push(`URL to contain ${JSON.stringify(args.urlContains)}`)
  return parts.join(' and ')
}

/** Evaluate the condition once. */
function evaluate(args: WaitForArgs): { matched: boolean; element?: Element } {
  let scope: Element | null = document.body
  if (args.selector !== undefined) {
    scope = document.querySelector(args.selector)
    if (args.state === 'hidden') {
      if (scope !== null && isVisible(scope)) return { matched: false }
      // Hidden selector alone is a complete condition.
      if (args.text === undefined && args.urlContains === undefined) return { matched: true }
    } else if (scope === null || !isVisible(scope)) {
      return { matched: false }
    }
  }
  if (args.text !== undefined) {
    const haystack = clean(elementText(scope ?? document.body))
    const needle = clean(args.text)
    const ignoreCase = args.ignoreCase !== false
    const found = ignoreCase
      ? haystack.toLowerCase().includes(needle.toLowerCase())
      : haystack.includes(needle)
    if (!found) return { matched: false }
  }
  if (args.urlContains !== undefined && !location.href.includes(args.urlContains)) {
    return { matched: false }
  }
  return { matched: true, ...scope === null ? {} : { element: scope } }
}

/**
 * Wait until the requested condition holds or the timeout expires. A mutation
 * observer re-checks immediately when the DOM changes, so the common case
 * returns in tens of milliseconds instead of a full poll interval.
 */
export function waitForCondition(args: WaitForArgs, ids: ElementIds): Promise<WaitOutcome> {
  const timeout = clampTimeout(args.timeoutMs)
  const description = describe(args)
  const startedAt = performance.now()
  return new Promise((resolve) => {
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let observer: MutationObserver | undefined
    const finish = (matched: boolean, element?: Element): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      resolve({
        matched,
        elapsedMs: Math.round(performance.now() - startedAt),
        description,
        ...element === undefined ? {} : { element },
      })
    }
    const check = (): void => {
      if (finished) return
      const outcome = evaluate(args)
      if (outcome.matched) {
        const element = outcome.element
        if (element !== undefined && element.matches(INTERACTIVE)) ids.register(element)
        finish(true, element)
        return
      }
      const elapsed = performance.now() - startedAt
      if (elapsed >= timeout) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.min(100, Math.max(0, timeout - elapsed)))
    }
    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        if (finished) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(check, 0)
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    check()
  })
}
