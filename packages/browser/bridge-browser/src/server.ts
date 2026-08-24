/**
 * Bridge WebSocket carrier: token-authenticated connection registry, gateway
 * RPC passthrough, per-connection event pump, and tool-call dispatch to a
 * chosen browser extension instance.
 *
 * The route this server mounts (`/ext/bridge`) lives OUTSIDE the /api trust
 * fence (which only guards the client-connection routes), so the bridge brings
 * its own authentication: a bearer token presented in the `hello` frame within
 * HELLO_TIMEOUT_MS. Gateway RPCs are dispatched through the same fetch-shaped
 * handler the /api carrier uses (`toFetchHandler`), so schema validation and
 * error envelopes are identical to the GUI path. Methods the /api carrier
 * pins to loopback (`PRIVILEGED_METHODS`) stay loopback-only here regardless
 * of the token, defense in depth for `--host 0.0.0.0` deployments.
 *
 * Multiple browser instances (one per Chrome/Firefox profile) may connect at
 * once; each is keyed by a stable per-install `instanceId` presented in
 * `hello` and keeps its own event pump. Rather than a single active slot with
 * 4000-preemption, the server holds a connection registry and routes every
 * `tool.call` to the currently selected instance. Selection is explicit (the
 * UI / panel lists instances and lets the user pick); a single connected
 * instance is auto-selected so the single-browser flow stays unchanged.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseBridgeFrame,
  type BridgeFrame,
  type BridgeCaps,
  type BrowserInstance,
  type ClientFrame,
  type ToolErrorCode,
} from './protocol.ts'
import { verifyToken } from './token.ts'

/**
 * Gateway methods the /api carrier pins to loopback (mirror of
 * client-connection's PRIVILEGED_METHODS; kept verbatim so the two fences
 * cannot drift). The bridge rejects these for non-loopback remotes even with
 * a valid token.
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/** Session mutations whose WebSocket arrival order is behaviorally significant. */
const ORDERED_SESSION_METHODS = new Set([
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  'session.prompt',
  'session.cancel',
])

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Bearer token the extension must present in `hello`. */
  token: string
  /** Fetch-shaped gateway carrier (from `toFetchHandler(ctx.apiProxy)`). */
  apiHandler: { fetch: (request: Request) => Promise<Response> }
  /** Per-connection event stream (usually `ctx.apiProxy.events.mux`). */
  openEvents: (signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame>>
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (negotiated snapshot budgets). */
  caps: BridgeCaps
  /** Seed a followed-page snapshot into a live or deferred Agent session. */
  injectBrowserSnapshot: (sessionId: string, snapshot: string) => void | Promise<void>
  /**
   * Test seam: force the remote address seen by the privilege gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /** Seconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
}

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
  /** The instance the call was dispatched to; only its reply settles the call. */
  instanceId: string
}

/** An authenticated socket owning one registry slot (keyed by instanceId). */
interface ReadyConnection {
  ws: WebSocket
  /** Remote address captured at upgrade time (loopback gate for privileged methods). */
  remoteAddress: string | undefined
  /** Stable per-install id presented in `hello`. */
  instanceId: string
  /** Human-friendly label for the instance list UI. */
  label: string
  /** Number of open tabs reported in `hello` (0 when absent). */
  tabCount: number
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
}

