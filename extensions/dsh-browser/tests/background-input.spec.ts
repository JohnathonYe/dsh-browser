// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replayMouseSteps, type MouseStep } from '../src/background/input.ts'
import { debuggerSession } from '../src/background/debugger-session.ts'

/** A mock chrome.debugger with call recording and a configurable failure. */
function installDebuggerMock(): {
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
  failAttach: boolean
  setFailAttach: (value: boolean) => void
} {
  const state = { failAttach: false }
  const attach = vi.fn(async (_target: { tabId: number }, _version: string) => {
    if (state.failAttach) throw new Error('Another debugger is already attached')
  })
  const detach = vi.fn(async () => {})
  const sendCommand = vi.fn(async (_target: { tabId: number }, _method: string, _params?: Record<string, unknown>) => ({}))
  vi.stubGlobal('chrome', { debugger: { attach, detach, sendCommand } })
  return {
    attach,
    detach,
    sendCommand,
    failAttach: false,
    setFailAttach: (value: boolean) => { state.failAttach = value },
  }
}

let debuggerMock: ReturnType<typeof installDebuggerMock> | undefined

beforeEach(() => {
  debuggerMock = installDebuggerMock()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('debuggerSession', () => {
  it('shares one attach across concurrent acquire calls and detaches on the last release', async () => {
    await debuggerSession.acquire(7)
    await debuggerSession.acquire(7)
    expect(debuggerMock!.attach).toHaveBeenCalledTimes(1)
    expect(debuggerMock!.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')

    await debuggerSession.release(7)
    // First release just drops the refcount; still attached.
    expect(debuggerMock!.detach).not.toHaveBeenCalled()
    await debuggerSession.release(7)
    expect(debuggerMock!.detach).toHaveBeenCalledTimes(1)
  })

  it('re-attaches a fresh tab after a full release cycle', async () => {
    await debuggerSession.acquire(9)
    await debuggerSession.release(9)
    await debuggerSession.acquire(9)
    expect(debuggerMock!.attach).toHaveBeenCalledTimes(2)
  })

  it('release on a tab we never acquired does not detach', async () => {
    // A failed acquire must not later tear down a debugger we never attached.
    await debuggerSession.release(11)
    expect(debuggerMock!.attach).not.toHaveBeenCalled()
    expect(debuggerMock!.detach).not.toHaveBeenCalled()
  })

  it('serializes concurrent acquires so only one attach happens and counts stay balanced', async () => {
    await Promise.all([debuggerSession.acquire(12), debuggerSession.acquire(12)])
    expect(debuggerMock!.attach).toHaveBeenCalledTimes(1)
    await Promise.all([debuggerSession.release(12), debuggerSession.release(12)])
    expect(debuggerMock!.detach).toHaveBeenCalledTimes(1)
  })
})

describe('debuggerSession persist-hold', () => {
  it('holds a tab attached until releaseHold, surviving per-operation acquire/release', async () => {
    await debuggerSession.hold(20)
    expect(debuggerMock!.attach).toHaveBeenCalledTimes(1)
    expect(debuggerSession.heldTabs()).toEqual([20])
    // a normal operation around the hold must not release the hold
    await debuggerSession.acquire(20)
    await debuggerSession.release(20)
    expect(debuggerMock!.detach).not.toHaveBeenCalled()
    expect(debuggerSession.isAttached(20)).toBe(true)
    // releaseHold drops the last reference -> detach
    await debuggerSession.releaseHold(20)
    expect(debuggerMock!.detach).toHaveBeenCalledTimes(1)
    expect(debuggerSession.heldTabs()).toEqual([])
  })

  it('a second hold on the same tab is idempotent', async () => {
    await debuggerSession.hold(21)
    await debuggerSession.hold(21)
    expect(debuggerMock!.attach).toHaveBeenCalledTimes(1)
    expect(debuggerSession.heldTabs()).toEqual([21])
    await debuggerSession.releaseHold(21)
    expect(debuggerMock!.detach).toHaveBeenCalledTimes(1)
  })

  it('releaseAllHolds detaches every held tab', async () => {
    await debuggerSession.hold(22)
    await debuggerSession.hold(23)
    expect(debuggerMock!.attach).toHaveBeenCalledTimes(2)
    await debuggerSession.releaseAllHolds()
    expect(debuggerMock!.detach).toHaveBeenCalledTimes(2)
    expect(debuggerSession.heldTabs()).toEqual([])
  })

  it('a failed hold does not attach and a later releaseHold is a no-op for that tab', async () => {
    debuggerMock!.setFailAttach(true)
    await expect(debuggerSession.hold(24)).rejects.toThrow()
    expect(debuggerMock!.attach).toHaveBeenCalledTimes(1)
    expect(debuggerSession.heldTabs()).toEqual([])
    debuggerMock!.setFailAttach(false)
    await debuggerSession.releaseHold(24)
    expect(debuggerMock!.detach).not.toHaveBeenCalled()
  })
})
describe('replayMouseSteps', () => {
  it('replays each step as a real Input.dispatchMouseEvent and attaches once', async () => {
    const steps: MouseStep[] = [
      { type: 'mouseMoved', x: 120, y: 140, buttons: 0, pauseAfterMs: 40 },
      { type: 'mousePressed', x: 120, y: 140, button: 'left', buttons: 1, clickCount: 1, pauseAfterMs: 60 },
      { type: 'mouseReleased', x: 120, y: 140, button: 'left', buttons: 0, clickCount: 1, pauseAfterMs: 60 },
    ]
    await replayMouseSteps(42, steps)

    expect(debuggerMock!.attach).toHaveBeenCalledTimes(1)
    expect(debuggerMock!.detach).toHaveBeenCalledTimes(1)
    expect(debuggerMock!.sendCommand).toHaveBeenCalledTimes(steps.length)

    const method = debuggerMock!.sendCommand.mock.calls[0]![1] as string
    expect(method).toBe('Input.dispatchMouseEvent')
    const params = debuggerMock!.sendCommand.mock.calls[0]![2] as Record<string, unknown>
    expect(params.type).toBe('mouseMoved')
    expect(params.x).toBe(120)
    expect(params.y).toBe(140)
    expect(params.pointerType).toBe('mouse')
    expect(params.button).toBe('none')

    const pressParams = debuggerMock!.sendCommand.mock.calls[1]![2] as Record<string, unknown>
    expect(pressParams.type).toBe('mousePressed')
    expect(pressParams.button).toBe('left')
    expect(pressParams.buttons).toBe(1)
    expect(pressParams.clickCount).toBe(1)
  })

  it('sends wheel deltas with the cursor position and detaches cleanly', async () => {
    const steps: MouseStep[] = [
      { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: 120, buttons: 0 },
    ]
    await replayMouseSteps(5, steps)
    const params = debuggerMock!.sendCommand.mock.calls[0]![2] as Record<string, unknown>
    expect(params.type).toBe('mouseWheel')
    expect(params.deltaX).toBe(0)
    expect(params.deltaY).toBe(120)
    expect(params.x).toBe(10)
  })

  it('propagates an attach failure (so the caller can fall back) without detaching', async () => {
    debuggerMock!.setFailAttach(true)
    await expect(replayMouseSteps(3, [
      { type: 'mouseMoved', x: 0, y: 0, buttons: 0, pauseAfterMs: 0 },
    ])).rejects.toThrow()
    expect(debuggerMock!.detach).not.toHaveBeenCalled()
  })
})
