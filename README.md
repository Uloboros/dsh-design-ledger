# dsh-design-ledger

**中文** · [English](README.en.md)

把**设计文档**变成一棵**可实时更新的开发进度树**，并让 DSH 代理在每次会话中自动接上进度。

面向场景：大型项目（游戏 / 软件）在同一个工作区长期开发，单个会话的上下文会被耗尽。本插件把"设计文档 → 进度清单 → 代码索引"变成可持续、可查询、可注入的结构化数据，使新会话能接着干。

## 30 秒理解

```
设计文档（.md / 文件夹）          开发进度树（本插件生成与维护）
┌──────────────────────┐          ┌──────────────────────────────────┐
│ 03_systems/          │  解析    │ index.json   索引（自动注入）      │
│   S01_core_gameplay/ │ ───────► │ systems/     每个系统的完整子树    │
│     design.md        │          │   S01_....json                   │
│   S02_base_building/ │          │ state/       易变进度（可 gitignore）│
│     design.md        │          └──────────────────────────────────┘
└──────────────────────┘                        │
                                                │ 注入
                                    ┌───────────▼───────────┐
                                    │ DSH 会话上下文          │
                                    │ · 任务提示词           │
                                    │ · 索引（系统 + 完成度） │
                                    │ · 当前聚焦子树         │
                                    └───────────────────────┘
```

## 为什么不是"把设计文档全塞进上下文"

实测一份真实设计文档：**19 个 .md / 588 KB / 226,885 字符 ≈ 133,000 tokens**。

| 内容 | 体量 | 能否每次注入 |
|---|---|---|
| 任务开启时的提示词 | 几百字符 | ✅ 可以 |
| 整个设计文档 | ≈133k tokens | ❌ **不可行**（单份系统文档就 ≈65k） |
| 进度索引 | 数 KB | ✅ 可以 |
| 当前聚焦子树 | 数 KB | ✅ 可以 |
| 其余子树 / 代码索引 / bug 明细 | 大 | ❌ 按需读取 |

所以注入策略是**分层的**：索引常驻、聚焦子树常驻、其余按需。这不是妥协，而是唯一可持续的做法。

## 注入策略（用户已确认）

| 层 | 内容 | 时机 |
|---|---|---|
| L0 | **任务开启提示词**（完整） | 会话首次装配时注入一次 |
| L1 | **索引**：系统清单 + 完成度 + 文件指针 | 每次会话注入 |
| L2 | **当前聚焦子树**（优先 `marked` 标记的节点） | 每次会话注入 |
| L3 | 其余子树、代码索引、bug 明细 | 不注入，由 `design_ledger_read` 按需取 |
| L4 | 设计文档原文分片 | 不注入，由 `design_doc_read` 按需取 |

注入走 `system-prompt/assemble`（waterfall）——与 `dsh-agent-instructions` 注入 `AGENTS.md` 同一接缝。

## 进度树的数据模型

每个节点是一行"表项"，字段固定，便于工具解析与你手改：

| 字段 | 含义 |
|---|---|
| `id` | 稳定标识（按层级派生，如 `S02/模块A/功能1`） |
| `name` | **节点名 = 设计文档里的名称**（无名称时按功能/用处命名） |
| `kind` | `system` / `subsystem` / `feature` / `subfeature` / `task` |
| `status` | `todo` / `doing` / `done` / `blocked` / `dropped` |
| `parentId` / `children` | 父子关系（构成树） |
| `designRefs` | **设计文档索引**：`{ file, heading?, anchor? }` |
| `codeRefs` | **代码索引**：`{ file, symbol }`（只记文件 + 符号名，不记行号） |
| `interfaces` | 对外接口/契约 |
| `bugs` | `{ id, summary, status, codeRef?, designRef? }` |
| `notes` | 备注 |
| `marked` | 是否被标记为"当前聚焦"（注入优先） |

**为什么代码索引只记"文件 + 符号名"**：行号会随编辑漂移，符号名稳定。"几到几行"这类信息由编辑器/IDE 提供，不写进台账。

## ⚠️ 开发这个插件时踩过的坑（必读）

这些**真的把 DSH 弄到起不来**、或让功能静默失效/显示错乱，而且原因都很隐蔽。改本插件时请先读这一节。

### 崩溃 1：客户端 `apply()` 里调了不存在的 API → 宿主侧栏一起挂

```
Uncaught TypeError: ctx.locale.get is not a function
Error: web boot: 1 entry did not activate
@deepseek-ai/dsh-client-ui-sidebar: failed      ← 失败的是宿主自己的条目
```

**机制**：客户端半区的 `apply()` 里**任何未捕获异常**都会让宿主把该条目判为"未激活"，并且**连带**把依赖它的宿主条目（这里是 `dsh-client-ui-sidebar`）一起判失败，于是整个 Web 启动失败、应用起不来。

