// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadFiles } from '../src/background/upload.ts'
import { handleDialog } from '../src/background/dialog.ts'

type Handler = (params: Record<string, unknown>) => unknown

interface DebuggerMock {
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
  on: (method: string, handler: Handler) => void
}

function installDebuggerMock(): DebuggerMock {
  const handlers = new Map<string, Handler>()
  const attach = vi.fn(async () => {})
  const detach = vi.fn(async () => {})
  const sendCommand = vi.fn(async (_target: { tabId: number }, method: string, params?: Record<string, unknown>) => {
    const handler = handlers.get(method)
    if (handler !== undefined) return handler(params ?? {})
    return {}
  })
  vi.stubGlobal('chrome', {
    debugger: {
      attach,
      detach,
      sendCommand,
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  })
  return { attach, detach, sendCommand, on: (method, handler) => { handlers.set(method, handler) } }
}

let mock: DebuggerMock

beforeEach(() => {
  mock = installDebuggerMock()
  mock.on('DOM.getDocument', () => ({ root: { nodeId: 1 } }))
  mock.on('DOM.querySelector', () => ({ nodeId: 2 }))
  mock.on('DOM.describeNode', () => ({ node: { nodeName: 'INPUT', attributes: ['type', 'file'] } }))
  mock.on('DOM.setFileInputFiles', () => ({}))
  mock.on('Page.enable', () => ({}))
  mock.on('Page.handleJavaScriptDialog', () => ({}))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('uploadFiles', () => {
  it('resolves the indexed file input and attaches absolute paths via CDP', async () => {
    await expect(uploadFiles(7, 12, ['/tmp/a.png', '/tmp/b.pdf'])).resolves.toEqual({ files: 2 })
    const methods = mock.sendCommand.mock.calls.map((call) => call[1])
    expect(methods).toEqual(['DOM.getDocument', 'DOM.querySelector', 'DOM.describeNode', 'DOM.setFileInputFiles'])
    const query = mock.sendCommand.mock.calls[1]![2] as Record<string, unknown>
    expect(query.selector).toBe('[data-dsh-el="12"]')
    const attach = mock.sendCommand.mock.calls[3]![2] as Record<string, unknown>
    expect(attach).toEqual({ files: ['/tmp/a.png', '/tmp/b.pdf'], nodeId: 2 })
    expect(mock.detach).toHaveBeenCalledTimes(1)
  })

  it('rejects relative paths before touching the debugger', async () => {
    await expect(uploadFiles(7, 12, ['relative.png'])).rejects.toThrow(/not an absolute path/)
    expect(mock.attach).not.toHaveBeenCalled()
  })

  it('rejects a missing element and a non-file input with a readable message', async () => {
    mock.on('DOM.querySelector', () => ({ nodeId: 0 }))
    await expect(uploadFiles(7, 12, ['/tmp/a.png'])).rejects.toThrow(/not present in the page/)
    mock.on('DOM.querySelector', () => ({ nodeId: 2 }))
    mock.on('DOM.describeNode', () => ({ node: { nodeName: 'INPUT', attributes: ['type', 'text'] } }))
    await expect(uploadFiles(7, 12, ['/tmp/a.png'])).rejects.toThrow(/not a file input/)
  })

  it('surfaces a Chrome path rejection with the recovery hint', async () => {
    mock.on('DOM.setFileInputFiles', () => { throw new Error('File not found') })
    await expect(uploadFiles(7, 12, ['/tmp/missing.png'])).rejects.toThrow(/Check that each path exists/)
  })
})

describe('handleDialog', () => {
  it('answers the open dialog with the requested decision', async () => {
    await expect(handleDialog(9, true, 'typed answer')).resolves.toEqual({ accepted: true })
    const call = mock.sendCommand.mock.calls.find((entry) => entry[1] === 'Page.handleJavaScriptDialog')
    expect(call?.[2]).toEqual({ accept: true, promptText: 'typed answer' })
    expect(mock.detach).toHaveBeenCalledTimes(1)
  })

  it('explains when no dialog is open', async () => {
    mock.on('Page.handleJavaScriptDialog', () => { throw new Error('No dialog is showing') })
    await expect(handleDialog(9, false)).rejects.toThrow(/No JavaScript dialog is currently open/)
  })
})
