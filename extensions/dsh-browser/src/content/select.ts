/**
 * Native `<select>` handling.
 *
 * A native select opens an OS-level popup that the page neither renders into
 * the DOM snapshot nor lets synthetic clicks reach reliably. Selecting the
 * option in the element's own model, then firing `input`/`change`, is both
 * deterministic and React/Vue-compatible. Custom listbox widgets are not
 * handled here; for those the model clicks the trigger and snapshots the
 * rendered options, which is the only faithful path.
 *
 * @module
 */

/** One option-selection request. */
export interface SelectRequest {
  /** Exact option value. */
  value?: string
  /** Exact visible option label (falls back to a unique case-insensitive contains match). */
  label?: string
  /** Zero-based position among the select's options. */
  optionIndex?: number
  /** Multiple values for a `<select multiple>`. */
  values?: string[]
}

/** Result of a native selection. */
export interface SelectResult {
  selected: string[]
  multiple: boolean
}

/** Normalize an option's visible label. */
function optionLabel(option: HTMLOptionElement): string {
  return (option.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Find one option by index, exact value, exact label, then unique contains. */
function findOption(select: HTMLSelectElement, token: { value?: string; label?: string; optionIndex?: number }): HTMLOptionElement {
  const options = [...select.options]
  if (token.optionIndex !== undefined) {
    const option = options[token.optionIndex]
    if (option === undefined) {
      throw new Error(`Option index ${token.optionIndex} is out of range; this select has ${options.length} options.`)
    }
    return option
  }
  if (token.value !== undefined) {
    const option = options.find((candidate) => candidate.value === token.value)
    if (option !== undefined) return option
    throw new Error(`No option has value "${token.value}". Available: ${options.slice(0, 20).map(optionLabel).join(' | ')}`)
  }
  if (token.label !== undefined) {
    const normalized = token.label.replace(/\s+/g, ' ').trim()
    const exact = options.find((candidate) => optionLabel(candidate) === normalized)
    if (exact !== undefined) return exact
    const folded = normalized.toLowerCase()
    const partial = options.filter((candidate) => optionLabel(candidate).toLowerCase().includes(folded))
    if (partial.length === 1) return partial[0]!
    if (partial.length > 1) {
      throw new Error(`Label "${token.label}" matches ${partial.length} options. Use value or optionIndex. Candidates: ${partial.slice(0, 10).map(optionLabel).join(' | ')}`)
    }
    throw new Error(`No option label contains "${token.label}". Available: ${options.slice(0, 20).map(optionLabel).join(' | ')}`)
  }
  throw new Error('Provide value, label, or optionIndex to choose an option.')
}

/**
 * Notify the page that the selection changed. The option's own `selected`
 * state (or `select.value`) is already committed above; writing `select.value`
 * again here would collapse a `<select multiple>` to its first option.
 */
function commit(select: HTMLSelectElement): void {
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * Select one or more options in a native `<select>`. Throws a model-readable
 * error when the request cannot be resolved unambiguously.
 */
export function selectNativeOption(select: HTMLSelectElement, request: SelectRequest): SelectResult {
  const values = request.values ?? []
  if (values.length > 0) {
    if (!select.multiple) throw new Error('values[] is only valid for a <select multiple>; use value, label, or optionIndex.')
    const wanted = values.map((value) => findOption(select, { value }))
    for (const option of select.options) option.selected = wanted.includes(option)
    commit(select)
  } else {
    const option = findOption(select, request)
    if (select.multiple) {
      for (const candidate of select.options) candidate.selected = candidate === option
    } else {
      select.value = option.value
    }
    commit(select)
  }
  return {
    selected: [...select.selectedOptions].map(optionLabel),
    multiple: select.multiple,
  }
}