function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  /* v8 ignore next -- teardown race: the socket can die between a pump's
  readiness check and this write; the guard refuses writes on dead sockets */
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * Decode one ws message payload to text. Exported so all three delivery
 * shapes (fragmented buffer list, Buffer, ArrayBuffer) are unit-testable
 * directly — node ws only ever delivers Buffers in practice.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  /** Connected browser instances keyed by stable per-install instanceId. */
  private readonly connections = new Map<string, ReadyConnection>()
  /** The instance that receives tool calls; null until an explicit choice. */
  private selectedInstanceId: string | null = null
  /** Whether selectedInstanceId came from an explicit user choice (vs auto-selected). */
  private selectedExplicit = false
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    const origin = req.headers.origin
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote, origin) })
  }

  /**
   * Request one browser action from the selected extension instance.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @returns the extension's action result.
   * @throws BridgeToolError when no instance is selected / connected, the call
   *   times out, is cancelled, or the extension reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
  ): Promise<unknown> {
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const conn = this.resolveSelectedConnection()
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', this.selectionErrorMessage())
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer, instanceId: conn.instanceId })
      conn.ws.send(JSON.stringify({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame), (error) => {
        /* v8 ignore next -- teardown race: when the write fails, the socket's
        close handler settles the same call with the same code; the callback
        path is a defensive second settle, covered via the close path */
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  async close(): Promise<void> {
    // Idempotent: a second close must not touch the acceptor (ws throws
    // "The server is not running" when closing an already-closed server).
    if (this.closed) return
    this.closed = true
    // Capture the live pumps BEFORE the registry is torn down.
    const pumps: Promise<void>[] = []
    for (const conn of this.connections.values()) pumps.push(conn.pump)
    this.releaseAll()
    for (const socket of this.wss.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        /* v8 ignore next -- acceptor close cannot fail: close() is idempotent
        and the noServer acceptor only reports teardown of already-terminated clients */
        if (error === undefined) resolve()
        /* v8 ignore next -- same unreachable arm */
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns whether at least one authenticated extension is connected. */
  hasConnection(): boolean {
    return this.connections.size > 0
  }

  /** @returns the connected instances (for the panel / selection UI). */
  listInstances(): BrowserInstance[] {
    return [...this.connections.values()].map((conn) => ({ instanceId: conn.instanceId, label: conn.label, tabCount: conn.tabCount }))
  }

  /** @returns the currently selected instance id, or null when none. */
  selectedInstance(): string | null {
    return this.selectedInstanceId
  }

  /**
   * Choose which instance receives tool calls. The choice is explicit (it
   * stays authoritative even when multiple instances are connected).
   * @param instanceId - the target instance id.
   * @returns true when accepted, false when the instance is not connected.
   */
  selectInstance(instanceId: string): boolean {
    if (!this.connections.has(instanceId)) return false
    this.selectedInstanceId = instanceId
    this.selectedExplicit = true
    this.broadcastInstances()
    return true
  }

  /**
   * Resolve the connection that should receive a tool call. When exactly one
   * instance is connected and no selection exists, that instance is chosen as
   * the default (single-browser flow stays indistinguishable from before).
   * @returns the selected connection, or null when it cannot be decided.
   */
  private resolveSelectedConnection(): ReadyConnection | null {
    if (this.selectedInstanceId !== null) {
      const selected = this.connections.get(this.selectedInstanceId)
      if (selected !== undefined) return selected
      // The selected instance disconnected; fall through to a fresh decision.
      this.selectedInstanceId = null
      this.selectedExplicit = false
    }
    if (this.connections.size === 1) {
      const [instanceId, conn] = [...this.connections.entries()][0]!
      this.selectedInstanceId = instanceId
      this.selectedExplicit = false
      return conn
    }
    return null
  }

  /**
   * Recompute the active selection after a connect/disconnect. A single
   * connected instance is auto-selected so the single-browser flow stays
   * unchanged; when multiple instances are connected, only an explicit user
   * choice remains authoritative (an auto-selected default is cleared so the
   * user is asked to pick).
   */
  private recomputeSelection(): void {
    if (this.selectedInstanceId !== null && !this.connections.has(this.selectedInstanceId)) {
      this.selectedInstanceId = null
      this.selectedExplicit = false
    }
    if (this.selectedInstanceId === null && this.connections.size === 1) {
      this.selectedInstanceId = this.connections.keys().next().value as string
      this.selectedExplicit = false
      return
    }
    if (!this.selectedExplicit && this.connections.size > 1) {
      this.selectedInstanceId = null
    }
  }

  /** Human-readable guidance when no instance can be targeted. When several
   * instances are connected, the message carries each instance's id and label
   * so a model can hand the choice to an ask-user facility and then call
   * `browser_select_instance`. */
  private selectionErrorMessage(): string {
    if (this.connections.size === 0) {
      return 'no browser extension is connected to the bridge'
    }
    const parts = [...this.connections.values()]
      .map((conn) => `[instanceId=${conn.instanceId}, label=${conn.label}, tabCount=${conn.tabCount}]`)
    const selected = this.selectedInstanceId === null ? 'none' : this.selectedInstanceId
    return `multiple browser instances are connected; select one before issuing browser actions. `
      + `Available: ${parts.join(', ')} (selected: ${selected})`
  }

  private broadcastInstances(): void {
    const instances = this.listInstances()
    const selected = this.selectedInstanceId
    for (const conn of this.connections.values()) {
      sendFrame(conn.ws, { t: 'instances', instances, selected })
    }
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined, origin: string | undefined): void {
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        ws.close(1008, 'unparseable frame')
        return
      }
      if (helloTimer !== undefined) {
        // Pending state: only `hello` is legal.
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        // Zero-config local mode: loopback sockets skip the token (the
        // extension auto-discovers the bridge and connects without setup).
        // WebSockets have no same-origin policy, so a malicious page could
        // open a cross-origin socket to 127.0.0.1 with a loopback remote —
        // the loopback shortcut therefore requires a chrome-extension://
        // Origin (only extension contexts can present one; pages cannot
        // forge the header). Firefox moz-extension:// origins contain a
        // per-install UUID rather than the manifest's stable Gecko ID, so
        // they are not an identity boundary and must present the bearer token.
        // Non-loopback remotes must also present the bearer token.
        const loopbackNoToken = isLoopbackAddress(remoteAddress)
          && typeof origin === 'string'
          && origin.startsWith('chrome-extension://')
        if (!loopbackNoToken && !verifyToken(this.deps.token, frame.token)) {
          ws.close(4002, 'bad token')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        this.promote(ws, remoteAddress, frame.instanceId ?? `anon-${randomUUID()}`, frame.label, frame.tabCount)
        return
      }
      const conn = this.connectionFor(ws)
      if (conn !== undefined) this.handleReadyFrame(frame, conn)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      this.dropConnection(ws)
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** Promote an authenticated socket to a registry slot keyed by instanceId. */
  private promote(ws: WebSocket, remoteAddress: string | undefined, instanceId: string, label?: string, tabCount?: number): void {
    // Re-connecting the same instance (a reload or reconnect) replaces that
    // slot only; distinct instances coexist without 4000-preemption.
    if (this.connections.has(instanceId)) {
      this.dropConnection(this.connections.get(instanceId)!.ws, instanceId)
    }
    const abort = new AbortController()
    const ping = setInterval(() => { sendFrame(ws, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const envelope of this.deps.openEvents(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          sendFrame(ws, {
            t: 'event',
            frame: { rpcId: envelope.rpcId, method: envelope.payload.type, payload: envelope.payload },
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendFrame(ws, { t: 'error', code: 'stream-failed', message: String(error) })
        }
      }
    })()
    const conn: ReadyConnection = {
      ws,
      remoteAddress,
      instanceId,
      label: label ?? instanceId.slice(0, 8),
      tabCount: tabCount ?? 0,
      abort,
      pump,
      ping,
    }
    this.connections.set(instanceId, conn)
    // Auto-select a sole instance so the single-browser flow is unchanged; a
    // second concurrent instance clears an auto (non-explicit) default.
    this.recomputeSelection()
    sendFrame(ws, { t: 'hello.ok', caps: this.deps.caps })
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
    this.broadcastInstances()
  }

  /** Look up the registry entry owning a socket. */
  private connectionFor(ws: WebSocket): ReadyConnection | undefined {
    for (const conn of this.connections.values()) {
      if (conn.ws === ws) return conn
    }
    return undefined
  }

  /** Remove a connection from the registry and settle its pending work. */
  private dropConnection(ws: WebSocket, expectedInstanceId?: string): void {
    const found = this.connectionFor(ws)
    if (found === undefined) return
    if (expectedInstanceId !== undefined && found.instanceId !== expectedInstanceId) return
    this.connections.delete(found.instanceId)
    clearInterval(found.ping)
    found.abort.abort()
    if (found.ws.readyState === WebSocket.OPEN || found.ws.readyState === WebSocket.CONNECTING) {
      found.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      if (pending.instanceId !== found.instanceId) continue
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was closed'))
    }
    this.recomputeSelection()
    this.broadcastInstances()
  }

  /** Drop every connection (used by close()). */
  private releaseAll(): void {
    for (const conn of [...this.connections.values()]) {
      clearInterval(conn.ping)
      conn.abort.abort()
      if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
        conn.ws.close(4000, 'server closing')
      }
    }
    this.connections.clear()
    this.selectedInstanceId = null
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the bridge server closed'))
    }
  }

  private handleReadyFrame(frame: BridgeFrame, conn: ReadyConnection): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame, conn)
        break
      case 'respond':
        void this.handleRespond(frame, conn)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error, conn.instanceId)
        break
      case 'select.instance':
        // Only accept a selection for an instance that is actually connected.
        if (this.connections.has(frame.instanceId)) {
          this.selectedInstanceId = frame.instanceId
          this.selectedExplicit = true
          this.broadcastInstances()
        }
        break
      case 'pong':
      case 'hello':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'instances':
      case 'error':
        // Protocol violations and unsolicited server-side shapes are ignored;
        // the extension is the only sender on this channel.
        break
    }
  }

  /**
   * Preserve prompt/cancel arrival order per session. In particular, the
   * first prompt may still be materializing a provisional session; its cancel
   * must not reach the gateway until that admission has completed.
   */
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>, conn: ReadyConnection): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame, conn)
      return
    }
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame, conn),
      () => this.handleRpc(frame, conn),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>, conn: ReadyConnection): Promise<void> {
    const forbidden = PRIVILEGED_METHODS.has(frame.method) && !isLoopbackAddress(conn.remoteAddress)
    if (forbidden) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'method is loopback-only' } })
      return
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId and snapshot must be non-empty strings' },
        })
        return
      }
      try {
        await this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      }
      return
    }
    const body = JSON.stringify({ type: 'client-request', rpcId: frame.id, method: frame.method, payload: frame.payload })
    const request = new Request(new URL(`/api/${frame.method}`, 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    try {
      const response = await this.deps.apiHandler.fetch(request)
      const text = await response.text()
      if (!response.ok) {
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'http', message: text } })
        return
      }
      let result: unknown
      try {
        result = JSON.parse(text)
      } catch {
        result = text
      }
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  /** Relay a pending host-interaction response through the GUI's /api/respond channel. */
  private async handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>, conn: ReadyConnection): Promise<void> {
    const request = new Request(new URL('/api/respond', 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: frame.rpcId, result: frame.result }),
    })
    try {
      const response = await this.deps.apiHandler.fetch(request)
      const text = await response.text()
      if (!response.ok) {
        sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'http', message: text } })
        return
      }
      let result: unknown
      try {
        result = JSON.parse(text)
      } catch {
        result = text
      }
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  private settleTool(id: string, ok: boolean, payload: unknown, instanceId: string): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    // Only the instance the call was dispatched to may settle it; a reply from
    // any other (unselected) instance is ignored.
    if (pending.instanceId !== instanceId) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
  }
}

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  return { sessionId, snapshot }
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * Tool error payload → stable code. The wire parser enforces string fields,
 * so the fallback branches are parser-gated; exported so the fallback
 * contract is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the stable error code.
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * Tool error payload → message. The wire parser enforces string fields, so
 * the fallback branches are parser-gated; exported so the fallback contract
 * is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the human-readable message.
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'browser action failed'
  }
  return 'browser action failed'
}