**根因**：`ctx.locale` **没有 `get` 方法**。真实 API 只有：

| API | 签名 | 说明 |
|---|---|---|
| `ctx.locale.register(ns, dict)` | `(ns: string, dict: LocaleDict) => () => void` | 注册字典（`dict` 是扁平 `Record<string,string>`） |
| `ctx.locale.bind(ns)` | `(ns: string) => Translate` | 取翻译函数，**调用时**读当前语言 |

**修复与纪律**：翻译走 `bind` + 本地兜底；并且
- `apply()` 内**每一个**可能失败的动作都各自 `try/catch`；
- 最外层再包一层兜底 `apply()`，保证**永远不向外抛**（`client/client.js` 的 `apply` / `applyInner` 分工就是为此）。

### 崩溃 2：导出没有 schema 的 `Config` → cordis 调用 `.validate` 抛错

```
TypeError: Cannot read properties of undefined (reading 'validate')
  at resolveConfig (cordis/lib/index.js:958)
```

**机制**：cordis 的 `resolveConfig` 是这样的：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config          // ← 没有 Config 就直接返回
  const result = runtime.Config['~standard'].validate(config)   // ← 否则要求 schema
  ...
}
```

所以**要么导出带 `~standard` 的 schemastery schema，要么完全不导出 `Config`**。导出一个普通对象（我为了去掉 schemastery 依赖而这么做过）就会命中 `.validate` 抛错、bundle 激活失败。

**当前做法**：不导出 `Config`，默认值放在内部 `DEFAULTS`，用防御式 `readConfig(ctx.config)` 取值。若将来要暴露可配置项，请引入 `@deepseek-ai/schemastery` 并导出 `Schema.object({...})`。

> 补充：这一条是在**热重载**时暴露的（运行中的宿主缓存了旧模块对象，ESM 按 URL 缓存、改文件不清缓存）。所以**改完插件代码要整应用重启**再判断，不要依赖 HMR 的即时结果。

### 崩溃 3：`webServer.register` 的路由对象缺 `kind` → 路由静默不生效

**症状**：插件 `fiberPhase: active`（加载成功），但 `/design-ledger/*` 一律 **404**（对照：`dsh-whale` 的路由返回 **401**，因为它在信任栅栏之后）。

**机制**：`WebRoute` 的真实契约是

```ts
interface WebRoute {
  kind: 'exact' | 'prefix'   // ← 必需
  path: string
  handler: (req, res) => void | Promise<void>
}
```

**没有 `method` 字段**。我曾写成 `{ method: 'GET', path, handler }` → `register()` 抛错 → **被我自己包在注册外面的 try/catch 吞掉**，于是路由根本没注册，而插件看起来一切正常。

**注册方式的对照（重要）**：可跑通的 `dsh-whale-widget` 是这样做的 ——

```js
root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
  ctx.webServer.register({ kind: 'exact', path, handler })   // 直接注册，不套 ctx.effect
})
```

即：**用注入作用域上的 `ctx.webServer` 直接注册，不要包 `ctx.effect`**。本插件最初写成 `ctx.effect(() => webServer.register(...), label)`，且解析顺序写成了 `ws?.webServer ?? ctx.get('webServer') ?? ctx.webServer`；现已改为与前者一致（先 `ctx.webServer`、直接注册）。

**教训**：防御式 try/catch 会把契约错误变成静默失败。所以：

- `probe/route-test.mjs` 加了**契约自检**（断言每条路由 `kind` 合法），缺 `kind` 时以非零码退出；
- 注册的三种结局都会打一条 `[design-ledger]` 日志：`panel routes registered: 3 (…)` / `ROUTE REGISTRATION FAILED: <stack>` / `webServer unavailable; panel routes NOT registered`。宿主不把 `console.warn` 落盘，所以排障时要看**应用终端/控制台**。

### 崩溃 4：面板配色自创 token → 黑底看不清 / hover 白底白字

**症状（两次，同一个根因）**：

1. 弹窗"太黑、看不清上面的字"（浅色主题下）；
2. **鼠标移到「选择设计文档」「载入为设计文档」上时，背景变白、字也是白的，字直接消失**。

**机制**：颜色 token 必须照抄官方组件，不能凭名字猜。两次都栽在这上面：

| 我写的 | 真实情况 |
|---|---|
| `--dsw-alias-bg-1` / `--dsw-alias-text-1` | **DSH 里不存在** → 永远走 fallback 的硬编码深色 |
| `--dsw-alias-bg-layer-2` 当 hover 底色 | 存在，但**浅色主题下就是纯白**（实测 `var(--dsw-static-neutral-bluish-00)` = `#fff`） |

第二个还叠加了一个 CSS 层叠问题：`.dlg-btn:hover` 与 `.dlg-primary` **特异性相同 (0,2,0)**，
主按钮的底色/文字又是硬编码的（brand 底 + `color:#fff`）；hover 规则一覆盖底色，
就成了"白色背景 + 白色文字"，字彻底看不见。

**正确来源**：不要去猜，直接读官方组件的 CSS ——
`@deepseek-ai/dsh-client-ui-primitives` 的 `Button.module.css` 就是权威：

```css
.primary            { background: var(--dsw-alias-button-primary-fill);   color: var(--dsw-alias-label-primary-foreground); }
.primary:hover      { background: var(--dsw-alias-button-primary-hover); }
.ghost:hover        { background: var(--dsw-alias-interactive-bg-hover); }
.outline            { border: 0.5px solid var(--dsw-alias-border-l3); }
.outline:hover      { background: var(--dsw-alias-interactive-bg-hover); }
```

**关键取值**（从主题 CSS 里读出来的真实定义）：

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` | **交互底色首选**（带透明度，两种主题都安全） |
| `--dsw-alias-button-primary-fill` | `var(--dsw-alias-brand-primary)` | 同 | 主按钮底色 |
| `--dsw-alias-button-primary-hover` | `var(--dsw-static-neutral-bluish-750)` | `…-100` | 主按钮 hover（**有独立规则**） |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` | 主按钮文字 |
| `--dsw-alias-bg-layer-2` | **`#fff`** | `#2b2b2b` | 抬升面 —— **不要拿它当 hover 底色** |

**做法**：交互底色一律用 `--dsw-alias-interactive-bg-hover`；主按钮用 button-primary 三件套；
hover 一律写 `:hover:not(:disabled)`（避免禁用态变色、也顺手规避层叠打架）。
`npm run check:client` 会断言这些约定，防止再犯。

> **`Theme.listTokens` 只列出 14 个 token，是子集**，不含上面用到的 button/interactive 系列 ——
> 所以"用什么 token"要以官方组件 CSS 为准，别只看 inspect 列表。

### 崩溃 5（最严重）：`systemPrompt` 段落文本返回非字符串 → **整个对话一按发送就失败**

```
本轮运行失败
text.indexOf is not a function          UNKNOWN
```

**症状**：只要插件处于启用状态，**任何消息都发不出去**：一发就红字「本轮运行失败」，整个会话瘫痪。
这比面板 404 严重得多 —— 面板坏了还能用对话，这一条把对话本身打掉了。

**机制**（`@deepseek-ai/dsh-system-prompt` 源码）：宿主在**每一轮**装配时对**每个**已注册段落做

```js
// assemble()
text: typeof section.text === 'function' ? section.text(context) : section.text
// 之后 renderPrompt(assembly) → interpolate()
for (let open = text.indexOf('{{'); …)   // ← 第一行就是这里
```

即 `PromptSection.text` 的契约是 `string | ((context) => string)`，**必须同步返回字符串**。
一旦返回 `Promise` / `object` / `undefined`，`interpolate()` 立刻抛
`TypeError: text.indexOf is not a function`，而这是**回合开始处**的调用 —— 于是整个对话不可用。

**修复做法**（`lib/index.js` 注入段）：
1. `text()` 内**只读内存缓存**，绝不读盘、绝不 `await`、绝不返回 Promise；
2. 注入文本由后台任务（`refreshInjectionCache`）预先算好；`apply()` 时预热一次，
   台账变动（`design_ledger_init` / `design_ledger_update` / `bind` 路由）后 `invalidateInjection()` 重算；
3. 过期判断只做一次 `statSync(index.json).mtimeMs` 比较，不用每次读文件；
4. 出口再兜一层 `typeof !== 'string' → ''`，并写 `INJECT-NONSTRING` 诊断日志。

**纪律**：这一段永远不要写成 `async text()`。渲染失败最多让注入内容缺失，绝不允许影响对话。

### 崩溃 6：`defineTool` 的 `parameters` 传了"预编译好的根 schema" → **六个工具全部静默失效**

**症状**：插件 `fiberPhase: active`，注入正常，面板正常，但 `design_ledger_*` / `design_doc_*`
**一个都不存在**（模型调用会得到"未知工具"）。而插件自己的日志里只有一行 warn，很容易被当成"没问题"。

**机制**：官方 `defineTool(options)` 的 `options.parameters` 要的是**隐式属性映射**：

```js
// ✅ 正确：属性表 + 属性上的 required 标注；根对象由宿主编译生成
parameters: { rel: { type: 'string', description: '…', required: true } }

// ❌ 错误：手工预编译根 schema
parameters: { type: 'object', properties: { rel: {...} } }
// → defineTool 构造期抛：
//   unsupported JSON schema: parameters.type must be a value schema object
//   （parameterSchemaSpecToJsonSchema 把它当成一个"值 schema"节点，
//     而 "object" 值节点要求显式 additionalProperties，于是报 type 不合法）
```

因为本插件用 try/catch 把构造期异常吞成了"跳过这一个工具"，结果是**六个全跳过**、
插件却看起来一切正常。**防御式 try/catch 又一次把契约错误变成了静默失败。**

**纪律**：`lib/index.js` 的 `defineTool()` 适配器只做两件事 —— 把顶层 `required: []` 摊到属性上、
给缺 `type` 的标量补 `string`；**根 schema 绝不自己拼**。另外：对象属性必须显式
`additionalProperties: true`，且**不要**给 `type: 'array'` 补 `items`（会让参数校验去匹配元素形状）。

### 崩溃 7：面板把**部署默认根**当成了工作区 → 弹窗空白，且「工作区根」切不回去

**症状**：侧栏「设计文档包含」能打开，点「选择设计文档」弹窗显示
「（此目录下没有子目录或 .md 文件）」；面包屑点「工作区根」也回不到工作区
—— 因为那个根已经被当成工作区**锁死**了。

**机制**：宿主路由**没有 session 上下文**，`sandboxPolicy.resolve()` 给的是**部署默认根**
（本机实测 `D:\AppData\.dsh\profiles\desktop`），不是用户的工作区。
「工作区」这个事实**只存在于会话侧**：工具调用的 `exec.agent.session`、agent 事件。
面板拿不到它，宿主路由也猜不到，于是列了 profile 目录。

**修复**（四层，缺一不可）：

1. **会话工作区旁路记录**（`rememberSessionWorkspace`）：任何一次带 session 的解析
   （工具调用、`agent/created`、`agent/pre-step`）都把工作区记下来，无 session 的路由缺省就用它。
   这是关键 —— 它让**旧版面板**也能落在正确的工作区上。
2. **主动发现**（`discoverSessionWorkspace`）：插件可能在会话诞生**之后**才加载
   （bundle 刚登记、热重载、宿主重启时序），那时事件永远不会来。所以 apply 时以及
   路由兜底时都主动去问 `ctx.agents.list()`，从活着的 agent 反查工作区。
3. **部署根一律不认**（`isDeploymentRoot`）：命中 `/.dsh/profiles/<名字>`、`/node_modules`、
   用户主目录的根，既不做缺省值、也不允许被"确认"，直接 400，面板显示「工作区未知」。
   这条专门防"锁死在 profile 里、再也切不回来"。
4. **面板显式回传** `workspace`（取 `status.json` 的 `workspaceRoot`），宿主侧
   `resolveWs()` 只认第一个被确认的工作区，之后必须一致。

**同一个坑的第二个版本：事件名是编的。** 第一版修复去监听 `agent/session-start` ——
**DSH 里根本没有这个事件**（真实的只有 `agent/created` / `agent/pre-step` / `agent/status` …），
所以除了一次时序巧合外从未触发，面板又退回「工作区未知」。
**教训**：接缝名（事件名、服务名、字段名）必须对着源码或类型定义核实，别按"听起来该叫这个"写；
并且同一个能力要留一条**不依赖事件**的路径（这里是 `agents.list()` 主动发现）。

**教训**：无 session 的端点上，`sandboxPolicy.resolve()` 的返回值**不是**用户的工作区，
必须先想办法从会话侧把工作区"学"过来。另外：**别把"面板能打开"当成"根是对的"** ——
本机就是先修好客户端（面板能显示出路径了），才看清根依然是错的。

### 改这个插件时的验证顺序（**本节供改代码的人看，使用者可跳过**）

> 只想用插件的话，看到这里就够了 —— 直接跳到下面的「界面语言」或「设计文档的解析规则」。
> 下面这些命令在本仓库开发时用，需要 Node；其中带 ⭐ 的探针需要本机装了 DSH（见目录结构后的说明）。

```powershell
npm run verify                                                                                # 语法 + 单测 + 文档体检 + 客户端体检 + 契约自检（推荐，一条命令跑完）
node --import ./probe/register.mjs probe/import-probe.mjs                                     # 能 import 吗
node --test test/core.test.js test/agents-md.test.js                                          # 13 个单测
node probe/client-ui-test.mjs                                                                 # ⭐ 客户端：按钮对比度 / 字典完整性 / 语言接线（不需要 DSH）
node --import ./probe/register.mjs probe/contract-test.mjs                                    # ⭐ 契约自检（崩溃 5/6 + 路由注册）
node --import ./probe/register.mjs probe/panel-list-test.mjs <工作区>                          # ⭐ 面板取数（崩溃 7 + 越界拒绝）
node --import ./probe/register.mjs probe/table-tree.mjs <设计文档>                             # ⭐ 方案 A：表格行 → 功能节点（只读）
node --import ./probe/register.mjs probe/host-smoke.mjs <设计文档> <工作区>                    # 宿主端到端
node --import ./probe/register.mjs probe/route-test.mjs <设计文档>                             # 路由与路径安全
```

`probe/client-ui-test.mjs` 与 `probe/readme-check.mjs` **零依赖**（只用 Node），所以它们同时跑在 CI 上；
其余探针需要本机 DSH 依赖层，只在本地跑。

`probe/contract-test.mjs` 是**回归护栏**，把三个"静默毁掉功能"的契约钉死了：

| 断言 | 守的是哪个崩溃 |
|---|---|
| `section.text()` 同步返回 `string`，且宿主式 `interpolate` 不抛 | 崩溃 5（对话瘫痪） |
| 6 个工具全部注册，且 `parameters` 是 object-rooted schema | 崩溃 6（工具静默失效） |
| `ctx.inject(['webServer'])` 注册 3 条路由；服务未就绪时不误判、就绪后由重试兜底补上 | 面板 `Unexpected end of JSON input` |
| 会话工作区被记录后 `list`/`status` 都用它；部署根/越界/node_modules 一律 400 | 崩溃 7（弹窗空白 + 根切不回来） |
| 无台账 / 台账 JSON 损坏时，注入退化为 `''` 且不抛 | 崩溃 5 的边界情况 |

`probe/client-ui-test.mjs` 则守住**界面**这一侧：

| 断言 | 防的是什么 |
|---|---|
| 交互底色不使用 `--dsw-alias-bg-layer-2`（浅色主题下 = 纯白） | hover 白底白字 |
| 普通/列表 hover 用 `--dsw-alias-interactive-bg-hover` | 同上 |
| 主按钮用 button-primary 三件套，且 hover 有独立规则 | 主按钮变色后文字消失 |
| 主按钮文字不再是硬编码 `#fff` | 深色/浅色主题下对比度失配 |
| `zh` / `en` 键集一致，且代码用到的每个 key 都有翻译 | 界面出现原始 key |
| 槽位声明了 `locale` 命名空间、且不再自注入 `t` | 语言不跟随 DSH + 重复 prop 导致槽位装配抛错 |

## 界面语言（i18n）

面板文案**跟随 DSH 的语言设置**（DSH 内置 locale id 只有 `zh` 与 `en`）：

```js
// 1) 注册两套字典（一次调用覆盖全部内置语言）
ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'design-ledger: dictionaries')

// 2) 槽位声明 locale 命名空间 → 渲染器注入**响应式**的 t 席位
ctx.slots.register({ name: 'main', key: PANEL_ID, locale: LOCALE_NS }, LedgerPanel)
```

关键机制（都已在源码里核实，不是猜的）：

- 渲染器的 `standardKit()` 在 `entry.locale !== undefined` 时执行
  `kit["t"] = localeSeat(face, entry.locale)`，并用 `useLocaleRevision()` 订阅 revision ——
  **所以组件里的 `props.t` 天生响应式，切换语言立即重渲染**，插件不需要自己订阅。
- **因此不能自己 `inject: () => ({ t })`**：渲染器的 `assertNoPropOverlap()` 见到重复 prop 会抛
  `SlotAssemblyError`，那是装配期错误，会让整个条目激活失败。
- 侧栏按钮文字（`label`）由**侧栏**读取：它在每次语言变化时用
  `ctx.locale.subscribe(syncPanels)` 重新解析所有面板标签，所以 `label` 只要返回"当前语言下的文案"，
  就会自动跟随 —— 无需额外通知。
- 字典查找失败时框架的 `t` **返回 key 本身**（不是 `undefined`），所以本地兜底必须先判"是否等于 key"。

## 设计文档的解析规则

支持两种输入：

### 1. 单个 `.md` 文件
按 Markdown 标题层级（`#` / `##` / `###` …）建树。

### 2. 文件夹（递归）
按目录结构推断层级，这是"严格项目管理"结构下最可靠的方式：

| 目录模式 | 推断结果 |
|---|---|
| `NN_<名称>/`（数字前缀） | 顶层分组 / 系统，名称取 `<名称>` |
| `S0N_<名称>/` | **系统**（system） |
| `SNN_<名称>/` | 子系统（subsystem） |
| `design.md` | 该层级的**设计正文** |
| `analysis.md` | 该层级的**分析**（作为附加 `designRef`，不建节点；体量记在节点的 `analysisTokens`） |
| 其他 `*.md` | 归入最近的祖先层级，作为补充材料 |

节点名称**优先取设计文档中的名称**（标题），无标题时按目录名/功能命名。

### 3. 功能表行 → 功能节点（方案 A，`expandTableRows`）

**为什么需要这一条**：很多项目的目录只到 `S0X_<名称>/` 一层，而真正的内容写在
`design.md` 里的**表格**里（每行一个 `XXX_001` 条目，表格自带「当前状态」列）。
只按目录建树的话，每个系统下面是空的，代理没有可推进的功能节点。

| 规则 | 说明 |
|---|---|
| 什么表算"功能表" | **首列即 ID 列**，且**每一行**的首列都形如 `PREFIX_数字`（`BFT_001` / `TEC_009` / `DEV_001`） |
| 什么表不算 | "白天预报与建设 \| S01、S02" 这类普通表格 —— 首列不是 ID，**不建节点**（实测 2 张被正确忽略） |
| 节点 id | `<父节点 id>/<表标题>#<行 ID>`，例如 `03_systems/S03_progression_economy/局外通用科技树表#TEC_001` |
| 节点名 | 取「名称」列；是"待定"时用同行的类别/作用对象补一个可读名（如 `TEC_002（通用科技）`） |
| 节点 notes | 原样保留表格的「当前状态」列（如"机制已明确，名称待定"），渲染时显示为「备注: …」 |
| `designRefs` | `{ file, heading: 表标题, anchor: 行 ID }` —— `anchor` 就是那行的 ID，便于对回文档 |
| `docTokens` | 取该表所在**小节**的体量（`parseStructure` 的分节统计） |

**策略**（`expandTableRows`，写在行配置 `config` 下）：

| 取值 | 行为 |
|---|---|
| `'all'`（默认） | 展开每张 ID 表的所有行；若某文档的表都只有 1 行，至少展开第一张，避免系统节点空着 |
| `'multi-row'` | 只展开行数 > 1 的表（示例性的单行表不建节点，更干净） |
| `false` | 不自动建功能节点，回到"只按目录结构建树" |

**已知边界**：如果某份 `design.md` 里**没有带 ID 列的表**（功能清单写在正文段落里），
该系统的功能节点仍需人工用 `design_ledger_update {parent_id, node_name}` 补，
或给那张表加一列 ID —— 这一条在探针里会**如实报告**是哪些系统，不会假装通过。

### 4. 台账记的是"实际开发"，不是"设计清单"

自动生成只给**骨架 + 候选条目**。**要不要为某个功能建节点，由实际开发决定**：

| 情况 | 做法 |
|---|---|
| 这一轮要做的功能，设计文档里有条目但还没节点 | `design_ledger_update {parent_id, node_name, status:"doing", mark:true}` **新建** |
| 已经在推进 | `mark:true` + `status:"doing"` |
| 做完了 | `status:"done"` + 补 `code_refs` / `interfaces` |
| 设计文档里有、但这轮不做 | **先不建**，等真要做时再建 |

为什么定这条：如果按设计文档把条目一次性全建成空节点，进度树就变成了**设计文档的镜像**，
`完成度` 会被大量"从未动过"的条目稀释，看不出真实进度。按需建节点能让
"树 = 已经动过的部分"，也**更泛用** —— 换项目、换文档风格（正文型/表格型/目录型）都不影响，
自动生成的多与少只是起点。

这条原则同时写在三处，确保任何接手会话都会遵守：
`lib/inject.js` 的注入正文（每个会话都看得到）、`design_ledger_update` 的工具描述、
以及配套技能 `skills/design-ledger/SKILL.md` 第 2.1 节。

## 与 AGENTS.md 的关系

```
AGENTS.md          ← DSH 原生注入（dsh-agent-instructions）：项目简介 + 指向台账 + 当前里程碑
DEVPLAN/
  index.json       ← 本插件注入：系统级索引 + 完成度
  systems/*.json   ← 按需读取：节点表详情
```

`AGENTS.md` 有**字节预算**（超限会被截断），所以它只放摘要与指针；台账明细放 `DEVPLAN/`。两者职责不重叠：`AGENTS.md` 给人读，台账给机器与注入用。

## 安装

装到桌面端 profile（**必须用 `plugin_manager`**——桌面端 profile 由 Electron 应用独占，`dsh plugin --profile desktop` 会被 CLI 拒绝）：

```
plugin_manager  install_bundle  target = link:E:\program\dsh\dsh-design-ledger
```

> - **link 安装时每个 harness import 都必须被 launcher 路由**，因此本包的 `peerDependencies` **必须**声明所有被 import 的 harness 包（当前只有 `@deepseek-ai/dsh-tools`）。为此本插件**刻意不用 schemastery**——两个标量配置不值得引入一个 harness 依赖。
> - 安装后**必须重开桌面客户端**，bundle 层才会激活（`fiberPhase` 从 `null` 变为 `active`）。
> - `plugin_manager` 可能报 `application: failed` + `ambiguous-install`；实测这是**假报**（pnpm 退出码 0、磁盘状态正确）。判断是否成功请用 `plugin_manager list_plugins` 看 `fiberPhase`，或看工具是否出现。
> - profile 的 `package.json` 里还有一份 `dsh.profile.bundles` 列表，bundle **必须同时登记在那里**才能激活。任何 `plugin_manager` 操作都可能重写该文件并丢掉不是它登记的条目——插件"自己消失"时先看这一行。

## 从源码安装（给别人用）

```bash
git clone https://github.com/<owner>/dsh-design-ledger.git
# 然后在 DSH 里：
#   plugin_manager  install_bundle  target = link:<克隆下来的绝对路径>
#   并把 "dsh-design-ledger" 加进 profile 的 dsh.profile.bundles，然后重启客户端
```

无需构建步骤：插件是纯 ESM 的 `.js`，客户端半区也是直接加载的经典脚本。

> 要**发新版本**（打 tag、建 Release、附件 tarball）请见 [RELEASING.md](RELEASING.md) —— 那是维护者流程，与使用者无关，所以不放在这里。

## 验证状态（本机实测）

> 本表在项目被真正跑起来之后重新核对过一遍：旧表里"⏳ 待重开客户端"这类**推测性**状态已换成实测结论，
> 并补上了那轮排查中暴露出来、现已修好并加了回归护栏的契约。

| 项 | 状态 | 证据 |
|---|---|---|
| 核心逻辑单测 | ✅ **13/13 通过** | `node --test test/*.test.js` |
| 契约自检（回归护栏） | ✅ | `probe/contract-test.mjs`：注入文本必须是同步字符串、6 工具注册、3 路由注册、无台账/台账损坏都不抛 |
| 面板取数 | ✅ | `probe/panel-list-test.mjs`：会话工作区解析正确；部署根/越界/node_modules 一律 400 |
| 功能表行建树 | ✅ | `probe/table-tree.mjs`：真实文档识别 5 张功能表 / 16 行，2 张普通表被正确忽略 |
| 插件可导入 | ✅ | `node --check` + `probe/import-probe.mjs`（`name`/`inject`/`apply` 齐全，`default === undefined`） |
| 6 个工具注册 | ✅ | 宿主日志 `tools: built=6 ctx.tools=obj register=function` → `tools: registered=6/6` |
| `systemPrompt` 注入段落 | ✅ | 段落注册成功并产出文本；**且不会打断对话**（见「崩溃 5」） |
| **3 条 JSON 路由** | ✅ | `GET status.json`、`GET list.json`、`POST bind.json`；宿主日志 `inject([webServer]) fired: register=function` → `routes registered=3` |
| 路径安全（工作区限制） | ✅ | `../../Windows`、`..%2F..%2FWindows`、`C:\Windows`、`/etc` **全部 403**；`resolveWs` 只认第一个被确认的工作区 |
| 真实设计文档端到端 | ✅ | 14 个 .md / 153,957 字符 / **≈92.7k tokens**；识别 **4 个系统** + **16 个功能节点**（表格行展开），名称取自文档 H1 |
| 多层树（系统→子系统→功能→子功能） | ✅ | 合成结构验证：`核心玩法系统 → 战斗子系统 → 命中判定/伤害计算`；`S01_01_01_x` 归类为 `feature` |
| 更新节点（状态/代码索引/接口/bug/mark） | ✅ | 实测 `acted = created … / status=doing / marked / codeRefs+=1 / interfaces+=1 / bug added …` |
| 聚焦注入跨回合刷新 | ✅ | 上一轮 `mark:true` → 下一轮上下文出现 `聚焦：基地构筑与建筑运行 › 机枪塔`（含代码索引与接口） |
| 重复 bind 保护 | ✅ | 已存在台账时 `409 ledger-exists`（不覆盖进度） |
| **AGENTS.md 联动** | ✅ | 托管块幂等：重复写入逐字节一致；**绝不覆盖块外用户内容**；行内引用标记不干扰边界定位 |
| 插件在 DSH 中**激活** | ✅ | `plugin_manager list_plugins` → `include:design-ledger` / `fiberPhase: active` |
| 客户端侧栏入口 + 图形选择器 | ✅ | 侧栏「设计文档包含」可用；选择器能列出会话工作区目录并完成绑定 |

### 图形化设计文档选择器

面板（侧栏「设计文档包含」）里点「选择设计文档」打开模态浏览器：

- 面包屑导航 + 上一级 + 工作区根
- 目录行显示**子树内 .md 数量**（便于识别哪个目录是设计文档集），可点进去或直接选出
- `.md` 文件行显示大小，可直接选中
- 选中后「载入为设计文档」→ `POST bind.json` 建台账；已存在台账时提示可「重建」

**安全边界**：所有路径都在**宿主**侧做工作区内校验（`safeJoin` + `isInside`），并明确拒绝绝对路径与 `..`；面板无法读取工作区外的任何内容。

## 工具

| 工具 | 作用 |
|---|---|
| `design_ledger_status` | 当前绑定状态：设计文档路径、台账位置、统计（节点数/完成度/待办 bug） |
| `design_ledger_init` | 绑定设计文档并生成初始进度树（可指定路径或让其列出候选） |
| `design_ledger_read` | 按需读取：索引 / 某系统子树 / 某节点详情 / bug 列表 |
| `design_ledger_update` | 更新节点：状态、代码索引（文件+符号）、接口、bug、备注、mark 标记 |
| `design_doc_read` | 按需读取设计文档原文（单文件或某层级） |
| `design_doc_list` | 列出设计文档树与各文件体量，便于按需选择 |

## 目录结构

```
dsh-design-ledger/
├── package.json                # DSH bundle 清单 + dsh.client 声明 + dsh.bundle.patch
├── cordis.patch.yml            # 挂载行（把本插件插入 profile 配置树）
├── LICENSE                     # MIT
├── CHANGELOG.md                # 更新日志（0.1.0 起）
├── .gitattributes              # 文本一律 LF 入库（Windows 开发，避免整文件换行 diff）
├── .gitignore                  # 忽略 .design-ledger/（插件落盘诊断）与 DEVPLAN/state.json
├── README.md / README.en.md    # 中文 / 英文文档（逐节对照）
├── RELEASING.md                # 发版流程（只给维护者看，使用者可忽略）
├── lib/
│   ├── index.js                # 宿主侧插件：6 个工具 + 3 条面板路由 + 注入段落
│   ├── design-doc.js           # 设计文档扫描、标题分节、表格行抽取（纯逻辑，可单测）
│   ├── ledger.js               # 进度树的建/读/改 + JSON 分片存储（纯逻辑）
│   ├── inject.js               # 分层注入文本装配
│   └── agents-md.js            # AGENTS.md 托管块（幂等写入，不覆盖块外内容）
├── client/
│   └── client.js               # 浏览器半区：侧栏「设计文档包含」入口 + 面板 + 选择器
├── skills/
│   └── design-ledger/
│       └── SKILL.md            # 配套技能：如何建台账、如何随开发更新
├── .github/workflows/ci.yml    # CI：语法检查 + 单测 + 文档体检（零依赖，刻意不跑探针）
├── test/                       # 零依赖断言测试（node --test，13 个用例）
└── probe/                      # 自检探针（可重复运行的契约/取数/建树验证）
    ├── register.mjs            # 注册解析钩子（配合 resolve-hook.mjs）
    ├── contract-test.mjs       # ⭐ 契约自检：注入文本必须是字符串 / 6 工具注册 / 路由注册
    ├── panel-list-test.mjs     # ⭐ 面板取数：会话工作区解析 + 越界拒绝
    ├── table-tree.mjs          # ⭐ 功能表行 → 功能节点（真实设计文档，只读）
    ├── readme-check.mjs        # 两版 README 体检：结构对齐 / 围栏成对 / 链接可解析（npm run check:readme）
    ├── client-ui-test.mjs      # 客户端体检：按钮对比度 token / 字典完整性 / 语言接线（npm run check:client）
    ├── publish-audit.mjs       # 发布审计：与 GitHub 逐文件比对（Git blob 哈希）+ 隐私体检（npm run audit）
    ├── reorder-crashes.mjs     # 维护脚本：把「崩溃 N」小节重排为升序（发布前跑一次）
    ├── host-smoke.mjs          # 宿主端到端（假 ctx 跑完整流程）
    ├── route-test.mjs          # 路由行为与路径安全
    ├── deep-tree.mjs           # 多层目录树（系统→子系统→功能→子功能）
    ├── import-probe.mjs        # 能否 import、导出形状
    └── resolve-hook.mjs        # 解析实现：把 @deepseek-ai/* 指向 DSH 的依赖目录
```

开发时验证顺序见上文「改这个插件时的验证顺序」。

> **跑探针前要让它找到 DSH 的依赖目录**（探针要在 Node 里复现 DSH 的模块解析，
> 需要 `@deepseek-ai/*` 的真实安装位置）。`probe/resolve-hook.mjs` **不写死**任何本机路径：
>
> 1. 若设了 `DSH_SHARED_NODE_MODULES`，**以它为准**（指错了会立刻报错，不会偷偷回退）；
> 2. 否则用 `DSH_HOME`（默认 `~/.dsh`）与 `DSH_PROFILE` 推导，依次尝试
>    `<home>/profiles/node_modules`、`<home>/profiles/<profile>/node_modules`、
>    `<home>/profiles/desktop/node_modules`；
> 3. 判定标准是"**这个目录里真的有 `@deepseek-ai/dsh-tools`**"，而不是"目录存在"——
>    本机 `profiles/desktop/node_modules` 与 `profiles/node_modules` 都存在，但 harness 包只在后者里。
>
> ```powershell
> # 需要显式指定时（PowerShell）
> $env:DSH_SHARED_NODE_MODULES = 'D:\AppData\.dsh\profiles\node_modules'
> ```
>
> 自动探测与显式指定都会先自检，**指错了会直接给出可操作的报错**，不会静默退化成弱校验。
> 另外：`lib/`、`client/` 与 `test/` 都不含任何本机路径，`npm test` 只要 Node、不需要 DSH，
> 所以 CI 只跑 `npm run check` / `npm test` / `npm run check:readme`。

## 许可

MIT
