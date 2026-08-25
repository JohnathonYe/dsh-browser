/**
 * Content-side AX semantic summary: given an AX node list (fetched by the
 * background over the debugger transport), resolve each node to a live DOM
 * element, register it in the stable id registry, measure its real bounds and
 * viewport membership in a single batch, and produce the indexable semantic
 * inventory the model locates by.
 *
 * The AX tree is the locator, not a derived heuristic: role/name come from
 * the browser's accessibility layer (so rich components like YT
 * `ytd-rich-item-renderer` video cards surface as `link`/`heading` nodes with
 * their real accessible name), while bounds come from `getBoundingClientRect`
 * on the resolved element. If a node cannot be resolved to a live element it
 * stays as an unmatched semantic note (never indexed, so a stale index can
 * never be clicked into an unrelated element). If no AX input is provided the
 * caller falls back to the DOM inventory untouched.
 *
 * @module
 */

import { accessibleName, isVisible } from './extract.ts'
import { ElementIds } from './ids.ts'
import {
  filterSemanticRoles,
  normalizeName,
  normalizeText,
  type AxNodeInput,
} from '../ax-shared.ts'

/** A measured semantic item: indexable, geometry from the live element. */
export interface AxItem {
  /** Stable id (ElementIds) — the same address the DOM inventory and click/hover use. */
  index: number
  role: string
  name: string
  bounds: AxBounds
  inViewport: boolean
  href?: string
  disabled?: boolean
  checked?: boolean
}

/** Real CSS-pixel bounds of a node (browser layout, not a screenshot guess). */
export interface AxBounds {
  x: number
  y: number
  w: number
  h: number
}

/** A resolved AX summary for one snapshot. */
export interface AxSummary {
  items: AxItem[]
  /** Role-filtered nodes that did not resolve to a live element (surfaced, not indexed). */
  unmatched: AxNodeInput[]
  /** Nodes dropped by the budget cap. */
  omitted: number
}

/** Max characters of one rendered AX name. */
const MAX_AX_NAME_CHARS = 80

const CARDISH_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role]',
  '[tabindex]',
  'summary',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(', ')

/** Structure roles that are semantic landmarks, surfaced even though not clickable. */
const LANDMARK_SELECTOR = [
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'nav',
].join(', ')

/** Trim an AX name to the rendering cap. */
function clipName(name: string): string {
  if (name.length <= MAX_AX_NAME_CHARS) return name
  return `${name.slice(0, MAX_AX_NAME_CHARS)}…`
}

/** Convert a live rect to the model-facing bounds shape. */
export function toBounds(rect: DOMRect): AxBounds {
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

/** Whether a rect intersects the current viewport. */
export function rectInViewport(rect: DOMRect): boolean {
  return rect.bottom >= 0 && rect.top <= window.innerHeight
    && rect.right >= 0 && rect.left <= window.innerWidth
}

/**
 * Broadened candidate scan for AX resolution. Covers the interactive set plus
 * semantic landmarks, and includes `[role]`/`[tabindex]` so rich components
 * that Chromium's AX layer exposes as `button`/`link` (but which carry no
 * hand-written marker) are still resolvable to a live element.
 */
export function collectAxCandidates(root: Document | Element): Element[] {
  const seen = new Set<Element>()
  const result: Element[] = []
  const push = (el: Element): void => {
    if (seen.has(el)) return
    seen.add(el)
    if (el instanceof HTMLElement && !isVisible(el)) return
    result.push(el)
  }
  if (typeof root.querySelectorAll !== 'function') return result
  for (const el of root.querySelectorAll(CARDISH_SELECTOR)) push(el)
  for (const el of root.querySelectorAll(LANDMARK_SELECTOR)) push(el)
  return result
}

/**
 * Resolve an AX node to a live element by matching role + accessible name
 * against the candidate set. This is a best-effort resolver: the AX role and
 * the browser-computed accessible name are authoritative, so a candidate whose
 * content-computed accessible name matches is adopted. When several candidates
 * could match, the first in document order wins (closest to the AX tree's
 * ordering for a single match).
 */
export function resolveAxNodeToElement(node: AxNodeInput, candidates: Element[]): Element | null {
  const wantedRole = normalizeRole(node.role)
  const wantedName = normalizeName(node.name)
  if (wantedName === '') return null
  let fallback: Element | null = null
  for (const el of candidates) {
    const candidateRole = roleOf(el)
    const candidateName = normalizeText(accessibleName(el))
    if (wantedName === candidateName) {
      if (wantedRole !== '') {
        if (wantedRole === candidateRole) return el
        if (fallback === null) fallback = el
      } else {
        return el
      }
    }
  }
  return fallback
}

/** Normalise a CDP/explicit role to the content role vocabulary. */
function normalizeRole(role: string): string {
  return role.trim().toLowerCase()
}

/** Content-side role label for a candidate (mirrors snapshot.roleOf). */
function roleOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role.trim().toLowerCase()
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      default: return 'textbox'
    }
  }
  if (el instanceof HTMLSelectElement) return 'combobox'
  if (el instanceof HTMLTextAreaElement) return 'textbox'
  if (el instanceof HTMLHeadingElement) return 'heading'
  if (el instanceof HTMLLIElement) return 'listitem'
  if (el instanceof HTMLElement && el.isContentEditable) return 'textbox'
  return el.tagName.toLowerCase()
}

