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

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BridgeServer } from './server.ts'
import { BrowserContextInjector } from './browser-context.ts'
import { registerBrowserTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from './protocol.ts'
import { withSessionDeferral } from './session-deferral.ts'
import { withSessionWorkspace } from './session-workspace.ts'
import { resolveToken } from './token.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-browser'

/** Services required by this plugin. */
export const inject = ['webServer', 'apiProxy', 'tools', 'agents']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

/** Default directory backing the browser extension's session group. */
const DEFAULT_SESSION_WORKSPACE_PATH = dshHomePath('browser-sessions')

/** Default: sessions materialize only on the first message (open-and-close leaves no trace). */
const DEFAULT_DEFER_SESSION_CREATE = true

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
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
  sessionWorkspacePath: z.string().default(DEFAULT_SESSION_WORKSPACE_PATH),
  deferSessionCreate: z.boolean().default(DEFAULT_DEFER_SESSION_CREATE),
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
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  if (resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`bridge-browser: snapshotMaxChars must be at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  return resolved
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
  // Workspace grouping wraps the gateway create; session deferral wraps the
  // result so materialization at first prompt still flows through grouping.
  const api: ApiProxy = withSessionDeferral(
    withSessionWorkspace(
      ctx.apiProxy,
      resolved.sessionWorkspacePath,
      message => { ctx.logger.warn(message) },
    ),
    resolved.deferSessionCreate,
    ctx.get('attachments')?.imageLimits,
  )
  const browserContext = new BrowserContextInjector(ctx.agents)
  ctx.on('agent/session-start', ({ agent }) => { browserContext.activate(agent) })
  const server = new BridgeServer({
    token: tokenRes.token,
    apiHandler: toFetchHandler(api),
    openEvents: (signal) => api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal),
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

  ctx.effect(() => {
    const disposers = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
      injectBrowserImage: (sessionId, attachment) => { browserContext.injectImage(sessionId, attachment) },
    })
    return () => { for (const dispose of disposers.values()) dispose() }
  }, 'bridge-browser: browser tools')

  // Optional system-prompt contribution: a one-line hint only — the model is
  // told to fetch snapshots on demand instead of hoarding page text.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    // AX-first locating: the snapshot's inventory is the browser's accessibility
    // semantic tree (role/name + real pixel bounds + stable index), not a DOM
    // heuristic list and not a screenshot. The model locates by role/name, acts
    // by index (or bounds centre), and confirms the landing point via the
    // coordinate→element readback. English only (composition.spec asserts no Han).
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:ax-locate',
      order: 106,
      text: 'Locate targets by the browser\'s accessibility (AX) semantic tree that browser_snapshot returns, not by reading '
        + 'pixels off a screenshot and not by guessing a CSS selector. Each listed item carries the AX role '
        + '(button/link/heading/listitem/checkbox/...), the AX accessible name (the semantic label, which for rich '
        + 'components such as video cards is the title/description), its real CSS-pixel bounds (x, y, width, height), and a '
        + 'stable index. Act on an item with browser_click(index), browser_hover(index) or browser_drag(index); when the '
        + 'index is unreliable or the element is layered under something else, aim at the bounds\' centre with a small jitter. '
        + 'The click/hover result confirms the pointer\'s landing coordinate and the element at that coordinate (elementFromPoint); '
        + 'confirm that element is the intended target before assuming the action worked. Bounds come from the browser layout, so '
        + 'treat them as real geometry, never as a guarantee about what is on top: the coordinate→element confirmation is the check. '
        + 'browser_screenshot is visual only and is never a locator; never convert screenshot pixels into a click point yourself.',
    }), 'bridge-browser: ax-locate system prompt section')

    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser',
      order: 107,
      text: 'A browser bridge may be connected. To read or operate the user\'s active browser page, call browser_snapshot '
        + '(text-only; numbered items are the click/type targets and carry the AX role/name/bounds, unless the current turn '
        + 'already includes a plugin-provided followed-page browser_snapshot). Reuse that injected snapshot and its indices '
        + 'directly. Locate every target by its snapshot index (or the AX role/name/bounds that snapshot reports); never guess '
        + 'absolute coordinates on a screenshot. Never assume page content you have not snapshotted.',
    }), 'bridge-browser: system prompt section')

    // Multi-instance selection is model-driven. When several browser instances
    // are connected and no target is chosen, every browser_* tool errors with a
    // message listing the available instances; the model must ask the user which
    // one to use instead of guessing, then select it before retrying the action.
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:multi-instance',
      order: 108,
      text: 'If any browser_* tool returns an error whose message contains "multiple browser instances are connected" '
        + 'or "select one before issuing browser actions", more than one browser instance is connected and no target is '
        + 'selected. Do not choose one on your own and do not retry the browser action. First ask the user which instance '
        + 'to use. Use your ask/confirm-user tool (DSH\'s ask_user_question, or your available ask/confirm-user tool) to ask. '
        + 'You may call browser_list_instances first to get a structured list of the same instances with their ids, labels, '
        + 'tab counts, and the current selection. When asking, present each instance as a readable name such as '
        + '"label (N tabs)"; do not use the instanceId prefix as an option name. The user is choosing which instance to '
        + 'control, and the instanceId is the internal handle you must pass to browser_select_instance(instanceId). Once '
        + 'the user names an instance, call browser_select_instance(instanceId) to select it and only then issue the intended '
        + 'browser_* action. If the user cancels or does not provide a selection, do not choose an instance on your own; '
        + 'tell the user a browser instance must be selected before proceeding.',
    }), 'bridge-browser: multi-instance system prompt section')

    // No authorized group yet: every browser_* URL-less tool errors, while
    // browser_navigate/browser_new_tab with a real URL auto-create a new tab
    // and an authorized DSH- group. Guide the model to establish the target
    // page first instead of calling a URL-less tool (snapshot/click/scroll/...)
    // and tripping the error. English only (composition.spec asserts no Han).
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:no-auth-group',
      order: 109,
      text: 'If there is no authorized browser group yet (any browser_* tool returns "No authorized group. Open a target page '
        + 'first with browser_navigate or browser_new_tab (a real URL)..."), do not lead with a URL-less tool such as '
        + 'browser_snapshot, browser_click, browser_scroll, browser_hover or browser_get_text; they need an already-open '
        + 'target page and will fail with that error. To work on a page, first open it with browser_navigate(<url>) or '
        + 'browser_new_tab(<url>) — this opens the target in a new tab and creates an authorized group automatically, after '
        + 'which the page is operable. Order: establish the target page with browser_navigate/browser_new_tab first, then '
        + 'read it with browser_snapshot, then act with browser_click/browser_scroll/browser_type.',
    }), 'bridge-browser: no-auth-group system prompt section')

    // Locating is DOM-driven. The numbered snapshot inventory is the locator:
    // read it with browser_snapshot and act by index. The AI cursor overlay is
    // still a pure visual (the real pointer position), but the model must NOT
    // read coordinates off a screenshot to pick a target — it should locate by
    // snapshot index and use the coordinate→element confirmation the click /
    // hover tools return to verify the pointer landed where it intended.
    // English only (composition.spec asserts no Han characters).
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:confirm-before-click',
      order: 110,
      text: 'Locate every target by its numbered snapshot index from browser_snapshot, then act with browser_click(index), '
        + 'browser_hover(index) or browser_drag(index). After a browser_click or browser_hover the result reports the '
        + 'pointer\'s landing coordinate and the element at that coordinate (e.g. "the element at that coordinate is '
        + '<button>Submit</button>"); confirm that element is the intended target before assuming the action worked. If it '
        + 'names a different element (an overlay, a parent, or page background), the target is covered or mis-located: '
        + 'fix it first (scroll it into view, re-snapshot for a fresh index, or click a different index) rather than '
        + 'clicking blindly. Do not guess absolute coordinates from a screenshot to pick a target; the screenshot is only '
        + 'a visual, the snapshot index is the locator.',
    }), 'bridge-browser: confirm-before-click system prompt section')

    // DOM-first, and coordinate→element confirmation is the certain path: the
    // model reads the target\'snapshot index and lets the click/hover result
    // confirm the landing element at that coordinate. There is no screenshot-
    // pixel coordinate tool; the model never converts screenshot pixels itself.
    // English only (composition.spec asserts no Han characters).
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:click-at',
      order: 111,
      text: 'To act precisely on an element, use the snapshot index: browser_click(index), browser_hover(index) and '
        + 'browser_drag(index) act on the numbered inventory from browser_snapshot. Each click or hover result confirms '
        + 'the pointer\'s landing coordinate and names the element at that coordinate, so you can verify the point hit the '
        + 'intended target. browser_screenshot is available when you need a visual of the whole page, but it is not a '
        + 'locator: do not read a pixel position off it and do not try to convert screenshot coordinates yourself. After '
        + 'acting, use the returned coordinate→element confirmation, and only re-snapshot when the page or target changed.',
    }), 'bridge-browser: click-at system prompt section')

    // Index-locate failure is DOM-driven too: when the snapshot index cannot
    // locate the target it never means "switch to coordinates"; it means the
    // index is stale, off-screen, or the element is not in the inventory. The
    // fix is to re-snapshot for current indices, scroll the target into view,
    // or read the target\'s region — not to guess a screenshot point.
    // English only (composition.spec asserts no Han characters).
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:index-fallback',
      order: 112,
      text: 'Use the snapshot index first: browser_click(index), browser_hover(index) and browser_drag(index) act on the '
        + 'numbered inventory from browser_snapshot. If the snapshot index cannot locate the target (the element is not in '
        + 'the interactive inventory, the index is stale or distorted, or the page changed), stop guessing an index and '
        + 'fix the locator instead of probing blindly: call browser_snapshot again (or browser_snapshot with delta:true to '
        + 'read only the changes) to get current indices, browser_scroll to bring the target into view, or browser_get_text '
        + 'with a selector to find the element\'s region and re-snapshot. Do not read a coordinate off a screenshot to '
        + 'act; the snapshot index is the only locator, and the click/hover result\'s coordinate→element confirmation tells '
        + 'you whether the pointer actually reached the intended element.',
    }), 'bridge-browser: index-fallback system prompt section')

    // Over-confirmation blooms: a model that re-snapshots or re-screenshots
    // the same view on every step turns a short locate into a long loop. This
    // is a soft constraint on TOP of the guidance above (confirm-before-click
    // / index-fallback still want one confirm before an action) — it says:
    // confirm once, then act, do not re-confirm the same region repeatedly.
    // English only (composition.spec asserts no Han).
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser:reduce-reconfirm',
      order: 113,
      text: 'Do not take snapshots or screenshots unless you actually need them. Use browser_snapshot to read page '
        + 'context or its changes, and browser_screenshot only when the visual state cannot be judged from the snapshot '
        + '(it is a visual aid, never a locator). Do not re-capture on every step. If you already know the target index '
        + 'or already saw that region and the page has not changed, do not re-snapshot or re-screenshot the same '
        + 'region; with delta:true take only the changes instead of a full capture. Re-capture only when navigation, '
        + 'scroll, or a click changed the view, or when you need a new target; in a single locating flow do not '
        + 'repeatedly snapshot/screenshot the same region. The coordinate→element confirmation returned by '
        + 'browser_click / browser_hover is one check right before an action, not part of a repeating snapshot -> '
        + 'screenshot -> judge -> snapshot -> screenshot loop; if one click result already names the intended element, act '
        + 'directly.',
    }), 'bridge-browser: reduce-reconfirm system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); connect the extension and paste it in its settings`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}
