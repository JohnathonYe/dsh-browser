/**
 * Real keyboard input for the content script.
 *
 * `browser_type` and `browser_press` must reach the page the way a person's
 * keyboard does: keydown/keypress/input/keyup on the focused element, with the
 * right `key`, `code`, and modifier flags. Programmatic `value` writes and
 * synthetic `dispatchEvent` cannot drive autocomplete/typeahead widgets, native
 * form submission, Tab focus traversal, or application-level shortcuts.
 *
 * The content script cannot attach `chrome.debugger`; only the background can.
 * So it computes a list of CDP key steps here and hands them to the background,
 * which replays them through `Input.dispatchKeyEvent` / `Input.insertText`.
 * When that transport is unavailable the caller falls back to the old synthetic
 * path, so jsdom tests and protected pages still work.
 *
 * @module
 */

/** One CDP keyboard step, in the shape `Input.dispatchKeyEvent` accepts. */
export interface KeyStep {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp' | 'insertText'
  /** `KeyboardEvent.key` value. */
  key?: string
  /** `KeyboardEvent.code` value. */
  code?: string
  /** Text a keyDown inserts (printable keys only). */
  text?: string
  /** Same as `text` for unmodified characters. */
  unmodifiedText?: string
  /** CDP modifier bitfield: Alt=1, Control=2, Meta=4, Shift=8. */
  modifiers?: number
  /** Windows virtual-key code. */
  windowsVirtualKeyCode?: number
  /** Native virtual-key code (same mapping on US layouts). */
  nativeVirtualKeyCode?: number
  /** CDP editing commands for macOS shortcuts (e.g. selectAll for Cmd+A). */
  commands?: string[]
  /** Pause after this step, honored by the background replay. */
  pauseAfterMs?: number
}

/** Modifier token → CDP bit. */
const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
}

/** Modifier aliases accepted in a key combination. */
const MODIFIER_ALIASES: Record<string, string> = {
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
  shift: 'Shift',
}

/** A named non-character key. */
interface NamedKey {
  key: string
  code: string
  vk: number
  /** Text inserted on keyDown, when the key produces text. */
  text?: string
}

/** Named keys, keyed by lower-case token. */
const NAMED_KEYS: Record<string, NamedKey> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  spacebar: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  capslock: { key: 'CapsLock', code: 'CapsLock', vk: 20 },
  numlock: { key: 'NumLock', code: 'NumLock', vk: 144 },
  scrolllock: { key: 'ScrollLock', code: 'ScrollLock', vk: 145 },
  pause: { key: 'Pause', code: 'Pause', vk: 19 },
  printscreen: { key: 'PrintScreen', code: 'PrintScreen', vk: 44 },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu', vk: 93 },
  shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
  control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
}
for (let n = 1; n <= 12; n += 1) {
  NAMED_KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, vk: 111 + n }
}

/** Punctuation → US-layout key identity. */
const PUNCTUATION: Record<string, { code: string; vk: number; shifted: boolean }> = {
  '`': { code: 'Backquote', vk: 192, shifted: false },
  '~': { code: 'Backquote', vk: 192, shifted: true },
  '!': { code: 'Digit1', vk: 49, shifted: true },
  '@': { code: 'Digit2', vk: 50, shifted: true },
  '#': { code: 'Digit3', vk: 51, shifted: true },
  '$': { code: 'Digit4', vk: 52, shifted: true },
  '%': { code: 'Digit5', vk: 53, shifted: true },
  '^': { code: 'Digit6', vk: 54, shifted: true },
  '&': { code: 'Digit7', vk: 55, shifted: true },
  '*': { code: 'Digit8', vk: 56, shifted: true },
  '(': { code: 'Digit9', vk: 57, shifted: true },
  ')': { code: 'Digit0', vk: 48, shifted: true },
  '-': { code: 'Minus', vk: 189, shifted: false },
  '_': { code: 'Minus', vk: 189, shifted: true },
  '=': { code: 'Equal', vk: 187, shifted: false },
  '+': { code: 'Equal', vk: 187, shifted: true },
  '[': { code: 'BracketLeft', vk: 219, shifted: false },
  '{': { code: 'BracketLeft', vk: 219, shifted: true },
  ']': { code: 'BracketRight', vk: 221, shifted: false },
  '}': { code: 'BracketRight', vk: 221, shifted: true },
  '\\': { code: 'Backslash', vk: 220, shifted: false },
  '|': { code: 'Backslash', vk: 220, shifted: true },
  ';': { code: 'Semicolon', vk: 186, shifted: false },
  ':': { code: 'Semicolon', vk: 186, shifted: true },
  "'": { code: 'Quote', vk: 222, shifted: false },
  '"': { code: 'Quote', vk: 222, shifted: true },
  ',': { code: 'Comma', vk: 188, shifted: false },
  '<': { code: 'Comma', vk: 188, shifted: true },
  '.': { code: 'Period', vk: 190, shifted: false },
  '>': { code: 'Period', vk: 190, shifted: true },
  '/': { code: 'Slash', vk: 191, shifted: false },
  '?': { code: 'Slash', vk: 191, shifted: true },
}

