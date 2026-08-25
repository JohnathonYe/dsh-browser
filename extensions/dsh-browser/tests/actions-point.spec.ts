// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction, ActionError } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

/**
 * Bounds-based action: the AX summary carries real CSS-pixel bounds, so an
 * element may also be acted on at its bounds centre (`point`), giving the model
 * a locator beyond the stable index. The action confirms the landing point via
 * elementFromPoint, exactly like the index path.
 */
describe('browser_click / browser_hover by point (AX bounds)', () => {
  function context() {
    return { ids: new ElementIds(), budget: { maxItems: 10, maxForms: 5, maxChars: 4_000 } }
  }

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).elementFromPoint
  })

  it('clicks at a viewport point and reports the element under that coordinate', async () => {
    document.body.innerHTML = '<button id="ok">Submit</button>'
    const button = document.getElementById('ok')!
    Object.defineProperty(document, 'elementFromPoint', { value: vi.fn(() => button), configurable: true })

    const result = await runAction('browser_click', { point: { x: 120, y: 20 } }, context())
    expectPointNear(result.text, 120, 20)
    expect(result.text).toContain('the element at that coordinate is <button>Submit</button>')
    // No index was required for a bounds-based click.
    expect(result.text).not.toMatch(/Element \[\d+\] does not exist/)
  })

  it('accepts a point as [x, y] and reports the same hit', async () => {
    document.body.innerHTML = '<a href="/v">Video</a>'
    const anchor = document.querySelector('a')!
    Object.defineProperty(document, 'elementFromPoint', { value: vi.fn(() => anchor), configurable: true })

    const result = await runAction('browser_hover', { point: [30, 10] }, context())
    expectPointNear(result.text, 30, 10)
    expect(result.text).toContain('the element at that coordinate is <a>Video</a>')
  })

  it('notes when the coordinate resolves to nothing (blank jsdom layout)', async () => {
    // jsdom has no elementFromPoint by default; the action must still succeed
    // (degrade) and warn the model the point did not resolve to an element.
    document.body.innerHTML = '<div>blank</div>'
    const result = await runAction('browser_click', { point: { x: 40, y: 40 } }, context())
    expect(result.text).toContain('the element at that coordinate is nothing')
    expect(result.text).toContain('resolved to nothing')
  })

  it('rejects a point outside the viewport before acting', async () => {
    const result = await runAction('browser_click', { point: { x: -5, y: 10_000 } }, context()).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(ActionError)
    expect((result as Error).message).toContain('outside the viewport')
  })

  it('still requires an index when no point is supplied', async () => {
    const result = await runAction('browser_click', {}, context()).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(ActionError)
    expect((result as Error).message).toContain('index must be a non-negative integer')
  })
})

/** The reported click/hover coordinate must land within 2px of the requested point (jitter). */
function expectPointNear(text: string, x: number, y: number): void {
  const match = text.match(/\((\d+), (\d+)\)/)
  expect(match).not.toBeNull()
  const rx = Number(match![1])
  const ry = Number(match![2])
  expect(Math.abs(rx - x)).toBeLessThanOrEqual(2)
  expect(Math.abs(ry - y)).toBeLessThanOrEqual(2)
}
