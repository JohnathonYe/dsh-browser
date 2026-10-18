// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectNativeOption } from '../src/content/select.ts'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

beforeEach(() => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function installSelect(): { select: HTMLSelectElement; changes: string[] } {
  document.body.innerHTML = '<select aria-label="City"><option value="sh">Shanghai</option><option value="bj">Beijing</option><option value="gz">Guangzhou</option></select>'
  const select = document.querySelector('select')!
  const changes: string[] = []
  select.addEventListener('change', () => { changes.push(select.value) })
  return { select, changes }
}

describe('selectNativeOption', () => {
  it('selects by exact value and fires a change event', () => {
    const { select, changes } = installSelect()
    const result = selectNativeOption(select, { value: 'bj' })
    expect(select.value).toBe('bj')
    expect(result.selected).toEqual(['Beijing'])
    expect(changes).toEqual(['bj'])
  })

  it('selects by exact label and by option index', () => {
    const { select } = installSelect()
    expect(selectNativeOption(select, { label: 'Guangzhou' }).selected).toEqual(['Guangzhou'])
    expect(select.value).toBe('gz')
    expect(selectNativeOption(select, { optionIndex: 0 }).selected).toEqual(['Shanghai'])
    expect(select.value).toBe('sh')
  })

  it('rejects an ambiguous label with the candidates in the error', () => {
    document.body.innerHTML = '<select><option>New York</option><option>New Delhi</option></select>'
    const select = document.querySelector('select')!
    expect(() => selectNativeOption(select, { label: 'New' })).toThrow(/matches 2 options/)
  })

  it('selects multiple values for a multiple select', () => {
    document.body.innerHTML = '<select multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>'
    const select = document.querySelector<HTMLSelectElement>('select')!
    const result = selectNativeOption(select, { values: ['a', 'c'] })
    expect([...select.selectedOptions].map((option) => option.value)).toEqual(['a', 'c'])
    expect(result.selected).toEqual(['A', 'C'])
  })
})

describe('browser_select_option action', () => {
  it('selects a native option and reports it', async () => {
    const { select } = installSelect()
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    const result = await runAction('browser_select_option', { index: ids.indexOf(select), value: 'gz' }, { ids, budget: BUDGET })
    expect(select.value).toBe('gz')
    expect(result.text).toContain('Selected "Guangzhou"')
  })

  it('explains the custom-dropdown path for a non-select element', async () => {
    document.body.innerHTML = '<div role="combobox" aria-label="City">Shanghai</div>'
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    const combo = document.querySelector('[role="combobox"]')!
    await expect(runAction('browser_select_option', { index: ids.indexOf(combo), value: 'x' }, { ids, budget: BUDGET }))
      .rejects.toThrow(/click it, call browser_snapshot, then click the option index/)
  })
})
