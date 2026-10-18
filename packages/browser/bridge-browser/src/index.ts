/**
 * `@yuxianglin/dsh-bridge-browser`: token-authenticated WebSocket bridge for
 * the browser extension plus the text-only `browser_*` tool set.
 *
 * The bridge mounts its own upgrade route (`/ext/bridge`) on the host
 * webserver, OUTSIDE the /api trust fence — so it brings its own bearer-token
 * authentication (first frame `hello` within HELLO_TIMEOUT_MS). Gateway RPCs
 * from the extension are dispatched through the same fetch-shaped handler the
 * /api carrier uses, and session events are pumped per connection. Tools
 * execute by dispatching `tool.call` frames to the connected extension, which
 * performs the action in the tab explicitly controlled by the user.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No dsh core code is touched.
 *
 * @module @yuxianglin/dsh-bridge-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
// Brings the `ctx.connection` Context augmentation (HostConnectionHandle) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BridgeServer, type BridgeEventEnvelope } from './server.ts'
import { BrowserContextInjector } from './browser-context.ts'
import { registerBrowserTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from './protocol.ts'
import { resolveToken } from './token.ts'
import { closeFixedDiscoveryServer, createFixedDiscoveryServer, listenFixedDiscoveryServer } from './discovery.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-browser'

/** Services required by this plugin. */
export const inject = ['webServer', 'connection', 'tools', 'agents']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

/** Default directory backing the browser extension's session group. */
const DEFAULT_SESSION_WORKSPACE_PATH = dshHomePath('browser-sessions')

/** Default: sessions materialize only on the first message (open-and-close leaves no trace). */
const DEFAULT_DEFER_SESSION_CREATE = true

/**
 * Stable loopback discovery port. The host web port is random on some desktop
 * launches, while the extension probes fixed ports; binding 19387 keeps the
 * bridge discoverable across restarts. Set `discoveryPort: 0` to disable.
 */
const DEFAULT_DISCOVERY_PORT = 19387

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one snapshot's rendered characters. Defaults to 32000; minimum 500. */
  snapshotMaxChars?: number
  /** Upper bound on interactive inventory items per snapshot. Defaults to 60. */
  maxInteractiveItems?: number
  /** Dedicated workspace path for extension-created sessions. Empty disables grouping. */
  sessionWorkspacePath?: string
  /** Defer real session creation until the first prompt. Defaults to true. */
  deferSessionCreate?: boolean
  /** Stable loopback discovery port; 0 disables the extra listener. Defaults to 19387. */
  discoveryPort?: number
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
  sessionWorkspacePath: z.string().default(DEFAULT_SESSION_WORKSPACE_PATH),
  deferSessionCreate: z.boolean().default(DEFAULT_DEFER_SESSION_CREATE),
  discoveryPort: z.number().step(1).min(0).default(DEFAULT_DISCOVERY_PORT),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/** Configured budgets must be positive integers. Exported for validation tests. */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bridge-browser: ${name} must be a positive integer`)
  }
}

/**
 * Apply defaults and direct-call validation at the plugin boundary.
 * @param config - Loader-resolved or directly supplied plugin configuration.
 * @returns a complete configuration ready for runtime use.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
    maxInteractiveItems: config.maxInteractiveItems ?? DEFAULT_MAX_INTERACTIVE_ITEMS,
    sessionWorkspacePath: config.sessionWorkspacePath ?? DEFAULT_SESSION_WORKSPACE_PATH,
    deferSessionCreate: config.deferSessionCreate ?? DEFAULT_DEFER_SESSION_CREATE,
    discoveryPort: config.discoveryPort ?? DEFAULT_DISCOVERY_PORT,
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  if (resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`bridge-browser: snapshotMaxChars must be at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  if (!Number.isInteger(resolved.discoveryPort) || resolved.discoveryPort < 0) {
    throw new Error('bridge-browser: discoveryPort must be a non-negative integer')
  }
  return resolved
}

/**
 * Empty gateway-event stream. The alpha assembly has no global session mux
 * (`ctx.apiProxy.events.mux` is gone): live events are now per-session via
 * `session/follow`. The bridge cannot forward a global stream, so a connected
 * extension receives no auto-pumped events; calls that need live per-session
 * events open `session/follow` themselves through the shared channel. Kept as
 * a single shared value so the union type stays exporter-only.
 */
