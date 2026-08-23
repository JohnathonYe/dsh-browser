/**
 * Model-facing browser page context injected after an explicit tab handoff.
 *
 * The extension captures the page immediately after the user chooses to
 * follow it. A live Agent receives that snapshot at once; a deferred session
 * keeps only its newest snapshot until `agent/session-start` publishes the
 * Agent. Injection deliberately does not wake an idle Agent — the snapshot is
 * claimed together with the user's next message.
 *
 * @module
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Provenance key used for snapshot supersession and transcript presentation. */
export const BROWSER_CONTEXT_PLUGIN = '@yuxianglin/dsh-bridge-browser'

/** Bound orphaned provisional sessions while retaining normal recent tabs. */
const DEFAULT_MAX_PENDING = 32

/** Build one immutable context message from a captured browser snapshot. */
export function createBrowserSnapshotMessage(snapshot: string): UserMessage {
  const text = [
    'The user chose to follow the newly active browser tab. The browser page context was refreshed immediately after that choice.',
    'The following is an already completed browser_snapshot of the current page. Use its stable indices directly for the next request; do not take an immediate duplicate snapshot unless required context is missing.',
    snapshot,
  ].join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: BROWSER_CONTEXT_PLUGIN,
      form: 'snapshot',
      sections: [{ name: 'browser-page', text }],
    },
  })
}

/** One plugin-supplied screenshot caption for the image's provenance surface. */
const SCREENSHOT_DESCRIPTION = 'A screenshot of the controlled browser tab, captured on request.'

/** Build one context message carrying a single image block. */
export function createBrowserImageMessage(attachment: ImageAttachmentRef): UserMessage {
  return createUserMessage({
    content: [{ type: 'image', attachment }],
    source: {
      kind: 'plugin',
      plugin: BROWSER_CONTEXT_PLUGIN,
      form: 'snapshot',
      sections: [{ name: 'browser-screenshot', text: SCREENSHOT_DESCRIPTION }],
    },
  })
}

/** Deliver followed-page snapshots to live or not-yet-materialized Agents. */
export class BrowserContextInjector {
  private readonly pending = new Map<string, string>()
  private readonly pendingImages = new Map<string, ImageAttachmentRef>()

  constructor(
    private readonly agents: Pick<AgentRegistry, 'get'>,
    private readonly maxPending = DEFAULT_MAX_PENDING,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('browser context maxPending must be a positive integer')
    }
  }

  /** Inject now when possible; otherwise retain the newest snapshot per session. */
  inject(sessionId: string, snapshot: string): 'injected' | 'queued' {
    const agent = this.agents.get(sessionId as Parameters<AgentRegistry['get']>[0])
    if (agent !== undefined) {
      this.pending.delete(sessionId)
      agent.inject(createBrowserSnapshotMessage(snapshot))
      return 'injected'
    }

    // Refresh insertion order when the same provisional session follows again.
    this.pending.delete(sessionId)
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.pending.set(sessionId, snapshot)
    return 'queued'
  }

  /**
   * Inject one captured screenshot as an image message into a live session, or
   * retain the newest per session until the Agent materializes.
   */
  injectImage(sessionId: string, attachment: ImageAttachmentRef): 'injected' | 'queued' {
    const agent = this.agents.get(sessionId as Parameters<AgentRegistry['get']>[0])
    if (agent !== undefined) {
      this.pendingImages.delete(sessionId)
      agent.inject(createBrowserImageMessage(attachment))
      return 'injected'
    }

    this.pendingImages.delete(sessionId)
    while (this.pendingImages.size >= this.maxPending) {
      const oldest = this.pendingImages.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.pendingImages.delete(oldest)
    }
    this.pendingImages.set(sessionId, attachment)
    return 'queued'
  }

  /** Flush one provisional session at the supported Agent startup boundary. */
  activate(agent: Agent): boolean {
    const sessionId = String(agent.id)
    const snapshot = this.pending.get(sessionId)
    if (snapshot !== undefined) {
      agent.inject(createBrowserSnapshotMessage(snapshot))
      this.pending.delete(sessionId)
    }
    const image = this.pendingImages.get(sessionId)
    if (image !== undefined) {
      agent.inject(createBrowserImageMessage(image))
      this.pendingImages.delete(sessionId)
    }
    return snapshot !== undefined || image !== undefined
  }
}