/** A character's key identity, or undefined for characters that need `insertText`. */
interface CharKey {
  key: string
  code: string
  vk: number
  shifted: boolean
}

/** Resolve a single printable ASCII character to its US-layout key identity. */
function charKey(ch: string): CharKey | undefined {
  const code = ch.codePointAt(0)
  if (code === undefined || code < 0x20 || code > 0x7e) return undefined
  if (ch >= 'a' && ch <= 'z') return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), shifted: false }
  if (ch >= 'A' && ch <= 'Z') return { key: ch, code: `Key${ch}`, vk: ch.charCodeAt(0), shifted: true }
  if (ch >= '0' && ch <= '9') return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), shifted: false }
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, shifted: false }
  const punctuation = PUNCTUATION[ch]
  if (punctuation !== undefined) return { key: ch, code: punctuation.code, vk: punctuation.vk, shifted: punctuation.shifted }
  return undefined
}

/** Text a keyDown should carry: printable text unless a command modifier is held. */
function textForStep(text: string | undefined, modifiers: number): string | undefined {
  if (text === undefined) return undefined
  // Ctrl/Meta/Alt turn a character key into a shortcut, not text. Shift is fine.
  if ((modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) !== 0) return undefined
  return text
}

/** Build the two steps for one character. */
function charSteps(ch: string): KeyStep[] {
  const def = charKey(ch)
  if (def === undefined) {
    // CJK, emoji, accented letters, tabs, and other non-US-layout input go
    // through insertText, which produces a real `input` event without
    // pretending to be a key on a US keyboard.
    return [{ type: 'insertText', text: ch }]
  }
  const modifiers = def.shifted ? MODIFIER_BITS.Shift : 0
  const down: KeyStep = {
    type: 'keyDown',
    key: def.key,
    code: def.code,
    text: def.key,
    unmodifiedText: def.key,
    modifiers,
    windowsVirtualKeyCode: def.vk,
    nativeVirtualKeyCode: def.vk,
    pauseAfterMs: 2,
  }
  return [
    down,
    {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      modifiers,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
    },
  ]
}

/**
 * Build the key plan for typing `text` into the focused field: one keydown/
 * keyup pair per printable character, Enter for newlines, and `insertText`
 * runs for anything a US keyboard cannot produce. The plan preserves the
 * page's own event flow, so typeaheads and rich editors see normal typing.
 */
export function buildTypeSteps(text: string): KeyStep[] {
  const steps: KeyStep[] = []
  const chars = Array.from(text)
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index]!
    if (ch === '\r') {
      // Treat CRLF as one newline.
      if (chars[index + 1] === '\n') index += 1
      steps.push(...keyStepsFor('Enter'))
      continue
    }
    if (ch === '\n') {
      steps.push(...keyStepsFor('Enter'))
      continue
    }
    if (ch === '\t') {
      steps.push({ type: 'insertText', text: ch })
      continue
    }
    if (charKey(ch) === undefined) {
      // Coalesce a run of non-US-layout characters into one insertText.
      let run = ch
      while (index + 1 < chars.length) {
        const next = chars[index + 1]!
        if (next === '\n' || next === '\r' || next === '\t' || charKey(next) !== undefined) break
        run += next
        index += 1
      }
      steps.push({ type: 'insertText', text: run })
      continue
    }
    steps.push(...charSteps(ch))
  }
  return steps
}

