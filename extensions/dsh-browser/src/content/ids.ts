/**
 * Stable element numbering for the interactive inventory.
 *
 * Numbers are the model's addressing scheme ("click 7"), so they must survive
 * re-snapshots as long as the element itself survives: ids are assigned once
 * per element (WeakMap) and only renumbered when the element set is
 * restructured. `data-dsh-el` attributes are also written so the ids stay
 * observable from the outside.
 *
 * @module
 */

/** Attribute written on every inventoried element (observable numbering). */
const ID_ATTRIBUTE = 'data-dsh-el'

/**
 * Stable element → id registry. One instance per content-script lifetime.
 */
export class ElementIds {
  private readonly idByElement = new WeakMap<Element, number>()
  private readonly elementById = new Map<number, Element>()
  private nextId = 1

  /**
   * Reconcile the registry against the current element set: drop ids of
   * vanished elements, assign fresh ids to new ones.
   * @param elements - the current interactive inventory (document order).
   * @returns counts of added and removed elements.
   */
  assign(elements: Element[]): { added: number; removed: number } {
    const seen = new Set(elements)
    let removed = 0
    for (const [id, el] of this.elementById) {
      if (!seen.has(el)) {
        this.elementById.delete(id)
        this.idByElement.delete(el)
        removed += 1
      }
    }
    let added = 0
    for (const el of elements) {
      if (!this.idByElement.has(el)) {
        const id = this.nextId
        this.nextId += 1
        this.idByElement.set(el, id)
        this.elementById.set(id, el)
        el.setAttribute(ID_ATTRIBUTE, String(id))
        added += 1
      }
    }
    return { added, removed }
  }

  /**
   * Register a single element without dropping any other element. Idempotent:
   * returns the existing id when already registered. Used by the AX semantic
   * inventory to admit resolved nodes that the DOM heuristic scan missed
   * (rich components) without evicting the interactive inventory.
   * @param el - element to register.
   * @returns the element's stable id.
   */
  register(el: Element): number {
    const existing = this.idByElement.get(el)
    if (existing !== undefined) return existing
    const id = this.nextId
    this.nextId += 1
    this.idByElement.set(el, id)
    this.elementById.set(id, el)
    el.setAttribute(ID_ATTRIBUTE, String(id))
    return id
  }

  /**
   * Resolve an element's stable id.
   * @param el - element.
   * @returns the assigned id, or undefined when not inventoried.
   */
  indexOf(el: Element): number | undefined {
    return this.idByElement.get(el)
  }

  /**
   * Resolve an id to its element.
   * @param index - inventory number.
   * @returns the element, or undefined when stale or removed.
   */
  elementByIndex(index: number): Element | undefined {
    return this.elementById.get(index)
  }
}
