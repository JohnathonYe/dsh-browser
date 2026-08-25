// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import {
  buildAxSummary,
  buildAxSummaryInDocument,
  collectAxCandidates,
  filterSemanticRoles,
  resolveAxNodeToElement,
  toBounds,
  type AxItem,
} from '../src/content/ax.ts'
import type { AxNodeInput } from '../src/ax-shared.ts'

const BUDGET = 12

function rectAt(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top,
    right: left + width, bottom: top + height,
    width, height,
    toJSON: () => ({}) as unknown as DOMRect,
  } as DOMRect
}

describe('filterSemanticRoles', () => {
  it('keeps actionable and semantic roles and drops generic text', () => {
    const nodes: AxNodeInput[] = [
      { role: 'button', name: '提交' },
      { role: 'link', name: 'Video Title' },
      { role: 'heading', name: 'Section' },
      { role: 'listitem', name: 'Item 1' },
      { role: 'text', name: 'plain paragraph' },
      { role: 'generic', name: 'some div' },
    ]
    const kept = filterSemanticRoles(nodes)
    expect(kept.map((node) => node.role)).toEqual(['button', 'link', 'heading', 'listitem'])
  })
})

describe('resolveAxNodeToElement', () => {
  it('matches an AX link node to a real anchor by role + accessible name', () => {
    document.body.innerHTML = '<a href="/watch?v=1">A Video Title</a><button>提交</button>'
    const candidates = collectAxCandidates(document)
    const resolved = resolveAxNodeToElement({ role: 'link', name: 'A Video Title' }, candidates)
    expect(resolved).toBeInstanceOf(HTMLAnchorElement)
    expect(resolved?.textContent).toBe('A Video Title')
  })

  it('favours an exact role+name over a same-name different-role candidate', () => {
    document.body.innerHTML = '<button>Save</button><a href="x">Save</a>'
    const candidates = collectAxCandidates(document)
    const resolved = resolveAxNodeToElement({ role: 'link', name: 'Save' }, candidates)
    expect(resolved).toBeInstanceOf(HTMLAnchorElement)
  })

  it('returns null when no candidate matches the name (unresolvable node)', () => {
    document.body.innerHTML = '<button>Only Button</button>'
    const candidates = collectAxCandidates(document)
    expect(resolveAxNodeToElement({ role: 'link', name: 'No Such Node' }, candidates)).toBeNull()
  })
})

describe('toBounds', () => {
  it('maps a live rect to model-facing CSS-pixel bounds', () => {
    const bounds = toBounds(rectAt(10, 20, 100, 40))
    expect(bounds).toEqual({ x: 10, y: 20, w: 100, h: 40 })
  })
})