/** Resolve a modifier token to its canonical name and bit. */
function modifierOf(token: string): { name: string; bit: number } | undefined {
  const name = MODIFIER_ALIASES[token.toLowerCase()]
  if (name === undefined) return undefined
  return { name, bit: MODIFIER_BITS[name]! }
}

/** Build steps for one named/character key with an explicit modifier mask. */
function keyStepsFor(token: string, mask: number = 0): KeyStep[] {
  const named = NAMED_KEYS[token.toLowerCase()]
  if (named !== undefined) {
    const keyText = textForStep(named.text, mask)
    const down: KeyStep = {
      type: keyText === undefined ? 'rawKeyDown' : 'keyDown',
      key: named.key,
      code: named.code,
      modifiers: mask,
      ...commandsFor(named.code, mask) === undefined ? {} : { commands: commandsFor(named.code, mask) },
      windowsVirtualKeyCode: named.vk,
      nativeVirtualKeyCode: named.vk,
      ...keyText === undefined ? {} : { text: keyText, unmodifiedText: keyText },
    }
    return [down, {
      type: 'keyUp',
      key: named.key,
      code: named.code,
      modifiers: mask,
      windowsVirtualKeyCode: named.vk,
      nativeVirtualKeyCode: named.vk,
    }]
  }
  if (Array.from(token).length !== 1) {
    throw new Error(`Unknown key "${token}". Use a single character or a key name such as Enter, Tab, Escape, ArrowDown.`)
  }
  const def = charKey(token)
  if (def === undefined) {
    // Non-US-layout character: insertText is the only faithful path.
    return [{ type: 'insertText', text: token }]
  }
  const shifted = def.shifted || (mask & MODIFIER_BITS.Shift) !== 0
  const effective = shifted ? mask | MODIFIER_BITS.Shift : mask
  const keyText = textForStep(def.key, effective)
  return [{
    type: keyText === undefined ? 'rawKeyDown' : 'keyDown',
    key: def.key,
    code: def.code,
    modifiers: effective,
    ...commandsFor(def.code, effective) === undefined ? {} : { commands: commandsFor(def.code, effective) },
    windowsVirtualKeyCode: def.vk,
    nativeVirtualKeyCode: def.vk,
    ...keyText === undefined ? {} : { text: keyText, unmodifiedText: keyText },
  }, {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    modifiers: effective,
    windowsVirtualKeyCode: def.vk,
    nativeVirtualKeyCode: def.vk,
  }]
}

/**
 * Build the plan for one key press, optionally a combination such as
 * `Meta+A`, `Control+Shift+Enter`, or a bare `Escape`. Modifier keys are held
 * across the main key and released in reverse order, exactly like a keyboard.
 */
