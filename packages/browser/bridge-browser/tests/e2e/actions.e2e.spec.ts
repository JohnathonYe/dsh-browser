/**
 * Deterministic browser-action e2e: the REAL extension, the REAL bridge, and a
 * local test page, driven through the model-facing tool definitions in-process
 * (no model, no tokens burned). This is the regression net for input fidelity:
 * real keyboard events, right/double click, native select, file upload,
 * condition waits, batch execution, and page observation.
 *
 * Self-skips when there is no Playwright Chromium, no built extension dist, or
 * the bridge discovery port 3080 is already in use (the extension probes 3080
 * first, so the suite must own it to avoid talking to another dsh instance).
 */

import { createServer, type Server } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { chromium, type BrowserContext, type Worker } from 'playwright-core'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LlmService from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as BridgeBrowser from '../../src/index.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const BRIDGE = '@yuxianglin/dsh-bridge-browser'
const TOKEN = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const DISCOVERY_PORT = 3080

const TestCarrier = {
  name: 'test:carrier',
  inject: ['sessions'],
  apply(ctx: Context, config: { cwd: string }): void {
    const handler = {
      fetch: async (request: Request): Promise<Response> => {
        const body = await request.json() as {
          rpcId: string
          method: string
          payload?: { args?: Record<string, unknown> }
        }
        const args = body.payload?.args ?? {}
        if (body.method === 'session/create') {
          const meta = { cwd: typeof args.cwd === 'string' ? args.cwd : config.cwd }
          const session = ctx.sessions.create(undefined, { meta })
          return Response.json({
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: true, value: { sessionId: session.id } },
          })
        }
        return new Response(`unclaimed endpoint: ${body.method}`, { status: 404 })
      },
    }
    ctx.provide('connection', { createSharedFetchHandler: () => handler } as never)
  },
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Action e2e</title></head>
<body>
<main>
  <h1>Action e2e</h1>
  <form id="form" onsubmit="event.preventDefault()">
    <label>Name <input id="name" aria-label="Name" value="OLD"></label>
    <label>Email <input id="email" aria-label="Email"></label>
    <label>Search <input id="search" aria-label="Search"></label>
    <label>City
      <select id="city" aria-label="City">
        <option value="sh">Shanghai</option>
        <option value="bj">Beijing</option>
        <option value="gz">Guangzhou</option>
      </select>
    </label>
    <label>Attachment <input id="file" type="file" aria-label="Attachment"></label>
    <button id="submit" type="submit">Submit</button>
  </form>
  <button id="right" type="button">Right target</button>
  <button id="dbl" type="button">Double target</button>
  <button id="lazy" type="button">Load late</button>
  <button id="warn" type="button">Cause error</button>
  <button id="arm" type="button">Arm dialog</button>
  <button id="reset" type="button">Reset</button>
  <div id="state"></div>
  <div id="keys"></div>
</main>
<script>
  const state = document.getElementById('state')
  const keys = document.getElementById('keys')
  const set = (value) => { state.textContent = value }
  document.getElementById('name').addEventListener('input', (event) => set('name:' + event.target.value))
  document.addEventListener('focusin', (event) => {
    if (event.target && event.target.id) set('focus:' + event.target.id)
  })
  document.getElementById('search').addEventListener('keydown', (event) => {
    keys.textContent += event.key + ':' + event.code + ' '
  })
  document.getElementById('city').addEventListener('change', (event) => set('city:' + event.target.value))
  document.getElementById('file').addEventListener('change', (event) => {
    set('file:' + (event.target.files && event.target.files[0] ? event.target.files[0].name : 'none'))
  })
  document.getElementById('right').addEventListener('contextmenu', (event) => {
    event.preventDefault()
    set('right:yes')
  })
  document.getElementById('dbl').addEventListener('dblclick', () => set('dbl:yes'))
  document.getElementById('lazy').addEventListener('click', () => {
    setTimeout(() => {
      const late = document.createElement('div')
      late.id = 'late'
      late.textContent = 'late-ready'
      document.querySelector('main').append(late)
    }, 300)
  })
  document.getElementById('warn').addEventListener('click', () => {
    console.error('e2e-console-error')
    fetch('/missing-resource').catch(() => {})
  })
  document.getElementById('arm').addEventListener('click', () => {
    setTimeout(() => {
      const accepted = confirm('e2e-confirm')
      set('dialog:' + accepted)
    }, 300)
  })
  document.getElementById('reset').addEventListener('click', () => {
    set('reset')
    keys.textContent = ''
  })
