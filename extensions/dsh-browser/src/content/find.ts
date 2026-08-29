/**
 * Text → DOM element lookup for the model.
 *
 * The model is "blind": it sees only the text snapshot and cannot write CSS
 * selectors. `find_dom` bridges that gap by taking a keyword the model saw in
 * a snapshot and resolving it to the real DOM element(s), returning an
 * actionable index (the snapshot inventory number), an absolute XPath, and a
 * trimmed context so the model can confirm the hit and act by index.
 *
 * The tool is deliberately read-only: it never mutates the page, and the
 * returned snapshot index is the same one `browser_click/hover(index)` act on.
 *
 * @module
 */

import { accessibleName, clean, collectInteractive, elementText, truncate } from './extract.ts'
import type { ElementIds } from './ids.ts'

/** Upper bound on one find_dom render. */
export const FIND_DOM_MAX_CHARS = 6_000
/** Upper bound on returned matches (the `count` option is clamped to this). */
const MAX_FIND_COUNT = 20
/** Per-match field display budgets. */
const MAX_TEXT_CHARS = 60
const MAX_HREF_CHARS = 60
const MAX_CONTEXT_CHARS = 24

/** find_dom options, mirroring the model-facing `browser_find_dom` parameters. */
export interface FindDomOptions {
  /** 'text' matches visible text (default); 'css' matches a CSS selector. */
  mode?: 'text' | 'css'
  /** CSS selector scoping the search; defaults to the whole document. */
  root?: string
  /** Max matches to return; defaults to 8, clamped to 1..20. */
  count?: number
}

/** An absolute XPath for an element, preferring a concise id/testid/class anchor. */
function xpathOf(el: Element): string {
  const id = el.getAttribute('id')
  if (id !== null && id !== '') return `//*[@id="${cssEscape(id)}"]`
  const testid = el.getAttribute('data-testid')
  if (testid !== null && testid !== '') return `//*[@data-testid="${cssEscape(testid)}"]`
  const cls = shortestClass(el)
  if (cls !== undefined) return `//*[contains(concat(' ', normalize-space(@class), ' '), ' ${cssEscape(cls)} ')]`
  return absolutePath(el)
}

/** The shortest non-empty class (a stable, short anchor when present). */
function shortestClass(el: Element): string | undefined {
  const attr = el.getAttribute('class')
  if (attr === null || attr.trim() === '') return undefined
  const classes = attr.trim().split(/\s+/).filter((part) => part !== '')
  if (classes.length === 0) return undefined
  return classes.sort((a, b) => a.length - b.length)[0]
}

/** Absolute path rooted at `<html>`, using tag + same-tag sibling ordinal. */
function absolutePath(el: Element): string {
  const parts: string[] = []
  let current: Element | null = el
  while (current !== null && current !== document.documentElement) {
    const parent: Element | null = current.parentElement
    if (parent === null) break
    const tag = current.tagName.toLowerCase()
    const sameTag = Array.from(parent.children)
      .filter((child) => child.tagName === tag)
    const ordinal = sameTag.indexOf(current) + 1
    parts.unshift(`${tag}[${ordinal}]`)
    current = parent
  }
  const rootTag = document.documentElement.tagName.toLowerCase()
  return parts.length === 0 ? `/${rootTag}` : `/${rootTag}/${parts.join('/')}`
}

/** CSS.escape with a jsdom-safe fallback (CSS is stubbed in tests). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch: string) => `\\${ch}`)
}

/** Lowercased, whitespace-normalized keyword for matching. */
function normalizeKeyword(keyword: string): string {
  return clean(keyword).toLowerCase()
}

/** Whether cleaned text contains the (already lowercased) keyword. */
function textHit(text: string, keyword: string): boolean {
  if (text === '') return false
  return clean(text).toLowerCase().includes(keyword)
}

/** Collect matches for text mode: text-node parents + accessibility-name hits. */
function collectTextMatches(root: Document | Element, keyword: string): Element[] {
  const matches: Element[] = []
  const seen = new Set<Element>()

  // Primary pass: a text node whose text contains the keyword resolves to its
  // parent element, so a `<button>Submit</button>` returns the button and a
  // `<span>Submit</span>` inside a button returns the span (whose index
  // resolution then walks up to the button). This keeps hits specific rather
  // than returning every enclosing container.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    const textNode = node as Text
    const text = textNode.nodeValue ?? ''
    if (textHit(text, keyword)) {
      const parent = textNode.parentElement
      if (parent !== null && !seen.has(parent)) {
        seen.add(parent)
        matches.push(parent)
      }
    }
    node = walker.nextNode()
  }

  // Secondary pass: elements whose accessibility name (aria-label / label /
  // placeholder / alt / value / title) carries the keyword but which have no
  // matching text node (icon buttons, image links). Only the element that owns
  // the attribute is reported, so a long ancestor whose descendant matches is
  // not re-added. The fallback-to-tag guard avoids treating every element of a
  // tag as a hit just because the tag name happens to contain the keyword.
  for (const el of collectInteractive(root)) {
    if (seen.has(el)) continue
    const name = accessibleName(el)
    if (name === el.tagName.toLowerCase()) continue
    if (name.toLowerCase().includes(keyword)) {
      seen.add(el)
      matches.push(el)
    }
  }

  // Title/alt attribute hits outside the interactive inventory (image links).
  for (const el of root.querySelectorAll('img[alt], [title]')) {
    if (seen.has(el)) continue
    const attributeText = (el.getAttribute('alt') ?? el.getAttribute('title') ?? '').toLowerCase()
    if (attributeText !== '' && attributeText.includes(keyword)) {
      seen.add(el)
      matches.push(el)
    }
  }

  return sortByDocumentOrder(matches)
}