export function buildKeySteps(spec: string, extraModifiers: readonly string[] = []): KeyStep[] {
  const trimmed = spec.trim()
  if (trimmed === '') throw new Error('key must not be empty.')
  // A literal "+" is a character, not a separator.
  const tokens = trimmed === '+' ? ['+'] : trimmed.split('+').map((token) => token.trim()).filter((token) => token !== '')
  if (tokens.length === 0) throw new Error('key must not be empty.')
  const pressed: { name: string; bit: number }[] = []
  const addModifier = (token: string): boolean => {
    const modifier = modifierOf(token)
    if (modifier === undefined) return false
    if (!pressed.some((entry) => entry.name === modifier.name)) pressed.push(modifier)
    return true
  }
  for (const extra of extraModifiers) {
    if (!addModifier(extra)) throw new Error(`Unknown modifier "${extra}". Use Alt, Control, Meta, or Shift.`)
  }
  let keyToken = trimmed
  if (tokens.length > 1) {
    keyToken = tokens[tokens.length - 1]!
    for (const token of tokens.slice(0, -1)) {
      if (!addModifier(token)) throw new Error(`Unknown modifier "${token}". Use Alt, Control, Meta, or Shift.`)
    }
  } else if (modifierOf(tokens[0]!) !== undefined) {
    // A bare modifier token ("Shift") presses and releases that modifier.
    addModifier(tokens[0]!)
    keyToken = tokens[0]!
  }
  const steps: KeyStep[] = []
  let mask = 0
  for (const modifier of pressed) {
    mask |= modifier.bit
    const named = NAMED_KEYS[modifier.name.toLowerCase()]!
    steps.push({
      type: 'rawKeyDown',
      key: named.key,
      code: named.code,
      modifiers: mask,
      windowsVirtualKeyCode: named.vk,
      nativeVirtualKeyCode: named.vk,
    })
  }
  const mainIsModifier = pressed.some((modifier) => modifier.name.toLowerCase() === keyToken.toLowerCase())
  // `Meta+A` / `Control+A` are shortcut notation: the letter names the key, it
  // does not mean "hold Shift and type a capital A". Without this, every
  // select-all became Cmd/Ctrl+Shift+A (on macOS that opens tab search).
  const hasCommandModifier = (mask & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) !== 0
  const commandLetter = /^[A-Z]$/u.test(keyToken) && hasCommandModifier && (mask & MODIFIER_BITS.Shift) === 0
  if (!mainIsModifier) steps.push(...keyStepsFor(commandLetter ? keyToken.toLowerCase() : keyToken, mask))
  for (const modifier of [...pressed].reverse()) {
    mask &= ~modifier.bit
    const named = NAMED_KEYS[modifier.name.toLowerCase()]!
    steps.push({
      type: 'keyUp',
      key: named.key,
      code: named.code,
      modifiers: mask,
      windowsVirtualKeyCode: named.vk,
      nativeVirtualKeyCode: named.vk,
    })
  }
  return steps
}

/**
 * macOS editing shortcuts need an explicit CDP editing command: a raw Meta+A
 * key event alone does not select all in Chromium. Playwright carries the same
 * mapping for the same reason.
 */
const MAC_EDITING_COMMANDS: Record<string, string[]> = {
  'Meta+KeyA': ['selectAll'],
  'Meta+KeyC': ['copy'],
  'Meta+KeyX': ['cut'],
  'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'],
  'Shift+Meta+KeyZ': ['redo'],
}

/** Editing commands to attach to one main-key down event. */
function commandsFor(code: string, mask: number): string[] | undefined {
  if (primaryModifier() !== 'Meta') return undefined
  if ((mask & MODIFIER_BITS.Meta) === 0) return undefined
  const shift = (mask & MODIFIER_BITS.Shift) !== 0 ? 'Shift+' : ''
  return MAC_EDITING_COMMANDS[`${shift}Meta+${code}`]
}

/** The platform's command modifier: Meta on macOS, Control elsewhere. */
export function primaryModifier(): 'Meta' | 'Control' {
  const platform = typeof navigator === 'undefined' ? '' : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control'
}

/** Build the plan that selects all text in the focused editable. */
export function selectAllSteps(): KeyStep[] {
  return buildKeySteps(`${primaryModifier()}+A`)
}

/** Best-effort access to the extension runtime, absent in jsdom/no-chrome envs. */
function extensionRuntime(): { sendMessage?: (message: unknown) => Promise<unknown> } | undefined {
  const chromeRuntime = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome?.runtime
  return chromeRuntime
}

/** Hard cap (ms) on waiting for the background to acknowledge a key replay. */
export const CDP_KEY_REPLY_TIMEOUT_MS = 20_000

/** Reject after `ms` without abandoning the underlying promise. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Ask the background to replay a key plan as real CDP keyboard events.
 * @returns true when the plan was applied; false when the background is
 *   unavailable, declined the frame, or the replay failed/timed out (in which
 *   case the caller should fall back to synthetic input).
 */
export async function sendKeyStepsToCdp(steps: KeyStep[]): Promise<boolean> {
  if (steps.length === 0) return true
  const runtime = extensionRuntime()
  if (runtime === undefined || typeof runtime.sendMessage !== 'function') return false
  try {
    const response = await withTimeout(
      runtime.sendMessage({ type: 'DSH_INPUT_KEY', steps }) as Promise<unknown>,
      CDP_KEY_REPLY_TIMEOUT_MS,
      'CDP key replay timed out waiting for the background acknowledge',
    ) as { ok?: unknown }
    return response?.ok === true
  } catch {
    return false
  }
}
