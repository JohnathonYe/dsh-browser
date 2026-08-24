// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

function offscreenRect(): DOMRect {
  return {
    top: 1200, left: 0, right: 100, bottom: 1300, width: 100, height: 100, x: 0, y: 1200,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('humanized hover', () => {
  it('dispatches mouseover/mousemove on the element and returns a reported status', async () => {
    document.body.innerHTML = '<button title="Tooltip">提交</button>'
    const button = document.querySelector('button')!
    const dispatch = vi.spyOn(button, 'dispatchEvent')
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_hover', { index: ids.indexOf(button) }, {
      ids,
      budget: BUDGET,
    })
    await vi.advanceTimersByTimeAsync(1_000)

    const result = await pending
    expect(result.text).toContain('Hovered')
    const types = dispatch.mock.calls.map(([event]) => (event as Event).type)
    expect(types).toContain('mouseover')
    expect(types).toContain('mousemove')
  })
})

describe('humanized slider drag', () => {
  it('drags a range input with mouse events and commits the target value', async () => {
    document.body.innerHTML = '<input type="range" min="0" max="100" value="20">'
    const range = document.querySelector<HTMLInputElement>('input[type="range"]')!
    const dispatch = vi.spyOn(range, 'dispatchEvent')
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_drag', { index: ids.indexOf(range), value: 80 }, {
      ids,
      budget: BUDGET,
    })
    await vi.advanceTimersByTimeAsync(1_000)

    const result = await pending
    expect(result.text).toContain('Dragged slider')
    expect(range.value).toBe('80')
    const types = dispatch.mock.calls.map(([event]) => (event as Event).type)
    expect(types).toContain('mousedown')
    expect(types).toContain('mousemove')
    expect(types).toContain('mouseup')
  })
})

describe('visible-before-operate', () => {
  it('scrolls an off-viewport input into view before typing', async () => {
    document.body.innerHTML = '<input aria-label="Email">'
    const input = document.querySelector('input')!
    input.getBoundingClientRect = offscreenRect
    const scroll = vi.fn()
    Object.defineProperty(input, 'scrollIntoView', { value: scroll, configurable: true })
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    // The synchronous part of typeAction runs first: ensureInViewport scrolls
    // and the value is written before the settle wait. Assert that, then let
    // the settle timer finish.
    const pending = runAction('browser_type', { index: ids.indexOf(input), text: 'a@b.example' }, {
      ids,
      budget: BUDGET,
    })
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
    expect((input as HTMLInputElement).value).toBe('a@b.example')
    await vi.advanceTimersByTimeAsync(200)
    await pending
  })
})

describe('humanized scroll', () => {
  it('applies scrolling as multiple wheel ticks rather than one jump', async () => {
    document.body.innerHTML = '<main>Long page</main>'
    const scrollBy = vi.fn()
    vi.spyOn(window, 'scrollBy').mockImplementation(scrollBy)
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    const pending = runAction('browser_scroll', { direction: 'down', amount: 120 }, {
      ids: new ElementIds(),
      budget: BUDGET,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await pending

    expect(scrollBy).toHaveBeenCalled()
    expect(scrollBy.mock.calls.length).toBeGreaterThan(2)
    const wheel = dispatch.mock.calls.filter(([event]) => (event as Event).type === 'wheel')
    expect(wheel.length).toBeGreaterThan(2)
  })
})
