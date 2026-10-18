import { createServer as createNetServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import {
  closeFixedDiscoveryServer,
  createFixedDiscoveryServer,
  listenFixedDiscoveryServer,
} from '../src/discovery.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Ask the OS for a currently free loopback port, then release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('no port'))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

describe('fixed discovery listener', () => {
  it('serves the stable ws url and forwards upgrades to the bridge', async () => {
    const port = await freePort()
    const wss = new WebSocketServer({ noServer: true })
    cleanups.push(() => new Promise<void>((resolve) => { wss.close(() => resolve()) }))
    const server = createFixedDiscoveryServer({
      port,
      bridgePath: '/ext/bridge',
      configPath: '/ext/bridge-config',
      handleUpgrade: (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => { ws.send('bridge-ok') })
      },
    })
    await listenFixedDiscoveryServer(server, port)
    cleanups.push(() => closeFixedDiscoveryServer(server))

    const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`)
    expect(response.status).toBe(200)
    const body = await response.json() as { wsUrl?: unknown }
    expect(body.wsUrl).toBe(`ws://127.0.0.1:${port}/ext/bridge`)

    const ws = new WebSocket(body.wsUrl as string)
    cleanups.push(() => new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close() }))
    const message = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(data.toString()))
      ws.once('error', reject)
    })
    expect(message).toBe('bridge-ok')
  })

  it('returns 404 for unknown HTTP paths', async () => {
    const port = await freePort()
    const server = createFixedDiscoveryServer({
      port,
      bridgePath: '/ext/bridge',
      configPath: '/ext/bridge-config',
      handleUpgrade: () => {},
    })
    await listenFixedDiscoveryServer(server, port)
    cleanups.push(() => closeFixedDiscoveryServer(server))
    expect((await fetch(`http://127.0.0.1:${port}/not-the-bridge`)).status).toBe(404)
  })
})
