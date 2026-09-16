/**
 * Harness-compatibility contract for the agent-creation flush.
 *
 * `agent/session-start` was removed in `@deepseek-ai/dsh@0.1.6-alpha.1`; the
 * replacement is `agent/created` (now async/serial and awaited before queued
 * input is released). The same event also exists on 0.1.5-rc.1/rc.2, emitted by
 * the AgentRegistry once an agent enters it with a live session and completed
 * setup — so one subscription covers both.
 *
 * On 0.1.6 a rejecting listener can roll back agent creation, so the flush must
 * never let an error escape.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { BrowserContextInjector } from '../src/browser-context.ts'
import { apply, registerAgentCreatedFlush } from '../src/index.ts'

type Listener = (payload: { agent: Agent }) => unknown

/** Context stub that records event subscriptions instead of dropping them. */
function recordingContext(): {
  ctx: Context
  names: () => string[]
  emit: (name: string, payload: { agent: Agent }) => unknown[]
  warnings: string[]
} {
  const listeners = new Map<string, Listener[]>()
  const warnings: string[] = []
  const ctx = {
    connection: { createSharedFetchHandler: () => ({ fetch: async () => new Response() }) },
    webServer: { port: 0, registerUpgrade: () => () => {}, register: () => () => {} },
    tools: { register: () => () => {} },
    agents: { get: () => undefined },
    get: () => undefined,
    on: (name: string, listener: Listener) => {
      const bucket = listeners.get(name) ?? []
      bucket.push(listener)
      listeners.set(name, bucket)
      return () => {}
    },
    logger: {
      info: () => {},
      warn: (message: string) => { warnings.push(message) },
      error: () => {},
    },
    effect: (fn: () => unknown) => fn() as () => void,
  } as unknown as Context
  return {
    ctx,
    names: () => [...listeners.keys()],
    emit: (name, payload) => (listeners.get(name) ?? []).map((listener) => listener(payload)),
    warnings,
  }
}

/** An injector whose registry never reports a live agent (provisional session). */
function deferredInjector(): BrowserContextInjector {
  const agents = { get: () => undefined } as unknown as Pick<AgentRegistry, 'get'>
  return new BrowserContextInjector(agents)
}

function fakeAgent(id: string, inject: Agent['inject']): Agent {
  return { id, inject } as unknown as Agent
}

const VALID = {
  toolTimeoutMs: 90_000,
  snapshotMaxChars: 32_000,
  maxInteractiveItems: 60,
  sessionWorkspacePath: '',
}

describe('agent-creation boundary', () => {
  it('subscribes to agent/created and never to the removed agent/session-start', async () => {
    const { ctx, names } = recordingContext()

    await apply(ctx, { token: 'fixed-token', ...VALID })

    expect(names()).toContain('agent/created')
    expect(names()).not.toContain('agent/session-start')
  })

  it('flushes a snapshot queued before the agent materialized', () => {
    const { ctx, emit } = recordingContext()
    const injector = deferredInjector()
    expect(injector.inject('session-later', 'Queued page')).toBe('queued')
    registerAgentCreatedFlush(ctx, injector)

    const inject = vi.fn()
    const results = emit('agent/created', { agent: fakeAgent('session-later', inject as unknown as Agent['inject']) })

    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]![0].content[0].text).toContain('Queued page')
    // 0.1.6 awaits the listener's return value; it must stay undefined.
    expect(results).toEqual([undefined])
  })

  it('leaves an unrelated session untouched', () => {
    const { ctx, emit } = recordingContext()
    const injector = deferredInjector()
    injector.inject('session-other', 'Other page')
    registerAgentCreatedFlush(ctx, injector)

    const inject = vi.fn()
    emit('agent/created', { agent: fakeAgent('session-later', inject as unknown as Agent['inject']) })

    expect(inject).not.toHaveBeenCalled()
  })

  it('contains a failing injection so agent creation is never rolled back', () => {
    const { ctx, emit, warnings } = recordingContext()
    const injector = deferredInjector()
    injector.inject('session-boom', 'Queued page')
    registerAgentCreatedFlush(ctx, injector)

    const inject = (() => { throw new Error('session write path closed') }) as unknown as Agent['inject']

    expect(() => emit('agent/created', { agent: fakeAgent('session-boom', inject) })).not.toThrow()
    expect(warnings.join('\n')).toContain('session write path closed')
  })
})
