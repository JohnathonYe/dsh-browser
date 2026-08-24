# dsh Browser Control

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tab you are already using. The model can read page content, click controls, fill forms, scroll, and navigate while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Browser operation is text-first: pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number (click/fill/scroll). It also offers `browser_screenshot` (`chrome.debugger` rasterized capture) for vision models, plus human-like interaction (curved mouse movement, incremental wheel scrolling, hover-before-click, operate-on-visible targets, scroll-into-view first). dsh 0.1.1 multimodal chat is separate from that page channel—the side panel accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support.

## Quick install

The standard `dsh plugin` command alone cannot install this project. The integration contains both a dsh bridge plugin and a browser extension. The one-line installer currently sets up the Chrome build:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

When the installer opens `chrome://extensions`, follow its instructions to load or reload **dsh Browser Assistant**. If dsh is already running, restart it after installation. See [Detailed installation and usage](#detailed-installation-and-usage) for prerequisites, startup commands, updates, and developer installation.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes |
| Click element | `browser_click` | Click links, buttons, checkboxes, and other controls by inventory number |
| Fill forms | `browser_type` | React/Vue-compatible input; `replace` clears the field first |
| Press keys | `browser_press` | Keyboard events such as Enter, Tab, Escape, and arrow keys |
| Scroll | `browser_scroll` | Viewport scrolling: up, down, top, and bottom |
| Navigate | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, with login state preserved |
| Read region | `browser_get_text` | Lazy-loaded or partial page text |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |
| Send images | `session.prompt` / `session.attachment` | Host-capability-gated image drafts, image-only prompts, and durable history previews |
| Screenshot | `browser_screenshot` | `chrome.debugger` captures the exact controlled tab (background too), returning a rasterized viewport image |
| Hover | `browser_hover` | Hover a target to preview (tooltip/dropdown) |
| Drag | `browser_drag` | Drag sliders/elements with a human feel (down→move→up) |
| Humanized | built-in | Curved movement, incremental wheel, hover-before-click, operate-on-visible, scroll-into-view first |

## Tab authorization groups (DSH-)

Browser control moves from "follow one tab" to an **authorized group** model:

- The unit is a **Chrome tab group**; once authorized, every tab in it becomes AI-operable.
- Authorizing a **single page** auto-creates a group (name prefixed with `DSH-` such as `DSH-task`); tabs newly added to the group are authorized automatically.
- **Multiple groups** are supported; AI uses `browser_tab_switch` to move between groups/pages and `browser_new_tab` to open a tab inside the authorized group (auto-joined).
- Within an authorized group **no per-action permission is required** (including new domains opened by AI); authorize/revoke is the only gate, and opening a new tab follows an allow/ask policy.
- **Background operation**: switching tabs, window focus loss, or minimizing does not stop the AI; the extension can operate background tabs.
- The side panel shows authorized groups, the tab name the AI is currently operating, plus authorize/revoke and the open-tab policy.

New tools: `browser_tab_list`, `browser_tab_switch`, `browser_new_tab`.

## Multi-instance selection (AI-driven)

- When **multiple browser instances** (multiple Chrome/Firefox) connect to the same dsh, the target is chosen by **the model asking the user**, not by a panel dropdown.
- The extension persists a random `instanceId` in `chrome.storage.local` and reports it in `hello`; the server uses a connection registry keyed by `instanceId`, so instances coexist without evicting one another.
- An instance's display name is **extension name · representative tab title** (prefers the browser's first real `http(s)` tab with a non-empty title, excluding `chrome://`, `about:`, extension pages, and dsh pages), plus its **tab count**—not the opaque instanceId.
- The system prompt tells the model: when any `browser_*` tool errors with `multiple browser instances are connected` or `select one before issuing browser actions`, **ask the user with `ask_user_question`** (showing `label (N tabs)`), then call `browser_select_instance(instanceId)`; on cancel/no selection, do not pick one on your own.
- New tools: `browser_list_instances` (list instances as `{instanceId,label,tabCount,selected}`) and `browser_select_instance(instanceId)` (select and route subsequent actions).

## Browser screenshot (`browser_screenshot`)

- `browser_screenshot` uses **`chrome.debugger`** to capture exactly the tab the AI currently controls (whether active or background): `chrome.debugger.attach(targetTab)` → `Page.captureScreenshot` returns a genuine rasterized screenshot (not a DOM redraw).
- The screenshot is returned as image content in the tool result, readable by a vision model.
- By default it captures the **current viewport**; for the full page, the AI can `browser_scroll` to a position first, then capture.
- Requires the extension permissions `debugger` and `<all_urls>` (needed to screenshot any page).
- Side effect: Chrome shows a yellow "is debugging this browser" infobar over the captured page; that text is hardcoded by the browser and cannot be customized.

## Repository layout

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
scripts/install.sh
```

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make pages operable without screenshots; user-attached chat images use dsh's separate multimodal message path.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **A guarded bridge**: authenticated handshakes protect remote connections, privileged gateway methods reject non-loopback callers, and the extension binds tools to one user-controlled tab.

## Detailed installation and usage

Requirements: Node.js `^22.19` or `>=24`, Corepack/pnpm, and Chrome 116+ or Firefox 140+.

### Install or update

For a managed installation, run:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

The installer downloads `main`, builds and registers the bridge plugin, builds the Chrome extension into `~/.dsh/browser-extension`, and opens `chrome://extensions`. On the first install, load that directory as an unpacked extension; on updates, click **Reload**. Restart dsh if it is already running.

To install the current branch from a source checkout instead:

```sh
git clone https://github.com/Lum1104/dsh-browser.git
cd dsh-browser
./scripts/install.sh
```

After pulling or switching revisions, rerun `./scripts/install.sh` and reload the extension.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is still auto-discovered. Firefox's `moz-extension://` UUID does not authenticate an add-on, so copy the bearer token from `~/.dsh/ext-bridge-token` into the extension settings (the dsh startup log reports that file's path). Signed distribution can package the same `dist-firefox/` output.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. To use the latest public dsh release instead:

```sh
npx @deepseek-ai/dsh web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. Open an `http://` or `https://` page, click the DeepSeek whale icon, and wait for **Connected**. Existing tabs are instrumented on the first action; protected browser pages and extension stores are not supported.

## Troubleshooting

**Side panel stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh and refresh the page; the extension reconnects on its own.
- The extension probes ports 3080, 3081, 3090, and 14389 automatically. If dsh runs on another port — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the panel settings. Firefox always requires the token.

## Development

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access; Firefox origins are per-install UUIDs and must present the bearer token.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- Multi-instance connections: the server groups by instanceId; instances coexist, and an unselected target raises an error that prompts the model to ask the user (it never silently uses one instance).
- The assistant works within the **authorized group**, bound to one or more tabs; there is no "follow the tab" logic. Switching tabs does not stop operations within an authorized group (background operation is allowed); retargeting is done via groups, not following. When a controlled tab closes, calls are rejected until an operable authorized page exists.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. An origin may be trusted for the current side-panel session (cleared when the last panel closes or the service worker restarts), while permanent trust is managed explicitly in Settings. Explicit cross-origin `browser_navigate` calls and unknown history destinations always prompt again.
