// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  confirmElementHit,
  describeElementAt,
  elementAtPoint,
} from '../src/content/movement.ts'

/**
 * Coordinate→element confirmation unit tests. Locating is DOM-driven: the model
 * locates a target by snapshot index, and the click/hover tools confirm the
 * landing coordinate resolves back to the intended element via
 * `document.elementFromPoint`. These tests cover that hit-test readback.
 *
 * jsdom has no layout engine and does not define `document.elementFromPoint`, so
 * the hit-check degrades to `hit:false` with a warning; the resolution and
 * hit-check logic are exercised directly by stubbing the property.
 */
describe('coordinate→element confirmation (DOM-first)', () => {
  /** jsdom lacks `document.elementFromPoint`; define it per-test and remove after. */
  function stubElementFromPoint(returnValue: Element | null): () => void {
    const mock = vi.fn().mockReturnValue(returnValue)
    Object.defineProperty(document, 'elementFromPoint', { value: mock, configurable: true })
    return () => { delete (document as unknown as Record<string, unknown>).elementFromPoint }
  }

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).elementFromPoint
  })

  it('names a target element at a coordinate via elementFromPoint', () => {
    document.body.innerHTML = '<button id="submit">Submit</button>'
    const button = document.getElementById('submit')!
    stubElementFromPoint(button)
    expect(elementAtPoint(120, 20)).toBe(button)
    // The readback describes the element under the coordinate so the model can
    // verify the pointer reached the intended target.
    expect(describeElementAt(elementAtPoint(120, 20))).toBe('<button>Submit</button>')
  })

  it('describes the page background and a null hit', () => {
    expect(describeElementAt(document.body)).toBe('page background')
    expect(describeElementAt(document.documentElement)).toBe('page background')
    expect(describeElementAt(null)).toBe('nothing')
  })

  it('reports hit:true when the point resolves to the target or one of its descendants', () => {
    document.body.innerHTML = '<div id="card"><button id="inner">OK</button></div>'
    const card = document.getElementById('card')!
    const inner = document.getElementById('inner')!
    stubElementFromPoint(inner)
    // The tap point is inside the card's subtree, so it counts as a hit.
    expect(confirmElementHit(card, 12, 40)).toMatchObject({ x: 12, y: 40, hit: true, under: inner })
  })

  it('reports hit:false when elementFromPoint resolves to a different element (covered/mislocated)', () => {
    document.body.innerHTML = '<div id="target">Target</div><div id="overlay">Overlay</div>'
    const target = document.getElementById('target')!
    const overlay = document.getElementById('overlay')!
    stubElementFromPoint(overlay)
    const hit = confirmElementHit(target, 12, 40)
    expect(hit.hit).toBe(false)
    expect(hit.under).toBe(overlay)
  })

  it('reports hit:false when jsdom has no layout engine (elementFromPoint unavailable)', () => {
    // A real jsdom elementFromPoint is undefined; the confirmation must degrade
    // to hit:false (a warning to the model) rather than throwing, and the
    // click/hover action still proceeds (the humanized CDP plan is the executor).
    document.body.innerHTML = '<button id="submit">Submit</button>'
    const button = document.getElementById('submit')!
    const hit = confirmElementHit(button, 120, 20)
    expect(hit.hit).toBe(false)
    expect(hit.under).toBeNull()
  })
})