function noGatewayEvents(): AsyncIterable<BridgeEventEnvelope> {
  return (async function* () {
    /* no alpha global event mux to forward */
  })()
}

/**
 * Flush one session's pending browser context at the harness's agent-creation
 * boundary.
 *
 * `agent/created` is the only startup-driving event that survives
 * `@deepseek-ai/dsh@0.1.6-alpha.1` (which removed `agent/session-start`);
 * `0.1.5-rc.1`/`rc.2` emit it as well, from the AgentRegistry, once an agent
 * enters it with a live session and completed setup — so one subscription
 * covers every supported harness. 0.1.6 awaits these listeners serially and
 * rolls agent creation back when one rejects, so this flush reports its own
 * failure instead of letting it escape.
 *
 * @param ctx - Cordis context owning the subscription.
 * @param injector - injector holding snapshots for not-yet-materialized sessions.
 */
export function registerAgentCreatedFlush(ctx: Context, injector: BrowserContextInjector): void {
  ctx.on('agent/created', ({ agent }) => {
    try {
      injector.activate(agent)
    } catch (error) {
      ctx.logger.warn(`bridge-browser: browser context flush failed for agent "${String(agent.id)}": ${String(error)}`)
    }
  })
}

/**
 * Mount the bridge: resolve the token, register the upgrade route, the tool
 * set, and an optional system-prompt section, all effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const tokenRes = await resolveToken(resolved.token)
  // The alpha assembly exposes the gateway as a fetch-shaped `/api` shared
  // channel on `ctx.connection` — there is no `ctx.apiProxy` object and no
  // `events.mux`. Session-workspace grouping and deferred materialization are
  // dropped (alpha's `session/create` attaches the declared workspace natively
  // and materializes on create); the bridge forwards unary RPCs translated in
  // `server.ts` and no longer pumps a global event stream.
  // @deepseek-ai alpha type drift: HostConnectionHandle's declared type may lag
  // the runtime channel (the shared /api fetch handler). Cast so tsc resolves it.
  const connection = ctx.connection as unknown as { createSharedFetchHandler: (path: string) => { fetch: (request: Request) => Promise<Response> } }
  const apiHandler = connection.createSharedFetchHandler('/api')
  const browserContext = new BrowserContextInjector(ctx.agents)
  registerAgentCreatedFlush(ctx, browserContext)
  const server = new BridgeServer({
    token: tokenRes.token,
    apiHandler,
    openEvents: () => noGatewayEvents(),
    toolTimeoutMs: resolved.toolTimeoutMs,
    caps: {
      textOnly: true,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    },
    injectBrowserSnapshot: (sessionId, snapshot) => { browserContext.inject(sessionId, snapshot) },
  })

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'bridge-browser: /ext/bridge upgrade route')
  // 异步 disposer：HMR/卸载时先等桥完全关闭（socket/泵/acceptor 静默）再继续。
  ctx.effect(() => () => server.close(), 'bridge-browser: bridge server')

  // Zero-config discovery endpoint: the extension fetches this to learn the
  // bridge WebSocket URL without any manual configuration. The URL carries no
  // secret (loopback connections skip the token); non-loopback deployments
  // keep requiring the token on the WS itself.
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}` }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'bridge-browser: /ext/bridge-config route')

  // Stable discovery listener: the host webserver port is random on some
  // desktop launches, so an extension probing fixed ports would never find the
  // bridge after a restart. This loopback-only listener exposes the same config
  // JSON and forwards upgrades to the same BridgeServer. Disabled with
  // discoveryPort: 0 (tests that boot many compositions in parallel).
  if (resolved.discoveryPort > 0) {
    const fixedDiscovery = createFixedDiscoveryServer({
      port: resolved.discoveryPort,
      bridgePath: BRIDGE_PATH,
      configPath: BRIDGE_CONFIG_PATH,
      handleUpgrade: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
    })
    try {
      await listenFixedDiscoveryServer(fixedDiscovery, resolved.discoveryPort)
      ctx.effect(() => () => closeFixedDiscoveryServer(fixedDiscovery), 'bridge-browser: fixed discovery listener')
      ctx.logger.info(`browser bridge: stable discovery listening on 127.0.0.1:${resolved.discoveryPort}`)
    } catch (error) {
      // A port conflict must not prevent the bridge from working on the host
      // port; manual URLs and other instances can still reach it.
      ctx.logger.warn(`browser bridge: stable discovery port ${resolved.discoveryPort} is unavailable (${String(error)}); continuing on the host web port`)
      await closeFixedDiscoveryServer(fixedDiscovery).catch(() => {})
    }
  }

  ctx.effect(() => {
    const disposers = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
      injectBrowserImage: (sessionId, attachment) => { browserContext.injectImage(sessionId, attachment) },
    })
    return () => { for (const dispose of disposers.values()) dispose() }
  }, 'bridge-browser: browser tools')

  // Optional system-prompt contribution. Keep this short and non-duplicated:
  // the tool schemas and action results carry their own recovery guidance, and
  // every token here is paid on every turn. English only (composition.spec
  // asserts no Han characters).
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser',
      order: 106,
      text: 'A browser bridge may be connected. To read or operate the user\'s page, call browser_snapshot '
        + '(text-only; numbered items carry AX role/name/bounds). Reuse a snapshot already injected in this turn; '
        + 'never assume page content you have not snapshotted. If no authorized group exists yet, open a real URL '
        + 'with browser_navigate(<url>) or browser_new_tab(<url>) first.',
    }), 'bridge-browser: system prompt section')

    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:locate',
      order: 107,
      text: 'Act by snapshot index, not by screenshot pixels: browser_snapshot lists each target with its AX role, '
        + 'accessible name, real bounds, and a stable index; browser_click(index), browser_hover(index), '
        + 'browser_drag(index), browser_type(index) and browser_select_option(index) address it. The action result '
        + 'reports where the pointer landed and the element at that coordinate; verify it before assuming success, '
        + 'and if an overlay or parent was hit, scroll or pick another index instead of clicking blindly. '
        + 'browser_screenshot is a visual aid only and is not a locator. If an index is stale, the tool re-resolves it '
        + 'by role/name when unambiguous; otherwise use browser_find_dom, browser_wait_for, or browser_snapshot '
        + 'delta:true to get current indices. Snapshot only when the page changed or you need new targets.',
    }), 'bridge-browser: locate system prompt section')

    // No authorized group yet: the URL-less tools fail closed, while
    // browser_navigate/browser_new_tab with a real URL auto-create the group.
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:no-auth-group',
      order: 108,
      text: 'If a browser_* tool reports no authorized group, do not lead with a URL-less tool such as '
        + 'browser_snapshot, browser_click or browser_scroll. Open the target with browser_navigate(<url>) or '
        + 'browser_new_tab(<url>) first; that creates the authorized group.',
    }), 'bridge-browser: no-auth-group system prompt section')

    // Deterministic primitives beat guess-and-re-snapshot loops.
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:workflow',
      order: 109,
      text: 'Prefer one deterministic tool over polling: browser_wait_for for a selector/text/URL, '
        + 'browser_select_option for native selects, browser_upload_file for file inputs (absolute paths), '
        + 'browser_dialog to accept or dismiss a native alert/confirm/prompt, and browser_observe when an action '
        + 'seems to do nothing (console/page/network errors). Use browser_batch for up to 10 dependent actions in '
        + 'one call, and browser_type with submit:true to fill and submit a form.',
    }), 'bridge-browser: workflow system prompt section')

    // Multi-instance selection is model-driven. When several instances are
    // connected and no target is chosen, every browser_* tool errors with a
    // message listing them; the model asks the user instead of guessing.
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:multi-instance',
      order: 110,
      text: 'If any browser_* tool says multiple browser instances are connected or no target is selected, do not '
        + 'choose an instance on your own. Ask the user with ask_user_question, showing each instance as a readable '
        + '"label (N tabs)" name (call browser_list_instances for the ids, labels, and tab counts). After the user '
        + 'names one, call browser_select_instance(instanceId) and retry the action. On cancel or no selection, do '
        + 'not guess: tell the user a browser instance must be selected first.',
    }), 'bridge-browser: multi-instance system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); connect the extension and paste it in its settings`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}
