/**
 * Test helper: a fake `chrome.runtime.sendMessage` that replays the content
 * script's CDP key plan into the focused jsdom field. It records the plan so
 * tests can assert that `browser_type`/`browser_press` used real key events
 * instead of a synthetic value write, and it applies the same text/backspace
 * effects a browser would so the action's own "did the value change?" check
 * sees a real edit.
 */

import { vi } from 'vitest'

interface KeyStep {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp' | 'insertText'
  key?: string
  text?: string
  modifiers?: number
  windowsVirtualKeyCode?: number
}

export interface KeyboardCdpMock {
  /** Every `DSH_INPUT_KEY` plan the content script sent. */
  captured: KeyStep[][]
  sendMessage: ReturnType<typeof vi.fn>
  /** Make the background report failure so the action uses its fallback. */
  setOk: (value: boolean) => void
  restore: () => void
}

/** Apply one key-down-like step to the active editable element. */
function applyStep(step: KeyStep): void {
  const active = document.activeElement
  const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null
  const editable = active instanceof HTMLElement && active.isContentEditable ? active : null
  if (field === null && editable === null) return
  const append = (text: string): void => {
    if (field !== null) field.value = `${field.value}${text}`
    else if (editable !== null) editable.textContent = `${editable.textContent ?? ''}${text}`
    active?.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (step.type === 'insertText') {
    append(step.text ?? '')
    return
  }
  if (step.type !== 'keyDown' && step.type !== 'rawKeyDown') return
  if (step.key === 'Backspace') {
    if (field !== null) field.value = field.value.slice(0, -1)
    else if (editable !== null) editable.textContent = (editable.textContent ?? '').slice(0, -1)
    active?.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  // Meta/Control+A clears the selection model in this mock.
  if ((step.key === 'a' || step.key === 'A') && ((step.modifiers ?? 0) & (2 | 4)) !== 0) {
    if (field !== null) field.value = ''
    else if (editable !== null) editable.textContent = ''
    return
  }
  if (step.text !== undefined && step.text !== '') append(step.text)
}

export function installKeyboardCdpMock(initialOk: boolean = true): KeyboardCdpMock {
  const captured: KeyStep[][] = []
  let ok = initialOk
  const sendMessage = vi.fn(async (message: unknown): Promise<{ ok: boolean; error?: string }> => {
    const msg = message as { type?: string; steps?: unknown }
    if (msg?.type === 'DSH_INPUT_KEY' && Array.isArray(msg.steps)) {
      captured.push(msg.steps as KeyStep[])
      if (ok) {
        for (const step of msg.steps as KeyStep[]) applyStep(step)
      }
    }
    return { ok, error: ok ? undefined : 'mock-cdp-failure' }
  })
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
  return {
    captured,
    sendMessage,
    setOk: (value: boolean) => { ok = value },
    restore: () => { vi.unstubAllGlobals() },
  }
}
