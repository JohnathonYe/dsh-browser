/**
 * Background AX fetch: pull the Chromium accessibility tree for the controlled
 * tab over the shared debugger transport, project the accessibility-relevant
 * nodes into the serialisable `AxNodeInput` shape, and hand them to the
 * content script so it can resolve each node to a live element, measure real
 * bounds, and assign a stable index.
 *
 * This is the OPTIONAL enrichment path: `fetchAxNodes` returns `undefined`
 * whenever the AX tree cannot be produced (a protected/internal page, the tab
 * already attached to DevTools, a test environment with no `chrome.debugger`)
 * — the caller then falls back to the existing DOM inventory. Nothing in the
 * snapshot contract depends on AX being available.
 *
 * @module
 */

import { debuggerSession } from './debugger-session.ts'
import { AX_INTERESTING_ROLES, type AxNodeInput } from '../ax-shared.ts'

interface CdpAxValue {
  name?: string
  value?: { type?: string; value?: unknown }
}

interface CdpAxNode {
  nodeId?: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  properties?: CdpAxValue[]
  backendDOMNodeId?: number
}

interface CdpAxTree {
  nodes?: CdpAxNode[]
}

function roleValue(node: CdpAxNode): string {
  return (node.role?.value ?? '').toLowerCase()
}

function nameValue(node: CdpAxNode): string {
  return node.name?.value ?? ''
}

function propertyValue(node: CdpAxNode, propertyName: string): unknown {
  for (const property of node.properties ?? []) {
    if (property.name === propertyName) return property.value?.value
  }
  return undefined
}

function booleanProperty(node: CdpAxNode, propertyName: string): boolean | undefined {
  const value = propertyValue(node, propertyName)
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Fetch the accessibility tree and project the semantic/actionable nodes into
 * the content-consumable shape. Bound-cost is one CDP round trip
 * (`Accessibility.getFullAXTree`), capped client-side to keep the payload
 * small. Never throws: `undefined` signals "AX unavailable → use the DOM".
 *
 * @param tabId - the controlled tab.
 * @param maxNodes - upper bound on kept nodes (default 200).
 */
export async function fetchAxNodes(tabId: number, maxNodes: number = 200): Promise<AxNodeInput[] | undefined> {
  try {
    await debuggerSession.acquire(tabId)
    await debuggerSession.sendCommand(tabId, 'Accessibility.enable')
    const tree = await debuggerSession.sendCommand<CdpAxTree>(tabId, 'Accessibility.getFullAXTree', {})
    const nodes: AxNodeInput[] = []
    for (const node of tree?.nodes ?? []) {
      if (node.ignored === true) continue
      const role = roleValue(node)
      if (!AX_INTERESTING_ROLES.has(role)) continue
      const name = nameValue(node)
      const entry: AxNodeInput = { role, name }
      if (node.backendDOMNodeId !== undefined) entry.backendDOMNodeId = node.backendDOMNodeId
      const disabled = booleanProperty(node, 'disabled')
      if (disabled !== undefined) entry.disabled = disabled
      const checked = booleanProperty(node, 'checked')
      if (checked !== undefined) entry.checked = checked
      nodes.push(entry)
      if (nodes.length >= maxNodes) break
    }
    return nodes.length === 0 ? undefined : nodes
  } catch {
    // AX is an enhancement, never a dependency: protected pages, an attached
    // DevTools client, or a non-debugger test environment just skip it.
    return undefined
  } finally {
    await debuggerSession.release(tabId).catch(() => {})
  }
}
