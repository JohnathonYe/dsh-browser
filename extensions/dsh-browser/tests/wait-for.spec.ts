// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForCondition } from '../src/content/wait-for.ts'
import { ElementIds } from '../src/content/ids.ts'
import { runAction } from '../src/content/actions.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

beforeEach(() => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('waitForCondition', () => {
  it('returns as soon as a selector becomes visible instead of polling to the timeout', async () => {
    const ids = new ElementIds()
    const pending = waitForCondition({ selector: '.result', timeoutMs: 2_000 }, ids)
    setTimeout(() => {
      const row = document.createElement('button')
      row.className = 'result'
      row.textContent = 'Ready'
      document.body.append(row)
    }, 30)
    const outcome = await pending
    expect(outcome.matched).toBe(true)
    expect(outcome.elapsedMs).toBeLessThan(1_000)
    expect(outcome.element).toBeInstanceOf(HTMLElement)
    expect(ids.indexOf(outcome.element!)).toBeGreaterThan(0)
  })

  it('waits for text inside a page and honors ignoreCase', async () => {
    const ids = new ElementIds()
    setTimeout(() => { document.body.textContent = '订单 已 提交' }, 20)
    const outcome = await waitForCondition({ text: '已 提交', timeoutMs: 1_000 }, ids)
    expect(outcome.matched).toBe(true)
  })

  it('waits for a URL substring', async () => {
    const ids = new ElementIds()
    history.pushState({}, '', '/before')
    setTimeout(() => { history.pushState({}, '', '/done?ok=1') }, 20)
    const outcome = await waitForCondition({ urlContains: '/done', timeoutMs: 1_000 }, ids)
    expect(outcome.matched).toBe(true)
  })

  it('waits for an element to be hidden or removed', async () => {
    document.body.innerHTML = '<div class="toast">Saved</div>'
    const ids = new ElementIds()
    const toast = document.querySelector('.toast')!
    const pending = waitForCondition({ selector: '.toast', state: 'hidden', timeoutMs: 1_000 }, ids)
    setTimeout(() => { toast.remove() }, 20)
    await expect(pending).resolves.toMatchObject({ matched: true })
  })

  it('reports a timeout when the condition never holds', async () => {
    const ids = new ElementIds()
    const outcome = await waitForCondition({ selector: '.never', timeoutMs: 150 }, ids)
    expect(outcome.matched).toBe(false)
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(140)
  })
})

describe('browser_wait_for action', () => {
  it('returns a matched element index and a readable status', async () => {
    const ids = new ElementIds()
    await runAction('browser_snapshot', {}, { ids, budget: BUDGET })
    setTimeout(() => {
      const button = document.createElement('button')
      button.textContent = '加载完成'
      document.body.append(button)
    }, 20)
    const result = await runAction('browser_wait_for', { selector: 'button', text: '加载完成', timeoutMs: 1_000 }, { ids, budget: BUDGET })
    expect(result.text).toContain('Waited')
    expect(result.text).toMatch(/matched element \[\d+\]/)
  })

  it('throws a snapshot hint on timeout', async () => {
    const ids = new ElementIds()
    const pending = runAction('browser_wait_for', { selector: '.missing', timeoutMs: 120 }, { ids, budget: BUDGET })
    await expect(pending).rejects.toThrow(/Timed out after .*browser_snapshot/)
  })
})
