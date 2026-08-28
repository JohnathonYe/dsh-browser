# 浏览器插件面板重做：两按钮控制面 + 控制开关

- **日期**：2026-08-28
- **状态**：已批准设计（待实现计划）
- **范围**：dsh-browser 扩展（Chrome/Firefox MV3）侧面板

## 背景与问题

当前点击扩展图标打开的面板是一个 **React 对话 UI**：聊天输入、历史会话、消息列表、图片附件、提问卡片、Tab 交接提示条、设置页，以及一套「授权 tab」控件（授权当前页/组、开tab allow/ask、取消组）。

问题：
1. 面板「一打开就能对话」，把模型对话入口放在扩展里，不是用户想要的。
2. 浏览器自动化时，CDP 调试器对受控 tab **attach/detach 反复切换**，导致 Chrome 自带的「**正在调试此浏览器**」黄色提示条**一开一关、反复闪烁**。该提示条会改变页面可视视口高度，使元素坐标偏移，进而让自动化基于旧快照算出的点击落点判断失败。

## 目标

1. **移除扩展面板的对话功能**（聊天/会话/输入/图片/提问/设置/Tab 交接等），把面板改成极简「浏览器控制面」。
2. 点击扩展图标打开面板，只显示 **两个按钮**：
   - **①「授权当前页面」**：当前活动 tab 若已有标签组 → 直接并入并授权该组；若无组 → **新建一个 DSH- 组**并授权（复用后台现有 authorize 逻辑）。
   - **②「关闭控制 / 开启控制」（默认开启）**：控制开启时，让 CDP 调试器**常驻挂接**在受控 target tab 上，使 Chrome「正在调试此浏览器」提示条**一直处于触发状态、不闪烁**；控制关闭时解除常驻挂接。
3. **移除**原来那套「授权 tab」按钮（授权当前页/组 + 开tab allow/ask + 取消组）。
4. 控制开启（默认）时提示条常驻，从根本上消除自动化时提示条一开一关导致的落点判断失败。

## 非目标（明确不做）

- 不改动模型的对话入口：对话仍由 dsh 宿主（如 dsh web）驱动；扩展只充当浏览器操作通道 + 极简控制面。
- 不改变授权状态机语义（DSH- 授权组、多组授权、冷启动建组、AI 开 tab 策略）。
- 不改变内容脚本的快照/动作/AX/指针回放逻辑（除引入常驻挂接所需的 hold 机制外）。
- 不改变桥接 eager 连接（面板不打开模型也能操作已授权页）。

## 关键设计决策（已确认）

| 决策 | 结论 |
|---|---|
| 控制开关默认 | **开启**（controlEnabled=true，持久化到 chrome.storage.local） |
| 控制关闭行为 | **禁止 AI 操作页面**：所有 browser_* 工具 fail-closed，返回明确错误「浏览器控制已关闭，请在扩展面板开启」；同时解除调试器常驻挂接（提示条消失） |
| 提示条控制方式 | 扩展不能直接隐藏浏览器原生提示条，采用「**保持调试器常驻 attach**」让提示条一直被触发，达到常驻不闪 |
| 审批 UI | 面板默认只有两按钮；**仅当后台确有 pending 审批**时才显示极简审批浮层（允许一次/拒绝/始终允许读取），发送 approval.response。授权后操作自动放行（现状如此），因此审批属人工操作兜底、默认不展示 |
| 面板实现 | **方案 B：全新轻量 HTML/JS 面板**（去掉 React），仍用 Vite 打包 vanilla 入口，去除 React 插件 |
| 后台 | 授权状态机、桥接、工具分发、审批协调器、冷启动建组 **全部保留**，仅在工具入口加控制开关闸门 |

## 架构

```
侧面板（HTML/JS，两按钮 + 状态）<--port(dsh-panel)--> background SW/事件页 <--WS--> dsh 桥插件
                                          |
                          tabs.sendMessage(DSH_ACTION)
                                          v
                                content script（快照/动作/指针）
```

- **面板**：只发/收少量消息：状态（status）、授权组快照（tab-authorization）、审批（approval.request / approval.resolved）；发送：tab-authorization（authorize）、settings（切换 controlEnabled）、approval.response。
- **后台**：新增控制开关闸门 + 常驻挂接；其余逻辑不变。

## 组件与改动

### 1. 面板（去掉 React）
- panel/index.html：静态壳，引入 /src/panel/main.ts。
- src/panel/main.ts（vanilla TS，经 Vite 打包）：chrome.runtime.connect({ name: dsh-panel })；订阅 status、tab-authorization、approval.request/approval.resolved；渲染：
  - 连接状态（圆点 + 文案）。
  - 按钮①「授权当前页面」：取当前活动 tab（面板直接 chrome.tabs.query({active:true,lastFocusedWindow:true})），发 {type:tab-authorization, action:{kind:authorize, tabId, title}}。
  - 按钮②「关闭控制/开启控制」：发 {type:settings, settings:{controlEnabled:!当前}}；按当前状态显示开关文案。
  - 审批浮层：仅当 approval.request 到达时显示；否则不渲染。
