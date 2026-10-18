/**
 * Stable loopback discovery endpoint.
 *
 * The bridge's main HTTP/WebSocket routes live on the host web server, whose
 * port may change between launches (the desktop app picks a random one). The
 * extension can only probe fixed ports, so a random host port makes the bridge
 * undiscoverable after a restart. This small extra listener binds a fixed
 * loopback port and exposes the same discovery contract:
 *
 *   GET /ext/bridge-config -> {"wsUrl":"ws://127.0.0.1:<fixed>/ext/bridge"}
 *   Upgrade /ext/bridge    -> the real BridgeServer
 *
 * It is loopback-only, serves no secret, and does not weaken the bridge's own
 * token/origin authentication.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Options for the fixed discovery listener. */
export interface FixedDiscoveryOptions {
  /** Loopback port to bind. */
  port: number
  /** WebSocket upgrade path understood by the bridge. */
  bridgePath: string
  /** Discovery JSON path. */
  configPath: string
  /** Forward an accepted upgrade to the real BridgeServer. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

/** Path portion of a request URL, without the query string. */
function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? ''
}

/**
 * Create (but do not listen on) the fixed discovery server. Unknown paths get
 * a 404; upgrades outside the bridge path are destroyed.
 */
export function createFixedDiscoveryServer(options: FixedDiscoveryOptions): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && pathOf(req.url) === options.configPath) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${options.port}${options.bridgePath}` }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOf(req.url) !== options.bridgePath) {
      socket.destroy()
      return
    }
    options.handleUpgrade(req, socket, head)
  })
  // A malformed HTTP request must not crash the DSH process.
  server.on('clientError', (_error, socket) => { socket.destroy() })
  return server
}

/** Resolve once the fixed listener is bound on loopback, or throw its bind error. */
export function listenFixedDiscoveryServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
    const onListening = (): void => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/** Close the fixed listener and resolve when its socket is released. */
export function closeFixedDiscoveryServer(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()) })
}