/** Collect matches for CSS mode (advanced/fallback; caller names the selector). */
function collectCssMatches(root: Document | Element, selector: string): Element[] {
  const trimmed = clean(selector)
  if (trimmed === '') return []
  try {
    return Array.from(root.querySelectorAll(trimmed))
  } catch {
    return []
  }
}

/** Stable document-order sort (jsdom-safe) so matches read top-to-bottom. */
function sortByDocumentOrder(matches: Element[]): Element[] {
  if (matches.length <= 1) return matches
  return [...matches].sort((a, b) => {
    const position = a.compareDocumentPosition(b)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
}

/** Resolve the actionable snapshot index for an element.
 * Uses its own inventory number when it is interactive; otherwise walks up to
 * the nearest interactive ancestor (marked `(ancestor)`); otherwise `none`. */
function resolveIndex(el: Element, ids: ElementIds): string {
  const own = ids.indexOf(el)
  if (own !== undefined) return String(own)
  let node = el.parentElement
  while (node !== null) {
    const ancestorIndex = ids.indexOf(node)
    if (ancestorIndex !== undefined) return `${ancestorIndex} (ancestor)`
    node = node.parentElement
  }
  return 'none'
}

/** A short tag+text snippet used for ancestors and siblings. */
function snippet(el: Element | null): string {
  if (el === null) return '<none>'
  const tag = el.tagName.toLowerCase()
  const text = truncate(clean(elementText(el)), MAX_CONTEXT_CHARS).text
  return text === '' ? tag : `${tag} "${text}"`
}

/** The up-to-3-level chain of ancestors, nearest first. */
function ancestorsSnippet(el: Element): string {
  const levels: string[] = []
  let node = el.parentElement
  while (node !== null && levels.length < 3) {
    levels.push(snippet(node))
    node = node.parentElement
  }
  return levels.length === 0 ? '<none>' : levels.join(' › ')
}

/** A compact href headline (same-origin path, else host+path). */
function hrefHeadline(href: string): string {
  try {
    const url = new URL(href, document.baseURI)
    // 模拟人操作：跨域链接也保留完整 URL（含查询串参数），不剥离任何信息，便于用完整地址导航。
    return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href
  } catch {
    return href
  }
}

/** Budgeted render: cap mid-block truncation at the last complete line. */
function capRendered(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const lastNewline = slice.lastIndexOf('\n')
  const cut = lastNewline > maxChars * 0.6 ? lastNewline : maxChars
  return `${slice.slice(0, cut)}\n…(truncated to the find_dom character budget)`
}

/** Render the match inventory as model-facing text. */
function renderFind(matches: Element[], keyword: string, mode: string, count: number, ids: ElementIds): string {
  const lines: string[] = []
  lines.push(`Found ${matches.length} matching element(s) for "${truncate(keyword, 40).text}" (${mode} mode)`)
  const shown = matches.slice(0, count)
  for (let index = 0; index < shown.length; index += 1) {
    const el = shown[index]!
    const matchedText = clean(elementText(el) || accessibleName(el))
    const block: string[] = []
    block.push(`Match ${index + 1}:`)
    block.push(`  text: ${truncate(matchedText, MAX_TEXT_CHARS).text || '<empty>'}`)
    block.push(`  index: ${resolveIndex(el, ids)}`)
    block.push(`  xpath: ${xpathOf(el)}`)
    block.push(`  tag: ${el.tagName.toLowerCase()}`)
    if (el instanceof HTMLAnchorElement && el.href !== '') {
      block.push(`  href: ${truncate(hrefHeadline(el.href), MAX_HREF_CHARS).text}`)
    }
    block.push(`  ancestors: ${ancestorsSnippet(el)}`)
    block.push(`  siblings: prev ${snippet(el.previousElementSibling)} / next ${snippet(el.nextElementSibling)}`)
    lines.push(block.join('\n'))
  }
  const remaining = matches.length - shown.length
  if (remaining > 0) lines.push(`... (${remaining} more match${remaining === 1 ? '' : 'es'})`)
  return capRendered(lines.join('\n'), FIND_DOM_MAX_CHARS)
}

/**
 * Resolve a model-visible keyword to matching DOM elements.
 *
 * Reconciles the id registry against the current interactive inventory first,
 * so `browser_click/hover(index)` act on the SAME numbering a snapshot uses.
 *
 * @param keyword - the text (or CSS selector in css mode) to search for.
 * @param opts - mode/root/count overrides.
 * @param ids - the stable element id registry (one per content-script lifetime).
 * @returns the rendered find_dom text.
 */
export function findDom(keyword: string, opts: FindDomOptions, ids: ElementIds): string {
  const mode = opts.mode === 'css' ? 'css' : 'text'
  const rawCount = typeof opts.count === 'number' && Number.isInteger(opts.count) ? opts.count : 8
  const count = Math.max(1, Math.min(rawCount, MAX_FIND_COUNT))
  const keywordText = clean(keyword)

  let root: Document | Element = document
  if (opts.root !== undefined && opts.root !== '') {
    const scoped = document.querySelector(opts.root)
    if (scoped === null) return `No element matched root selector "${opts.root}".`
    root = scoped
  }

  // Reconcile the inventory so index resolution matches the snapshot numbering.
  ids.assign(collectInteractive(document))

  const matches = mode === 'css'
    ? collectCssMatches(root, keywordText)
    : collectTextMatches(root, normalizeKeyword(keywordText))

  return renderFind(matches, keywordText, mode, count, ids)
}
