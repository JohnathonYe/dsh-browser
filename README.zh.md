# dsh 浏览器操作

[English](README.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取页面内容、点击控件、填写表单、滚动与导航，同时保留登录态、会话和 Cookie。侧边栏提供对话界面。

`dsh` 是由 DeepSeek AI 开发的开源、插件化 agent harness（智能体框架）。本仓库将配套的浏览器桥插件与 Chrome/Firefox MV3 扩展组成一个独立的 pnpm workspace。

浏览器操作的核心仍是纯文本：页面会转换为结构化文本和带编号的交互元素清单，模型通过编号定位元素（点击/填写/滚动）。同时提供 `browser_screenshot`（`chrome.debugger` 光栅化截图）供视觉模型读取，并内置拟人化操作（曲线鼠标移动、分档滚轮、先悬停再点击、目标可见才操作、屏外先滚到可见）。dsh 0.1.1 的多模态对话走独立通道——宿主声明图片能力时，侧栏可发送 PNG、JPEG、WebP 和 GIF。

## 快速安装

本项目不能只使用标准的 `dsh plugin` 命令安装。它同时包含 dsh bridge plugin 和浏览器扩展。一行安装器目前会安装 Chrome 构建：

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

安装器打开 `chrome://extensions` 后，请按提示加载或重新加载 **dsh 浏览器助手**。如果 dsh 已经在运行，安装完成后请重启。前置要求、启动命令、更新方式和开发者安装详见[详细安装与使用](#详细安装与使用)。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。本项目目前没有发布 npm 包，请使用上方安装器。

## 性能基准

在 2026 年 8 月 18 日完成的 60 次配对端到端评测中，两个后端分配到的 30 次运行均全部成功；dsh 浏览器操作使用了更少的模型/工具轮次，并以更短时间完成任务：

| 后端 | 成功率 | 平均端到端耗时 | 平均浏览器工具调用 |
|---|---:|---:|---:|
| **dsh 浏览器操作** | **30/30** | **5.32 秒** | **3.4** |
| 对齐工具契约的 Playwright 基线 | 30/30 | 6.67 秒 | 4.7 |

Playwright / 扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）：Playwright 耗时约多 24%；等价地说，dsh 浏览器操作将延迟降低约 20%，每个任务平均节省 1.35 秒。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 DSH profile 与模型（`deepseek-v4-flash`），并通过独立页面状态验证结果。详见[评测方法与复现说明](benchmark/README.md)。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化 |
| 点击元素 | `browser_click` | 按编号点击链接/按钮/复选框等 |
| 填写表单 | `browser_type` | 输入文本（React/Vue 受控组件兼容），`replace` 清空重填 |
| 按键 | `browser_press` | 键盘事件（Enter/Tab/Escape/方向键…） |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 页面导航 | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，保留登录态 |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待稳定 | `browser_wait` | 页面加载与渲染稳定检测 |
| 发送图片 | `session.prompt` / `session.attachment` | 按宿主能力启用图片草稿、纯图片消息和持久历史预览 |
| 截图 | `browser_screenshot` | `chrome.debugger` 精确截取受控标签页（可后台），返回光栅化视口截图 |
| 悬停 | `browser_hover` | 对目标先悬停预览（tooltip/下拉） |
| 拖动 | `browser_drag` | 滑块/元素随手感拖动（down→move→up） |
| 拟人操作 | 内建 | 曲线移动、分档滚轮、先 hover 再点击、目标可见才操作、屏外先滚到可见 |

## 授权组（DSH-）

浏览器操作从「跟随单个标签页」升级为**授权组**模型：

- 授权单位是 **Chrome 标签组**；授权后组内所有标签页都是 AI 可操作范围。
- **授权单个页**时自动建一个组，组名以 `DSH-` 开头（如 `DSH-任务`）；新开/新拉入该组的页面自动纳入授权。
- 支持**多个组**授权，AI 用 `browser_tab_switch` 在组/页间切换，`browser_new_tab` 在授权组内开新标签页（自动入组）。
- 授权组内**不再逐个权限确认**（含 AI 新开的新域名页）；授权/取消授权是唯一门槛，开新标签页按「允许 / 每次询问」策略。
- **后台可操作**：用户切到其它标签页、窗口后台/失焦，AI 依然在授权组内操作（扩展可操作后台标签页）。
- 侧边栏「DSH 授权组」显示已授权组、AI 当前操作的标签页名称，以及授权/取消授权/开新标签页策略。

新增工具：`browser_tab_list`（列授权组标签页）、`browser_tab_switch`、`browser_new_tab`。

## 多实例选择（AI 驱动）

当**多个浏览器实例**（多个 Chrome/Firefox）连到同一个 dsh 时，是否选目标不再由插件侧栏决定，而是**交给模型询问用户**：

- 扩展在 `chrome.storage.local` 持久化一个随机 `instanceId` 并随 `hello` 上报；服务端用连接注册表按 `instanceId` 分组，多实例互不抢占。
- 实例的显示名 = **扩展名 · 代表性标签页标题**（优先取该浏览器第一个真实 `http(s)` 且有标题的页面，排除 `chrome://`、`about:`、扩展页、dsh 自身页），并附带**标签页数量**，便于区分；不使用晦涩的 instanceId。
- 系统提示指引模型：当任何 `browser_*` 工具报错含 `multiple browser instances are connected` 或 `select one before issuing browser actions` 时，**必须先用 `ask_user_question` 询问用户选择哪个实例**（展示 `label (N tabs)`），拿到 instanceId 后调用 `browser_select_instance(instanceId)` 再继续；用户取消/未选择时不自行挑一个。
- 新增工具：`browser_list_instances`（列出已连接实例 `{instanceId,label,tabCount,selected}`）、`browser_select_instance(instanceId)`（选中并路由后续操作）。

## 浏览器截图（`browser_screenshot`）

- `browser_screenshot` 用 **`chrome.debugger`** 精确截取 AI 当前控制的那个标签页（无论它是否活动/后台）：`chrome.debugger.attach(目标tab)` → `Page.captureScreenshot` 拿到**真实光栅化截图**（非 DOM 重绘）。
- 截图以工具结果的 image content 返回，视觉模型可直接读取。
- 默认截**当前视口**；需要整页时 AI 可先 `browser_scroll` 到目标位置再截。
- 需要扩展权限 `debugger` 与 `<all_urls>`（截图任意页必需）。
- 副作用：Chrome 会在被截页面顶部显示"正在调试此浏览器"黄色提示条，该文案由浏览器写死、无法自定义。

## 组成

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
scripts/install.sh
```

## 为什么这样设计

- **使用你的真实浏览器，而不是无头副本**：模型操作你已经打开的页面，登录态、会话和 Cookie 均会保留。
- **纯文本页面接口**：编号控件、跨快照稳定 ID、delta 更新和敏感值掩码，使模型无需截图也能操作页面；用户主动添加的对话图片走 dsh 独立的多模态消息通道。
- **收窄隐私边界**：密码和支付卡字段始终显示为 `••••`，字段值不会离开页面。
- **受保护的桥连接**：远程连接使用认证握手，特权网关方法拒绝非回环调用方，扩展把工具绑定到一个由用户控制的标签页。

## 详细安装与使用

前置要求：Node.js `^22.19` 或 `>=24`、Corepack/pnpm，以及 Chrome 116+ 或 Firefox 140+。

### 安装或更新

托管安装请运行：

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

安装器会下载 `main`、构建并注册桥插件、把 Chrome 扩展构建到 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。首次安装时，请把该目录作为已解压扩展加载；更新时点击**重新加载**。如果 dsh 已在运行，请重启。

如需从源码 checkout 安装当前分支：

```sh
git clone https://github.com/Lum1104/dsh-browser.git
cd dsh-browser
./scripts/install.sh
```

拉取或切换版本后，请重新运行 `./scripts/install.sh` 并重新加载扩展。

### Firefox 源码构建

Firefox 使用独立的 MV3 manifest、事件页后台和 Sidebar。在 checkout 中构建后，打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，再选取 `extensions/dsh-browser/dist-firefox/manifest.json`：

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

桥地址仍会自动探测。Firefox 的 `moz-extension://` UUID 不能证明扩展身份，因此需要把 `~/.dsh/ext-bridge-token` 中的 bearer token 填入扩展设置（dsh 启动日志会报告该文件路径）。签名发布时可直接使用同一份 `dist-firefox/` 产物。

### 启动与使用

启动托管安装：

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

使用源码 checkout 时，请在仓库根目录运行 `pnpm start`。如需启动最新公开版本的 dsh：

```sh
npx @deepseek-ai/dsh web
```

Chrome 本机使用无需配置；Firefox 需要填写上述本地桥 token。打开任意 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标，等待侧边栏显示**已连接**。已有标签页会在第一次操作时自动加载；浏览器受保护页面和扩展商店不受支持。

## 故障排查

**侧边栏一直显示「未连接」**

- 确认本机 dsh web 正在运行（默认 `http://127.0.0.1:3080`）。
- 确认桥接已加载：浏览器打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回类似 `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}` 的 JSON。如果返回的是网页而不是 JSON，说明当前运行的 dsh 早于桥接注册——重启 dsh 并刷新页面即可，扩展会自动重连。
- 扩展会自动探测 3080/3081/3090/14389 端口。若 dsh 运行在其它端口，或使用 `--host 0.0.0.0` 远程部署，请在面板设置中填写地址与桥接 token。Firefox 始终需要 token。

## 开发

桥接插件和 Chrome/Firefox 扩展都属于本仓库 workspace；所有命令均在本仓库根目录执行。首次开发安装运行 `pnpm install`。

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

注意：

- 启动前桥接插件必须已有 `lib/` 供 Loader 加载；`scripts/install.sh` 和根目录 `pnpm run build` 都会先构建插件再构建扩展。
- `@deepseek-ai/dsh` 与桥接插件的依赖固定在同一条经过验证的公开发布线上；升级时必须同时更新 manifest、锁文件并重跑根目录检查。

## 安全

- 桥路径在 `/api` 信任栅栏之外，自带 bearer token 认证。
- Chrome 扩展的本地 Origin 保留零配置回环访问；Firefox Origin 是每次安装生成的 UUID，必须携带 bearer token。
- 特权网关方法（`settings.*`/`credentials.*`/`host.open*`）对非回环来源一律拒绝。
- 多实例连接：服务端按 instanceId 分组，实例可共存；未显式选择时工具调用会报错并让模型询问用户，不会悄悄用一个实例。
- 助手在**授权组**内工作，绑定一个或一组标签页；不再有「跟随标签页」逻辑。用户切页不影响已授权组内的操作（后台可操作）；想切换目标需通过授权组而非跟随。受控标签页关闭时，相关工具调用会被拒绝，直到有可操作的授权页面。
- 网页文字会标记为不可信输入。默认「自动共享」只按需读取受控标签页且不额外弹窗；对隐私敏感时可选择「每次询问」，或用「关闭」完全阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取；之后仍可在设置中关闭。读取的页面文字会发送给当前选择的模型。
- 点击、输入、按键、导航、历史跳转和刷新默认失败关闭，必须由用户批准。可以只在当前侧栏会话中信任单个 origin（最后一个侧栏关闭或 Service Worker 重启即清空）；永久信任需在设置中显式管理。显式跨域 `browser_navigate` 和未知目标的历史跳转始终重新询问。
