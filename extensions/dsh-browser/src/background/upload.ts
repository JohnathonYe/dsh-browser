/**
 * File-input upload through CDP.
 *
 * A content script cannot construct a `File` from a local path, and clicking a
 * hidden `<input type="file">` opens an OS picker the model cannot drive.
 * `DOM.setFileInputFiles` fills the input's file list directly, which is how a
 * person's chosen file reaches the page: the page receives `input`/`change`
 * with a real `FileList`, and the owning form uploads it normally.
 *
 * Only the top frame is supported: the background's DOM node ids belong to the
 * top document, and file inputs inside cross-origin iframes cannot be addressed
 * by the tab-level debugger session.
 *
 * @module
 */

import { debuggerSession } from './debugger-session.ts'

/** Hard cap on how many files one call may attach. */
const MAX_FILES = 10

/** Result of one upload. */
export interface UploadResult {
  files: number
}

/** Normalize and validate the model-supplied absolute paths. */
function normalizePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) throw new Error('paths must be an array of absolute file paths.')
  const cleaned = [...new Set(paths.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()))]
  if (cleaned.length === 0) throw new Error('paths must contain at least one absolute file path.')
  if (cleaned.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files can be attached in one call.`)
  for (const path of cleaned) {
    // The debugger API requires absolute paths; reject relative ones early with
    // a model-readable message instead of a cryptic Chrome error.
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
      throw new Error(`"${path}" is not an absolute path. Pass the full path to the file on this machine.`)
    }
  }
  return cleaned
}

/**
 * Attach `paths` to the file input carrying the snapshot's stable index.
 * Throws a model-readable error when the element is missing, not a file input,
 * or Chrome rejects the paths.
 */
export async function uploadFiles(tabId: number, index: number, rawPaths: unknown): Promise<UploadResult> {
  const paths = normalizePaths(rawPaths)
  const debuggerApi = (globalThis as unknown as { chrome?: { debugger?: unknown } }).chrome?.debugger
  if (debuggerApi === undefined) {
    throw new Error('File upload requires the Chrome debugger API, which is unavailable in this browser.')
  }
  let acquired = false
  try {
    await debuggerSession.acquire(tabId)
    acquired = true
    const document = await debuggerSession.sendCommand<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 })
    const { nodeId } = await debuggerSession.sendCommand<{ nodeId: number }>(tabId, 'DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: `[data-dsh-el="${index}"]`,
    })
    if (nodeId === 0) {
      throw new Error(`Element [${index}] is not present in the page. Call browser_snapshot again for current indices.`)
    }
    const { node } = await debuggerSession.sendCommand<{ node: { nodeName: string; attributes?: string[] } }>(tabId, 'DOM.describeNode', { nodeId })
    const attributes = node.attributes ?? []
    const typeIndex = attributes.findIndex((value) => value.toLowerCase() === 'type')
    const inputType = typeIndex >= 0 ? (attributes[typeIndex + 1] ?? '').toLowerCase() : ''
    if (node.nodeName.toUpperCase() !== 'INPUT' || inputType !== 'file') {
      throw new Error(`Element [${index}] is not a file input (found <${node.nodeName.toLowerCase()}${inputType === '' ? '' : ` type="${inputType}"`}>).`)
    }
    try {
      await debuggerSession.sendCommand(tabId, 'DOM.setFileInputFiles', { files: paths, nodeId })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Chrome rejected the file paths (${message}). Check that each path exists and is readable.`)
    }
    return { files: paths.length }
  } finally {
    if (acquired) await debuggerSession.release(tabId).catch(() => {})
  }
}
