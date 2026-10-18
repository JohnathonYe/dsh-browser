// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { buildKeySteps, buildTypeSteps, primaryModifier, selectAllSteps, sendKeyStepsToCdp, type KeyStep } from '../src/content/keyboard.ts'

/** Compact projection of a plan for assertions. */
function plan(steps: KeyStep[]): string[] {
  return steps.map((step) => {
    if (step.type === 'insertText') return `insertText:${step.text}`
    return `${step.type}:${step.key}:${step.code}:${step.modifiers ?? 0}:${step.text ?? ''}`
  })
}

describe('buildTypeSteps', () => {
  it('types a printable character as a real keyDown/keyUp pair', () => {
    expect(plan(buildTypeSteps('a'))).toEqual([
      'keyDown:a:KeyA:0:a',
      'keyUp:a:KeyA:0:',
    ])
  })

  it('marks shifted characters so the page sees Shift held', () => {
    const [down] = buildTypeSteps('A')
    expect(down).toMatchObject({
      type: 'keyDown',
      key: 'A',
      code: 'KeyA',
      text: 'A',
      modifiers: 8,
      windowsVirtualKeyCode: 65,
    })
    expect(buildTypeSteps('!')[0]).toMatchObject({ code: 'Digit1', modifiers: 8, windowsVirtualKeyCode: 49 })
    expect(buildTypeSteps('?')[0]).toMatchObject({ code: 'Slash', modifiers: 8, windowsVirtualKeyCode: 191 })
  })

  it('sends Enter for newlines so textareas and contenteditable keep native behavior', () => {
    expect(plan(buildTypeSteps('a\nb'))).toEqual([
      'keyDown:a:KeyA:0:a',
      'keyUp:a:KeyA:0:',
      'keyDown:Enter:Enter:0:\r',
      'keyUp:Enter:Enter:0:',
      'keyDown:b:KeyB:0:b',
      'keyUp:b:KeyB:0:',
    ])
  })

  it('coalesces characters a US keyboard cannot produce into one insertText', () => {
    expect(plan(buildTypeSteps('你好'))).toEqual(['insertText:你好'])
    expect(plan(buildTypeSteps('a你b'))).toEqual([
      'keyDown:a:KeyA:0:a',
      'keyUp:a:KeyA:0:',
      'insertText:你',
      'keyDown:b:KeyB:0:b',
      'keyUp:b:KeyB:0:',
    ])
  })

  it('does not insert a character for Control/Meta shortcuts', () => {
    const [down] = buildKeySteps('Control+A')
    // The first event is the Control key itself; the A key carries no text.
    expect(down).toMatchObject({ type: 'rawKeyDown', key: 'Control', modifiers: 2 })
    const a = buildKeySteps('Control+a')[buildKeySteps('Control+a').findIndex((step) => step.key === 'a')]
    expect(a?.text).toBeUndefined()
  })
})

describe('buildKeySteps', () => {
  it('holds and releases a combination in the right order', () => {
    expect(plan(buildKeySteps('Meta+A'))).toEqual([
      'rawKeyDown:Meta:MetaLeft:4:',
      'rawKeyDown:a:KeyA:4:',
      'keyUp:a:KeyA:4:',
      'keyUp:Meta:MetaLeft:0:',
    ])
  })

  it('supports named keys and multiple modifiers', () => {
    expect(plan(buildKeySteps('Control+Shift+Enter'))).toEqual([
      'rawKeyDown:Control:ControlLeft:2:',
      'rawKeyDown:Shift:ShiftLeft:10:',
      'rawKeyDown:Enter:Enter:10:',
      'keyUp:Enter:Enter:10:',
      'keyUp:Shift:ShiftLeft:2:',
      'keyUp:Control:ControlLeft:0:',
    ])
  })

  it('accepts aliases and a bare modifier key', () => {
    expect(plan(buildKeySteps('Cmd+ArrowDown')).map((line) => line.split(':')[1])).toEqual([
      'Meta', 'ArrowDown', 'ArrowDown', 'Meta',
    ])
    expect(plan(buildKeySteps('Esc'))).toEqual([
      'rawKeyDown:Escape:Escape:0:',
      'keyUp:Escape:Escape:0:',
    ])
    expect(plan(buildKeySteps('Shift'))).toEqual([
      'rawKeyDown:Shift:ShiftLeft:8:',
      'keyUp:Shift:ShiftLeft:0:',
    ])
  })

  it('attaches the macOS selectAll editing command to Cmd+A', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    try {
      const main = buildKeySteps('Meta+A').find((step) => step.type === 'rawKeyDown' && step.key === 'a')
      expect(main?.commands).toEqual(['selectAll'])
      const undo = buildKeySteps('Meta+Z').find((step) => step.type === 'rawKeyDown' && step.key === 'z')
      expect(undo?.commands).toEqual(['undo'])
    } finally {
      if (original === undefined) delete (navigator as { platform?: string }).platform
      else Object.defineProperty(navigator, 'platform', original)
    }
  })

  it('rejects an unknown key name', () => {
    expect(() => buildKeySteps('NotAKey')).toThrow(/Unknown key/)
  })

  it('uses Meta on macOS and Control elsewhere for select-all without adding Shift', () => {
    expect(['Meta', 'Control']).toContain(primaryModifier())
    const [down] = selectAllSteps()
    expect(down).toMatchObject({ type: 'rawKeyDown', key: primaryModifier() })
    const primaryBit = primaryModifier() === 'Meta' ? 4 : 2
    const main = selectAllSteps().find((step) => step.type === 'rawKeyDown' && step.key === 'a')
    expect(main).toMatchObject({ key: 'a', code: 'KeyA', modifiers: primaryBit })
    expect(main?.text).toBeUndefined()
  })
})

describe('sendKeyStepsToCdp', () => {
  it('rejects the plan when no extension runtime is available', async () => {
    vi.unstubAllGlobals()
    await expect(sendKeyStepsToCdp(buildTypeSteps('a'))).resolves.toBe(false)
  })

  it('reports background acknowledgement', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('chrome', { runtime: { sendMessage } })
    await expect(sendKeyStepsToCdp(buildTypeSteps('a'))).resolves.toBe(true)
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'DSH_INPUT_KEY' }))
    vi.unstubAllGlobals()
  })
})
