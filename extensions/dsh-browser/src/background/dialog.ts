/**
 * Native JavaScript dialog handling.
 *
 * `alert`/`confirm`/`prompt`/`beforeunload` block the renderer and open no DOM
 * the model can snapshot or click. Chrome's DevTools protocol can answer the
 * open dialog directly (`Page.handleJavaScriptDialog`), which is the only
 * reliable way to unblock an automation flow. The tool is deliberately
 * explicit: accepting a `confirm()` can delete data, so the model decides and
 * a fresh approval is required.
 *
 * @module
 */

import { debuggerSession } from './debugger-session.ts'

/** Result of answering a dialog. */
export interface DialogResult {
  accepted: boolean
}

/** Cap on acquiring the debugger session (a blocked renderer must not hang the tool). */
const ATTACH_TIMEOUT_MS = 3_000
/** Cap on the dialog answer command itself. */
const DIALOG_COMMAND_TIMEOUT_MS = 5_000
/** Tabs whose Page domain is already enabled on the held debugger session. */
const pageEnabled = new Set<number>()

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
 * Enable the Page domain for a held tab so `Page.javascriptDialogOpening` and
 * `Page.handleJavaScriptDialog` are usable *before* a dialog opens. Enabling
 * Page after the renderer is already blocked can hang, so this is called when
 * the debugger hold is established rather than when the tool is invoked.
 */
export async function enablePageDialogs(tabId: number): Promise<void> {
  if (pageEnabled.has(tabId)) return
  await withTimeout(
    debuggerSession.sendCommand(tabId, 'Page.enable'),
    ATTACH_TIMEOUT_MS,
    'Page.enable timed out',
  )
  pageEnabled.add(tabId)
}

/** Forget the Page-domain state for a tab whose debugger hold was released. */
export function forgetPageDialogs(tabId: number): void {
  pageEnabled.delete(tabId)
}

/**
 * Answer the JavaScript dialog currently open on `tabId`.
 * @throws when no dialog is open, the browser lacks `chrome.debugger`, or CDP
 *   rejects the command (with a model-readable message).
 */
export async function handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<DialogResult> {
  const debuggerApi = (globalThis as unknown as { chrome?: { debugger?: { onEvent?: unknown } } }).chrome?.debugger
  if (debuggerApi === undefined) {
    throw new Error('Answering a JavaScript dialog requires the Chrome debugger API, which is unavailable in this browser.')
  }
  let acquired = false
  try {
    // A JS dialog blocks the renderer. Attaching can therefore wait on a
    // renderer handshake, and `Page.enable` can wait too, so neither may be
    // allowed to hold the tool call: bound the attach and call the dialog
    // command directly (it does not require Page.enable to act).
    await withTimeout(debuggerSession.acquire(tabId), ATTACH_TIMEOUT_MS, 'The browser debugger could not attach while a dialog is open.')
    acquired = true
    // A held tab already has Page enabled from enablePageDialogs(); enabling it
    // after a dialog blocks the renderer can hang, so only do it when needed.
    await enablePageDialogs(tabId)
    try {
      await withTimeout(
        debuggerSession.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
          accept,
          ...promptText === undefined ? {} : { promptText },
        }),
        DIALOG_COMMAND_TIMEOUT_MS,
        'The browser did not answer the dialog command in time.',
      )
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (/no dialog/i.test(message)) {
        throw new Error('No JavaScript dialog is currently open on this tab.')
      }
      throw new Error(`The browser could not answer the dialog: ${message}`)
    }
    return { accepted: accept }
  } finally {
    if (acquired) await debuggerSession.release(tabId).catch(() => {})
  }
}
