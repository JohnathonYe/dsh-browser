// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import { findDom } from '../src/content/find.ts'
import { collectInteractive } from '../src/content/extract.ts'

describe('findDom', () => {
  it('reports index, bounds and full href so a caller can act without a screenshot', () => {
    document.body.innerHTML = '<a href="/checkout">结算</a>'
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 12, y: 34, left: 12, top: 34, right: 212, bottom: 74, width: 200, height: 40,
      toJSON: () => ({}) as unknown as DOMRect,
    } as DOMRect)
    const ids = new ElementIds()
    const text = findDom('结算', { mode: 'text' }, ids)
    expect(text).toContain('bounds: @(12,34 200x40)')
    expect(text).toContain('href: /checkout')
    expect(text).toContain(`index: ${ids.indexOf(document.querySelector('a')!)}`)
    vi.restoreAllMocks()
  })

  it('keeps the whole offerId on a tracking-heavy marketplace link', () => {
    const offerId = '937525327193'
    const href = `http://detail.m.1688.com/page/index.html?offerId=${offerId}`
      + `&trace_log=${'x'.repeat(400)}`
    document.body.innerHTML = `<a href="${href}">跨境礼服</a>`
    const ids = new ElementIds()
    const text = findDom('跨境礼服', { mode: 'text' }, ids)
    expect(text).toContain(offerId)
  })

  it('does not retire AX-only indices a snapshot already handed out', () => {
    document.body.innerHTML = '<div id="card" role="group" aria-label="商品卡">卡片</div><button>提交</button>'
    const ids = new ElementIds()
    const card = document.getElementById('card')!
    // The AX inventory admits nodes the DOM heuristic scan misses; a snapshot
    // hands those ids to the model.
    const cardId = ids.register(card)
    // find_dom only ever sees the DOM half of the registry.
    findDom('提交', { mode: 'text' }, ids)
    expect(ids.indexOf(card)).toBe(cardId)
    expect(ids.elementByIndex(cardId)).toBe(card)
    // ...and it still admits the DOM inventory it does see.
    const button = document.querySelector('button')!
    expect(collectInteractive(document)).toContain(button)
    expect(ids.indexOf(button)).toBeTypeOf('number')
  })
})