describe('buildAxSummary', () => {
  it('assigns a stable index reusing an already-inventoried element', () => {
    document.body.innerHTML = '<a href="/v">The Video</a>'
    const anchor = document.querySelector<HTMLAnchorElement>('a')!
    const ids = new ElementIds()
    // Simulate the DOM inventory already having registered this anchor.
    ids.register(anchor)

    const nodes: AxNodeInput[] = [{ role: 'link', name: 'The Video' }]
    const candidates = collectAxCandidates(document)
    const summary = buildAxSummary(nodes, (node) => resolveAxNodeToElement(node, candidates), ids, BUDGET)

    expect(summary.items).toHaveLength(1)
    expect(summary.items[0]!.index).toBe(ids.indexOf(anchor))
    expect(ids.indexOf(anchor)).toBe(ids.indexOf(anchor))
    expect(summary.unmatched).toHaveLength(0)
  })

  it('registers an AX-only element so index → element works for click/hover', () => {
    // A "video card": an <a> with only an aria-label (no visible text), which is
    // still resolvable; verify the id registry can map it back for clicking.
    document.body.innerHTML = '<a href="/v" aria-label="The Video Title"><img alt="thumb"></a>'
    const card = document.querySelector<HTMLAnchorElement>('a')!
    const ids = new ElementIds()
    const nodes: AxNodeInput[] = [{ role: 'link', name: 'The Video Title' }]
    const candidates = collectAxCandidates(document)
    const summary = buildAxSummary(nodes, (node) => resolveAxNodeToElement(node, candidates), ids, BUDGET)

    expect(summary.items).toHaveLength(1)
    const index = summary.items[0]!.index
    expect(ids.elementByIndex(index)).toBe(card)
  })

  it('measures real bounds from the live element (distinct per element)', () => {
    document.body.innerHTML = '<a href="/a">Alpha</a><a href="/b">Beta</a>'
    const links = document.querySelectorAll<HTMLAnchorElement>('a')
    const getRect = (el: Element): DOMRect => rectAt(el.textContent === 'Alpha' ? 0 : 300, 40, 120, 30)
    const proto = Element.prototype.getBoundingClientRect
    for (const link of links) {
      link.getBoundingClientRect = () => getRect(link)
    }
    const ids = new ElementIds()
    const nodes: AxNodeInput[] = [
      { role: 'link', name: 'Alpha' },
      { role: 'link', name: 'Beta' },
    ]
    const candidates = collectAxCandidates(document)
    const summary = buildAxSummary(nodes, (node) => resolveAxNodeToElement(node, candidates), ids, BUDGET)
    expect(proto).toBeTruthy() // keep the import referenced
    expect(summary.items).toHaveLength(2)
    const byName = new Map(summary.items.map((item: AxItem) => [item.name, item.bounds]))
    expect(byName.get('Alpha')).toEqual({ x: 0, y: 40, w: 120, h: 30 })
    expect(byName.get('Beta')).toEqual({ x: 300, y: 40, w: 120, h: 30 })
  })

  it('caps the inventory by budget and reports omitted nodes', () => {
    document.body.innerHTML = Array.from({ length: 20 }, (_, i) => `<a href="/${i}">Link ${i}</a>`).join('')
    const ids = new ElementIds()
    const nodes: AxNodeInput[] = Array.from({ length: 20 }, (_, i) => ({ role: 'link', name: `Link ${i}` }))
    const candidates = collectAxCandidates(document)
    const summary = buildAxSummary(nodes, (node) => resolveAxNodeToElement(node, candidates), ids, 8)
    expect(summary.items).toHaveLength(8)
    expect(summary.omitted).toBe(12)
  })

  it('keeps role-filtered nodes that do not resolve as unmatched (never indexed)', () => {
    document.body.innerHTML = '<button>Known</button>'
    const ids = new ElementIds()
    const nodes: AxNodeInput[] = [
      { role: 'button', name: 'Known' },
      { role: 'heading', name: 'Heading That Has No Element' },
    ]
    const candidates = collectAxCandidates(document)
    const summary = buildAxSummary(nodes, (node) => resolveAxNodeToElement(node, candidates), ids, BUDGET)
    expect(summary.items).toHaveLength(1)
    expect(summary.unmatched).toHaveLength(1)
    expect(summary.unmatched[0]!.role).toBe('heading')
  })

  it('clips long AX names to the render cap', () => {
    document.body.innerHTML = '<a href="/v">node</a>'
    const link = document.querySelector<HTMLAnchorElement>('a')!
    const ids = new ElementIds()
    const nodes: AxNodeInput[] = [{ role: 'link', name: 'N'.repeat(200) }]
    // Inject a direct resolver so the clipping behaviour is tested in isolation
    // from the (content-truncating) accessible-name matching heuristic.
    const summary = buildAxSummary(nodes, (node) => (node.role === 'link' ? link : null), ids, BUDGET)
    expect(summary.items).toHaveLength(1)
    expect(summary.items[0]!.name.length).toBeLessThanOrEqual(81)
    expect(summary.items[0]!.name.endsWith('…')).toBe(true)
  })
})

describe('buildAxSummaryInDocument', () => {
  it('builds a summary directly from the document without a manual resolver', () => {
    document.body.innerHTML = '<a href="/v">The Node</a><h2>A Heading</h2>'
    const ids = new ElementIds()
    const summary = buildAxSummaryInDocument([
      { role: 'link', name: 'The Node' },
      { role: 'heading', name: 'A Heading' },
    ], ids, BUDGET)
    expect(summary.items).toHaveLength(2)
    expect(summary.items[0]!.role).toBe('link')
    expect(summary.items[1]!.role).toBe('heading')
  })
})
