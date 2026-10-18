// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { installKeyboardCdpMock, type KeyboardCdpMock } from './keyboard-mock.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

let keyboardMock: KeyboardCdpMock | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  keyboardMock = installKeyboardCdpMock(true)
})

afterEach(() => {
  keyboardMock?.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** Run one action and let its settle/sleep timers finish. */
async function act(name: string, args: Record<string, unknown>, ids: ElementIds) {
  const pending = runAction(name, args, { ids, budget: BUDGET })
  await vi.advanceTimersByTimeAsync(1_000)
  return pending
}

describe('browser_type uses real keyboard events', () => {
  it('types through DSH_INPUT_KEY and reports the real path', async () => {
    document.body.innerHTML = '<input aria-label="Email">'
    const input = document.querySelector('input')!
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const result = await act('browser_type', { index: ids.indexOf(input), text: 'hello' }, ids)

    expect(keyboardMock!.captured).toHaveLength(1)
    const steps = keyboardMock!.captured[0]!
    expect(steps[0]).toMatchObject({ type: 'keyDown', key: 'h', code: 'KeyH', text: 'h' })
    expect(input.value).toBe('hello')
    expect(result.text).toContain('real keyboard events')
    expect(result.text).not.toContain('fallback')
  })

  it('clears first when replace=true instead of appending to the old value', async () => {
    document.body.innerHTML = '<input aria-label="Name" value="old">'
    const input = document.querySelector<HTMLInputElement>('input')!
    input.value = 'old'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const result = await act('browser_type', { index: ids.indexOf(input), text: 'new', replace: true }, ids)

    expect(input.value).toBe('new')
    expect(result.text).toContain('replaced existing text')
    const steps = keyboardMock!.captured[0]!
    expect(steps.some((step) => (step.type === 'keyDown' || step.type === 'rawKeyDown') && step.key === 'a' && ((step.modifiers ?? 0) & 6) !== 0)).toBe(true)
    expect(steps.some((step) => step.type === 'rawKeyDown' && step.key === 'Backspace')).toBe(true)
  })

  it('falls back to the native value write when the key transport fails', async () => {
    keyboardMock!.setOk(false)
    document.body.innerHTML = '<input aria-label="Email">'
    const input = document.querySelector('input')!
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const result = await act('browser_type', { index: ids.indexOf(input), text: 'fallback' }, ids)

    expect(input.value).toBe('fallback')
    expect(result.text).toContain('synthetic value fallback')
  })

  it('refuses non-text input types with the right alternative tool', async () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Accept">'
    const checkbox = document.querySelector('input')!
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    await expect(runAction('browser_type', { index: ids.indexOf(checkbox), text: 'yes' }, { ids, budget: BUDGET }))
      .rejects.toThrow(/browser_type cannot type into/)
  })

  it('submits the owning form after typing when submit=true', async () => {
    document.body.innerHTML = '<form><input aria-label="Search"></form>'
    const input = document.querySelector('input')!
    const form = document.querySelector('form')!
    const submit = vi.spyOn(form, 'requestSubmit').mockImplementation(() => {})
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const result = await act('browser_type', { index: ids.indexOf(input), text: 'query', submit: true }, ids)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(result.navigationPending).toBe(true)
    expect(result.text).toContain('submitted its form')
  })
})

describe('browser_press uses real keyboard events', () => {
  it('sends one combination plan and reports it', async () => {
    document.body.innerHTML = '<input aria-label="Search">'
    const input = document.querySelector('input')!
    input.focus()
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    const result = await act('browser_press', { key: 'Control+Shift+Enter' }, ids)

    const steps = keyboardMock!.captured[0]!
    expect(steps[0]).toMatchObject({ type: 'rawKeyDown', key: 'Control', modifiers: 2 })
    expect(steps.some((step) => step.type === 'rawKeyDown' && step.key === 'Enter' && step.modifiers === 10)).toBe(true)
    expect(result.text).toContain('real keyboard event')
  })

  it('reports synthetic fallback and still carries modifier flags', async () => {
    keyboardMock!.setOk(false)
    document.body.innerHTML = '<input aria-label="Search">'
    const input = document.querySelector('input')!
    input.focus()
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })

    let observed: KeyboardEvent | undefined
    input.addEventListener('keydown', (event) => { observed = event as KeyboardEvent })
    const result = await act('browser_press', { key: 'Meta+A' }, ids)

    expect(result.text).toContain('synthetic fallback')
    expect(observed?.key).toBe('a')
    expect(observed?.metaKey).toBe(true)
  })
})