- vite.panel.config.ts：去掉 react() 插件，其余保持（html 入口，输出到 panel/assets）。
- 删除不再使用的 React 面板源码（App.tsx、main.tsx、composer.ts、sessions.ts、events.ts、attachments.ts、questions.ts、approvals、pending-questions.ts、UpdateCard、QuestionCard、MessageImages 等），以及 src/panel/styles.css 中仅服务于对话的样式（保留按钮/审批浮层所需）。
- src/panel/strings.ts：精简为两按钮 + 审批 + 状态文案（中英）。

### 2. 后台 — 控制开关（controlEnabled）
- background/index.ts：Settings 增加 controlEnabled: boolean（默认 true，SETTINGS_DEFAULTS）；normalizeSettings 归一化；持久化到 chrome.storage.local（现有 STORAGE_KEY）。
- 面板 toggle 通过现有 {type:settings, settings:{controlEnabled}} 通道生效。
- 后台在 settings 变化时向所有面板端口广播一条 {type:settings, settings} 消息；面板初始从 chrome.storage.local 读 controlEnabled，实时从该广播刷新开关文案。

### 3. 后台 — 常驻挂接（debugger hold）
- background/debugger-session.ts：在现有引用计数 acquire/release 之上增加 **hold(tabId) / releaseHold(tabId)**：
  - hold：等同于 acquire 但该引用不被单个操作释放，除非显式 releaseHold。
  - releaseHold：释放该常驻引用；若为最后一个引用则 detach（提示条消失）。
  - 现有截图/指针/AX 路径仍照常 acquire/release（只增删它们的瞬时引用），因 hold 的存在，目标 tab 始终保持 attach（提示条常驻）。
- background/index.ts 同步 hold 的时机：
  - 控制开启、且 target tab 解析成功后 → hold(targetTabId)。
  - browser_tab_switch / 授权后 target 变化 → 释放旧 target 的 hold，对新 target hold。
  - target tab 被撤销/关闭 → releaseHold。
  - 控制关闭 → 对所有已 hold 的 tab releaseHold（提示条消失）。
- hold 的失败降级：chrome.debugger.attach 失败（DevTools 占用、受保护页）时不阻塞工具，仅无法保持提示条常驻（记日志，不抛错给工具调用）。

### 4. 后台 — 控制闸门（fail-closed）
- background/index.ts：在 routeToolCall 入口（及 runBrowserControlTool）增加判断：!settings.controlEnabled 时对所有 browser_* 工具返回 {ok:false, error:{code:control-disabled, message:浏览器控制已关闭，请在扩展面板开启}}。
- 授权后操作仍自动放行（authorized ? approved : authorizeToolCall(...) 不变）。

### 5. 其他
- manifest.json 不动（side_panel default_path、action 图标、权限不变）。
- 桥接、EAGER_BRIDGE 不变，面板不打开模型仍可操作已授权页。

## 数据流

- **授权当前页**：面板按钮① → chrome.tabs.query({active}) → {type:tab-authorization, action:{kind:authorize,tabId,title}} → 后台 handle()：tab 已有组则并入、无组则 chrome.tabs.group 新建并授权 → broadcastTabAuthorization → 面板刷新授权状态。
- **控制开关**：面板按钮② → {type:settings, settings:{controlEnabled}} → 后台 persistSettings → 若开启且已有 target → hold；若关闭 → releaseHold 全部 + 工具闸门 fail-closed → 广播状态 → 面板刷新按钮文案。
- **模型操作**：dsh 宿主 agent → 桥 tool.call → 后台 routeToolCall（控制开启才放行）→ 授权判定（已授权自动放行）→ content 动作 → tool.result 回桥。

## 错误处理

- 控制关闭时 browser_* 工具明确报 control-disabled，不静默失败。
- 常驻 hold 的 attach 失败：降级为不常驻（提示条可能闪），工具照常，不阻塞，不误报。
- 授权当前页时 tab 已被关闭/内部页：沿用现有 chrome.tabs.get 失败短路径，面板可给出轻提示。

## 测试

- **单元**：debugger-session 的 hold/releaseHold 引用计数与 detach 时机；controlEnabled 归一化与持久化。
- **后台**：routeToolCall 在控制关闭时对所有 browser_* 返回 control-disabled；控制开启且已授权时操作放行。
- **面板**：两按钮渲染与点击；连接状态；审批浮层仅在 pending 时出现；控制开关文案随状态切换。
- **适配/移除**：现有 panel-* 的 React 相关 spec（panel-styles、panel-events、panel-composer、panel-api、panel-approvals、panel-session-transition、panel-attachments 等）更新为小面板行为；删除仅服务于对话的用例。

## 验收标准

- 点击扩展图标 → 面板只见连接状态 + 两个按钮；无对话/历史/设置等。
- 授权当前页面：有组并入、无组新建并授权（后台快照可见）。
- 控制开启（默认）→ 对已授权 target 页，Chrome「正在调试此浏览器」提示条保持常驻不闪烁；关闭控制 → 提示条消失，且 browser_* 工具返回 control-disabled。
- 后台在控制开启且已授权时正常执行浏览器动作；模型对话由 dsh 宿主驱动，不受面板移除影响。