/**
 * Build the AX semantic summary: filter roles, resolve each node to an element
 * (registering it in `ids`), measure bounds + viewport in one pass, cap by
 * budget, and keep unmatched nodes as non-indexed semantic notes.
 */
export function buildAxSummary(
  nodes: readonly AxNodeInput[],
  resolve: (node: AxNodeInput) => Element | null,
  ids: ElementIds,
  budget: number,
): AxSummary {
  const interesting = filterSemanticRoles(nodes)
  const items: AxItem[] = []
  const unmatched: AxNodeInput[] = []
  let omitted = 0

  for (const node of interesting) {
    const element = resolve(node)
    if (element === null) {
      unmatched.push(node)
      continue
    }
    // Register the resolved element so click/hover by index reach it. A node
    // that maps to an already-inventoried element reuses its id — the shared
    // address space keeps the DOM inventory and the AX inventory consistent.
    let index = ids.indexOf(element)
    if (index === undefined) {
      index = ids.register(element)
    }
    if (items.length >= budget) {
      omitted += 1
      continue
    }
    const rect = element.getBoundingClientRect()
    const item: AxItem = {
      index,
      role: node.role,
      name: clipName(node.name),
      bounds: toBounds(rect),
      inViewport: rectInViewport(rect),
    }
    // Prefer the live element's own state over the AX projection; the AX node
    // values are a fallback so a partially-informative tree still works.
    if (node.href !== undefined) item.href = node.href
    else if (element instanceof HTMLAnchorElement && element.href !== '') item.href = element.href
    if (element instanceof HTMLButtonElement && element.disabled) item.disabled = true
    else if (node.disabled === true) item.disabled = true
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) item.checked = element.checked
    const ariaChecked = element.getAttribute('aria-checked')
    if (ariaChecked === 'true' || ariaChecked === 'false') item.checked = ariaChecked === 'true'
    else if (node.checked !== undefined) item.checked = node.checked
    items.push(item)
  }

  return { items, unmatched, omitted }
}

/** Convenience builder: scan the document once, resolve all interesting nodes. */
export function buildAxSummaryInDocument(
  nodes: readonly AxNodeInput[],
  ids: ElementIds,
  budget: number,
  root: Document | Element = document,
): AxSummary {
  const candidates = collectAxCandidates(root)
  const resolve = (node: AxNodeInput): Element | null => resolveAxNodeToElement(node, candidates)
  return buildAxSummary(nodes, resolve, ids, budget)
}

/** Re-export the role set so snapshot/background share one vocabulary. */
export { AX_INTERESTING_ROLES, filterSemanticRoles } from '../ax-shared.ts'
