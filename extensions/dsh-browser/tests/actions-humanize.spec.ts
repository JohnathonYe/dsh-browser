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
  it('dispatches real wheel ticks through the cursor plan rather than one jump', async () => {
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
    expect(wheels.length).toBeGreaterThan(2)
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

describe('coordinate click (browser_click_at)', () => {
  it('clicks at the confirmed viewport pixel with a real press/release cursor plan', async () => {
    document.body.innerHTML = '<button style="position:absolute;top:100px;left:100px">坐标</button>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const pending = runAction('browser_click_at', { x: 150, y: 120 }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(result.text).toContain('Clicked at (150, 120)')
    const plan = pointerMock!.captured[0]!
    const types = plan.steps.map((step) => step.type)
    expect(types).toContain('mouseMoved')
    expect(types).toContain('mousePressed')
    expect(types).toContain('mouseReleased')
    // The tap stays near the requested pixel (default ±4px jitter).
    const press = plan.steps.find((step) => step.type === 'mousePressed')!
    expect(Math.abs(press.x - 150)).toBeLessThanOrEqual(4)
    expect(Math.abs(press.y - 120)).toBeLessThanOrEqual(4)
  })

  it('rejects a non-finite coordinate', async () => {
    const ids = new ElementIds()
    await expect(runAction('browser_click_at', { x: 'left', y: 120 }, { ids, budget: BUDGET })).rejects.toThrow()
    expect(pointerMock!.sendMessage).not.toHaveBeenCalled()
  })
})
