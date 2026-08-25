/**
 * Shared, DOM-free AX vocabulary between the background (which fetches the
 * Chromium accessibility tree over the debugger transport) and the content
 * script (which resolves those nodes to live elements and measures bounds).
 *
 * Keeping this module pure (no `document`, no `Element`) lets both bundles
 * import the same role filter and node DTO without pulling one side's DOM
 * helpers into the other, and lets the role filtering be unit-tested without
 * a layout engine.
 *
 * @module
 */

/**
 * A serialisable accessibility node as fetched from `Accessibility.getFullAXTree`.
 * Bounds are intentionally NOT part of this shape: once the content script
 * resolves the node to a live element it measures the real rect in one batch,
 * which is the authoritative geometry (the model never reads pixels off a
 * screenshot and never guesses a CSS selector).
 */
export interface AxNodeInput {
  /** Browser-computed semantic role, e.g. "button", "link", "heading". */
  role: string
  /** Browser-computed accessible name (the semantic label, richer than textContent). */
  name: string
  /** The Chromium backend DOM node id, used only to de-duplicate across fetches. */
  backendDOMNodeId?: number
  /** Present on link/button-like nodes that carry a real target. */
  href?: string
  disabled?: boolean
  checked?: boolean
}

/**
 * Semantic + actionable roles surfaced in the AX inventory. This is broader
 * than "clickable": it also includes the semantic landmarks (heading,
 * listitem, list) the model uses to understand page structure and to locate
 * rich components (video cards, feed items) that resolve to these roles even
 * though the page ships no hand-written marker for them.
 */
export const AX_INTERESTING_ROLES: ReadonlySet<string> = new Set([
  // actionable
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'listbox',
  'menu',
  // semantic structure
  'heading',
  'listitem',
  'list',
  'navigation',
  'form',
  'dialog',
  'alert',
  'article',
  'row',
  'cell',
]) as ReadonlySet<string>

/** Drop AX nodes that carry no interesting role (generic text, separators, etc.). */
export function filterSemanticRoles(nodes: readonly AxNodeInput[]): AxNodeInput[] {
  return nodes.filter((node) => AX_INTERESTING_ROLES.has(node.role))
}

/** True when the node name is non-empty (a nameless button is rarely addressable by name). */
export function hasAxName(node: AxNodeInput): boolean {
  return typeof node.name === 'string' && node.name.trim() !== ''
}

/** Normalise a name for matching (casefold + collapse whitespace). */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Collapse a DOM element's text into the same space used for name matching. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}
