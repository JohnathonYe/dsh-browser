// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { installPointerCdpMock, type PointerCdpMock } from './pointer-mock.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

function offscreenRect(): DOMRect {
  return {
    top: 1200, left: 0, right: 100, bottom: 1300, width: 100, height: 100, x: 0, y: 1200,
    toJSON: () => ({}),
  } as DOMRect
}

let pointerMock: PointerCdpMock | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  pointerMock = installPointerCdpMock(true)
})

afterEach(() => {
  pointerMock?.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('humanized hover', () => {
  it('sends a real cursor plan over the element and returns a reported status', async () => {
    document.body.innerHTML = '<button title="Tooltip">提交</button>'
    const button = document.querySelector('button')!
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_hover', { index: ids.indexOf(button) }, {
      ids,
      budget: BUDGET,
    })
    await vi.advanceTimersByTimeAsync(1_000)

    const result = await pending
    expect(result.text).toContain('Hovered')
    expect(pointerMock!.sendMessage).toHaveBeenCalled()
    const plan = pointerMock!.captured[0]!
    const moves = plan.steps.filter((step) => step.type === 'mouseMoved')
    expect(moves.length).toBeGreaterThan(5)
  })
})

describe('humanized slider drag', () => {
  it('sends a mousePressed/mouseMoved/mouseReleased cursor drag and commits the value', async () => {
    document.body.innerHTML = '<input type="range" min="0" max="100" value="20">'
    const range = document.querySelector<HTMLInputElement>('input[type="range"]')!
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
    const plan = pointerMock!.captured[0]!
    const types = plan.steps.map((step) => step.type)
    expect(types).toContain('mousePressed')
    expect(types).toContain('mouseMoved')
    expect(types).toContain('mouseReleased')
  })
})

describe('visible-before-operate', () => {
  it('scrolls an off-viewport input into view, then focuses it with a real click before typing', async () => {
    document.body.innerHTML = '<input aria-label="Email">'
    const input = document.querySelector('input')!
    input.getBoundingClientRect = offscreenRect
    const scroll = vi.fn()
    Object.defineProperty(input, 'scrollIntoView', { value: scroll, configurable: true })
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_type', { index: ids.indexOf(input), text: 'a@b.example' }, {
      ids,
      budget: BUDGET,
    })
    // ensureInViewport runs synchronously before any await.
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
    await vi.advanceTimersByTimeAsync(500)
    await pending
    // The type action sends a real CDP click to focus the field before writing.
    expect(pointerMock!.sendMessage).toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('a@b.example')
  })
})

describe('humanized scroll', () => {
  it('scrolls the requested distance fast with one or two real wheel ticks through the cursor plan', async () => {
    document.body.innerHTML = '<main>Long page</main>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_scroll', { direction: 'down', amount: 120 }, {
      ids,
      budget: BUDGET,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(result.text).toContain('Scrolled down')
    const plan = pointerMock!.captured[0]!
    const wheels = plan.steps.filter((step) => step.type === 'mouseWheel')
    // A fast scroll: one or two large wheel ticks (previously a slow 6-segment crawl).
    expect(wheels.length).toBeGreaterThanOrEqual(1)
    expect(wheels.length).toBeLessThanOrEqual(2)
    expect(wheels.every((step) => (step.deltaY ?? 0) > 0)).toBe(true)
  })
})

describe('humanized click', () => {
  it('clicks a regular control with a real press/release cursor plan', async () => {
    document.body.innerHTML = '<button>同意</button>'
    const button = document.querySelector('button')!
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_click', { index: ids.indexOf(button) }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(result.text).toContain('Clicked')
    const plan = pointerMock!.captured[0]!
    const types = plan.steps.map((step) => step.type)
    expect(types).toContain('mousePressed')
    expect(types).toContain('mouseReleased')
  })
})