</script>
</body></html>`

/** Locate a full Chromium (extension-capable) in the Playwright cache. */
function chromiumExecutable(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const cacheRoot = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cacheRoot)) return undefined
  for (const entry of readdirSync(cacheRoot)) {
    if (!/^chromium-\d+$/u.test(entry)) continue
    const candidates = [
      join(cacheRoot, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cacheRoot, entry, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cacheRoot, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(cacheRoot, entry, 'chrome-linux', 'chrome'),
    ]
    for (const candidate of candidates) if (existsSync(candidate)) return candidate
  }
  return undefined
}

const EXTENSION_DIR = resolve(import.meta.dirname, '../../../../../extensions/dsh-browser/dist')
const executable = chromiumExecutable()
const enabled = executable !== undefined && existsSync(join(EXTENSION_DIR, 'manifest.json'))

interface ToolOutcome {
  text: string
  isError: boolean
  error?: string
  value?: unknown
}

let context: Context | undefined
let root: string | undefined
let pageServer: Server | undefined
let pageUrl: string | undefined
let browser: BrowserContext | undefined
let worker: Worker | undefined

async function bootComposition(): Promise<Context> {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-actions-e2e-'))
  root = temp
  const configPath = join(temp, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${DISCOVERY_PORT}`,
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: 'test:carrier'",
    '  config:',
    `    cwd: '${temp}'`,
    `- name: '${BRIDGE}'`,
    '  config:',
    `    token: '${TOKEN}'`,
    `    sessionWorkspacePath: '${join(temp, 'browser-sessions')}'`,
    '    deferSessionCreate: false',
    '    discoveryPort: 0',
    '',
  ].join('\n'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(temp).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRegistry],
    ['@deepseek-ai/dsh-llm', LlmService],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['test:carrier', TestCarrier],
    [BRIDGE, BridgeBrowser],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function startPageServer(): Promise<string> {
  pageServer = createServer((request, response) => {
    if (request.url?.startsWith('/missing-resource') === true) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('missing')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(request.url?.startsWith('/second') === true ? PAGE.replace('Action e2e', 'Second page') : PAGE)
  })
  await new Promise<void>((resolveListen, reject) => {
    pageServer!.once('error', reject)
    pageServer!.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = pageServer.address()
  if (address === null || typeof address === 'string') throw new Error('test page server did not bind')
  return `http://127.0.0.1:${address.port}/`
}

/** Execute one model-facing tool against the live extension. */
async function run(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const tool = context!.tools.get(name) as ToolDefinition | undefined
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  const result = await context!.tools.execute({
    callId: `e2e-${name}-${Math.random().toString(16).slice(2)}` as never,
    name,
    arguments: args,
    signal: new AbortController().signal,
  }) as { isError?: boolean; value?: { text?: string }; error?: { message?: string } }
  return {
    text: result.value?.text ?? '',
    isError: result.isError === true,
    value: result.value,
    ...result.error === undefined ? {} : { error: result.error.message },
  }
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await run(name, args)
  if (result.isError) throw new Error(`${name} failed: ${result.error}`)
  return result.text
}

/** Read the page's #state/#keys text, unwrapping the untrusted-content fence. */
async function pageText(selector: string): Promise<string> {
  const text = await ok('browser_get_text', { selector })
  const fenced = text.match(/<UNTRUSTED_PAGE_CONTENT[^>]*>([\s\S]*?)<\/UNTRUSTED_PAGE_CONTENT[^>]*>/u)
  return (fenced?.[1] ?? text).trim()
}

/** Find `[index] role "name"` in a snapshot by accessible name. */
function indexOf(snapshot: string, name: string): number {
  const match = snapshot.match(new RegExp(`\\[(\\d+)\\] (?:button|input|select|link) "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'u'))
  if (match === null) throw new Error(`no [index] for "${name}" in snapshot:\n${snapshot.slice(0, 2_000)}`)
  return Number(match[1])
}

async function waitForInstance(timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await run('browser_list_instances')
    const instances = (result.value as { instances?: unknown[] } | undefined)?.instances
    if (!result.isError && Array.isArray(instances) && instances.length > 0) return
    await new Promise((resolveSleep) => { setTimeout(resolveSleep, 250) })
  }
  throw new Error('the extension never connected to the e2e bridge on port 3080')
}

beforeAll(async () => {
  if (!enabled) return
  context = await bootComposition()
  pageUrl = await startPageServer()
  const temp = root!
  browser = await chromium.launchPersistentContext(join(temp, 'chrome-profile'), {
    executablePath: executable,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  })
  worker = browser.serviceWorkers()[0]
  if (worker === undefined) worker = await browser.waitForEvent('serviceworker', { timeout: 30_000 })
  expect(await worker.evaluate(() => chrome.runtime.getManifest().name)).toBeTruthy()
  await waitForInstance()
  const created = await run('browser_new_tab', { url: pageUrl, name: 'actions-e2e' })
  if (created.isError) throw new Error(`browser_new_tab failed: ${created.error}`)
  // Wait for the page to become operable before the first test snapshot.
  await ok('browser_wait_for', { selector: '#name', timeoutMs: 15_000 })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => {})
  await new Promise<void>((resolveClose) => {
    if (pageServer === undefined) return resolveClose()
    pageServer.close(() => resolveClose())
  })
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe.skipIf(!enabled)('browser actions against the real extension', () => {
  it('types with real keyboard events and moves focus with Tab', async () => {
    const snapshot = await ok('browser_snapshot')
    await ok('browser_type', { index: indexOf(snapshot, 'Name'), text: 'Ada', replace: true })
    expect(await pageText('#state')).toBe('name:Ada')

    // Non-US-layout text travels through Input.insertText and still fires input.
    await ok('browser_type', { index: indexOf(snapshot, 'Name'), text: '中文', replace: true })
    expect(await pageText('#state')).toBe('name:中文')

    // Without replace, text appends at the end regardless of where the
    // focusing click landed.
    await ok('browser_type', { index: indexOf(snapshot, 'Name'), text: '!' })
    expect(await pageText('#state')).toBe('name:中文!')

    // Keydown reaches the page (a programmatic value write would leave #keys empty).
    await ok('browser_click', { index: indexOf(await ok('browser_snapshot'), 'Search') })
    await ok('browser_type', { index: indexOf(await ok('browser_snapshot'), 'Search'), text: 'abc', replace: true })
    expect(await pageText('#keys')).toContain('a:KeyA')
    expect(await pageText('#keys')).toContain('c:KeyC')

    await ok('browser_press', { key: 'Tab' })
    expect(await pageText('#state')).toBe('focus:city')
  }, 60_000)

  it('supports right click, double click, native select, and file upload', async () => {
    const snapshot = await ok('browser_snapshot')
    await ok('browser_click', { index: indexOf(snapshot, 'Right target'), button: 'right' })
    expect(await pageText('#state')).toBe('right:yes')

    await ok('browser_click', { index: indexOf(await ok('browser_snapshot'), 'Double target'), clickCount: 2 })
    expect(await pageText('#state')).toBe('dbl:yes')

    await ok('browser_select_option', { index: indexOf(await ok('browser_snapshot'), 'City'), value: 'bj' })
    expect(await pageText('#state')).toBe('city:bj')

    const uploadPath = join(root!, 'upload-e2e.txt')
    await writeFile(uploadPath, 'hello from e2e')
    const uploadIndex = indexOf(await ok('browser_snapshot'), 'Attachment')
    await ok('browser_upload_file', { index: uploadIndex, paths: [uploadPath] })
    expect(await pageText('#state')).toBe('file:upload-e2e.txt')
  }, 60_000)

  it('waits for late content instead of polling with snapshots', async () => {
    await ok('browser_click', { index: indexOf(await ok('browser_snapshot'), 'Load late') })
    const waited = await ok('browser_wait_for', { selector: '#late', text: 'late-ready', timeoutMs: 3_000 })
    expect(waited).toContain('Waited')
    expect(await pageText('#late')).toBe('late-ready')
  }, 60_000)

  it('runs a dependent batch in one call', async () => {
    const snapshot = await ok('browser_snapshot')
    const batch = await ok('browser_batch', {
      steps: [
        { action: 'click', args: { index: indexOf(snapshot, 'Reset') } },
        { action: 'type', args: { index: indexOf(snapshot, 'Name'), text: 'Batch', replace: true } },
        { action: 'select_option', args: { index: indexOf(snapshot, 'City'), value: 'gz' } },
      ],
    })
    expect(batch).toContain('Batch completed 3/3')
    expect(await pageText('#state')).toBe('city:gz')
  }, 60_000)

  it('opens, lists, and switches between authorized tabs', async () => {
    const list = await ok('browser_tab_list')
    const firstId = Number(list.match(/\[tabId (\d+)\]/u)?.[1])
    expect(Number.isInteger(firstId)).toBe(true)

    await ok('browser_new_tab', { url: `${pageUrl}second`, name: 'second' })
    await ok('browser_wait_for', { selector: '#name', timeoutMs: 15_000 })
    expect(await ok('browser_snapshot')).toContain('Second page')

    await ok('browser_tab_switch', { tabId: firstId })
    expect(await ok('browser_snapshot')).toContain('Action e2e')
  }, 60_000)

  it('reports console and failed-request health', async () => {
    await ok('browser_observe', { clear: true })
    await ok('browser_click', { index: indexOf(await ok('browser_snapshot'), 'Cause error') })
    await ok('browser_wait', { ms: 300 })
    const observed = await ok('browser_observe')
    expect(observed).toContain('e2e-console-error')
    expect(observed).toContain('/missing-resource')
    expect(observed).toContain('404')
  }, 60_000)
})
