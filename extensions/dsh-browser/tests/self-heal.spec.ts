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
})

afterEach(() => {
  keyboardMock?.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('stale index self-healing', () => {
  it('re-finds a replaced element by role + accessible name and reports the new index', async () => {
    document.body.innerHTML = '<button>Submit</button>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    const staleIndex = ids.indexOf(document.querySelector('button')!)!
    // Replace the element (same role/name, new node) as a re-rendered list would.
    document.body.innerHTML = '<button>Submit</button>'
    const replacement = document.querySelector('button')!
    let clicked = false
    replacement.addEventListener('click', () => { clicked = true })

    const pending = runAction('browser_click', { index: staleIndex }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(clicked).toBe(true)
    expect(result.text).toContain('was stale')
    expect(result.text).toMatch(/re-resolved to \[\d+\]/)
  })

  it('refuses to guess when several elements now share the stale identity', async () => {
    document.body.innerHTML = '<button>Save</button>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    const staleIndex = ids.indexOf(document.querySelector('button')!)!
    document.body.innerHTML = '<button>Save</button><button>Save</button>'

    await expect(runAction('browser_click', { index: staleIndex }, { ids, budget: BUDGET }))
      .rejects.toThrow(/2 current elements match button "Save"/)
  })
})

describe('text locator fallback', () => {
  it('clicks by accessible name when no index is supplied', async () => {
    document.body.innerHTML = '<button>Continue</button>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    const button = document.querySelector('button')!
    let clicked = false
    button.addEventListener('click', () => { clicked = true })

    const pending = runAction('browser_click', { text: 'Continue' }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(clicked).toBe(true)
    expect(result.text).toContain('Located')
    expect(result.text).toContain('by text "Continue"')
  })

  it('reports ambiguous text matches instead of clicking one', async () => {
    document.body.innerHTML = '<button>Delete</button><button>Delete</button>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    await expect(runAction('browser_click', { text: 'Delete' }, { ids, budget: BUDGET }))
      .rejects.toThrow(/matches 2 elements/)
  })

  it('types into a re-rendered field when the old index is gone', async () => {
    keyboardMock = installKeyboardCdpMock(true)
    document.body.innerHTML = '<input aria-label="Email">'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    const staleIndex = ids.indexOf(document.querySelector('input')!)!
    document.body.innerHTML = '<input aria-label="Email">'
    const replacement = document.querySelector<HTMLInputElement>('input')!

    const pending = runAction('browser_type', { index: staleIndex, text: 'a@b.c' }, { ids, budget: BUDGET })
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(replacement.value).toBe('a@b.c')
    expect(result.text).toContain('was stale')
  })
})
