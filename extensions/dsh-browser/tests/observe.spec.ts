// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatObservation, observePage, type ObserveSnapshot } from '../src/background/observe.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const SNAPSHOT: ObserveSnapshot = {
  installed: true,
  console: [{ level: 'error', text: 'Failed to load chunk', ts: 1 }],
  errors: [{ kind: 'error', text: 'TypeError: x is undefined', ts: 2 }],
  network: [{ url: 'https://example.test/api/items', status: 500, ts: 3 }],
}

describe('observePage', () => {
  it('installs the main-world hooks, then reads the buffers with the clear flag', async () => {
    const executeScript = vi.fn(async (injection: { func: unknown; args: unknown[] }) => {
      if (injection.args.length === 0) return [{ result: undefined }]
      return [{ result: SNAPSHOT }]
    })
    vi.stubGlobal('chrome', { scripting: { executeScript } })

    await expect(observePage(5, false)).resolves.toEqual(SNAPSHOT)
    expect(executeScript).toHaveBeenCalledTimes(2)
    expect(executeScript.mock.calls[0]![0]).toMatchObject({ target: { tabId: 5, frameIds: [0] }, world: 'MAIN', args: [] })
    expect(executeScript.mock.calls[1]![0]).toMatchObject({ args: [false] })
  })

  it('reports a readable error when the scripting API is unavailable', async () => {
    vi.stubGlobal('chrome', {})
    await expect(observePage(5)).rejects.toThrow(/chrome\.scripting/)
  })
})

describe('formatObservation', () => {
  it('groups console, page errors, and failed requests', () => {
    const text = formatObservation(SNAPSHOT)
    expect(text).toContain('Console (1):')
    expect(text).toContain('[error] Failed to load chunk')
    expect(text).toContain('Page errors (1):')
    expect(text).toContain('500 https://example.test/api/items')
  })

  it('says so when the page is quiet', () => {
    expect(formatObservation({ installed: true, console: [], errors: [], network: [] }))
      .toContain('No console errors')
  })
})
