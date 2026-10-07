/**
 * dsh-design-ledger —— 宿主侧插件。
 *
 * 职责：
 *   1. 注册 6 个 design_* 工具：绑定设计文档、生成/读取/更新进度台账；
 *   2. 通过 `system-prompt/assemble` 把「索引 + 当前聚焦子树（+ 任务开启提示词）」
 *      按分层策略注入会话上下文，使新会话自动接上进度；
 *   3. 与 AGENTS.md 分工：AGENTS.md 由 dsh-agent-instructions 原生注入（给人读的摘要），
 *      本插件注入的是结构化台账（给机器读的细节）。
 *
 * 刻意不注入完整设计文档：实测一份真实设计文档约 133k tokens，全量注入不可行。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { defineTool as defineToolOfficial } from '@deepseek-ai/dsh-tools'

import { buildLedgerFromScan, countSubtree, Ledger, rollupStatus, STATUSES, BUG_STATUSES } from './ledger.js'
import { assembleInjection, renderIndex, renderFocusSubtree } from './inject.js'
import { syncAgentsFile } from './agents-md.js'
import { readDocContent, scanDesignDocs, toSkeleton, estimateTokens, isInside } from './design-doc.js'

export const name = 'design-ledger'

/**
 * 需要注入的服务。`sandboxPolicy` 用于解析工作区根目录；
 * `systemPrompt` 用于注册注入段落；`tools` 用于注册工具；
 * `agents` 用于**主动发现会话工作区**（路由没有 session，只能从活着的 agent 反查）。
 * 这些都在 godot-bridge 里实测可注入（同一 DSH 0.2.0-rc.2 运行时）。
 *
 * ⚠️ 这里**不**声明 webServer：面板路由走自己的 `ctx.inject(['webServer'], …)`
 * 作用域注册（见文件后部"面板路由"一节），那是本插件唯一需要等就绪的服务，
 * 放在顶层 inject 里不会改变就绪时序。
 */
export const inject = ['tools', 'sandboxPolicy', 'systemPrompt', 'agents']

/**
 * 宿主侧配置的默认值。
 *
 * ⚠️ **刻意不导出 `Config`**：cordis 一旦看到 `Config` 就会调用 `config.validate(...)`，
 * 纯对象没有 `validate`，会抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')`
 * （实测踩过，导致 bundle 激活失败）。
 * 本插件只有两个标量配置且 `readConfig()` 已做防御式取值，所以不声明配置 schema；
 * 若将来需要 schema，请引入 schemastery 的 `Schema.object({...})` 并导出为 `Config`。
 */
const DEFAULTS = {
  ledgerDir: 'DEVPLAN',
  injectEnabled: true,
  /**
   * 设计文档里「功能表行 → 功能节点」的展开策略（方案 A）：
   *   'all'       —— 展开每张 ID 表的所有行；若某文档的表都只有 1 行，至少展开第一张
   *   'multi-row' —— 只展开行数 > 1 的表（示例性的单行表不建节点）
   *   false       —— 不自动建功能节点（回到"只按目录结构建树"的旧行为）
   * 之所以做成配置：有些文档的表格只是举例（1 行），全展开会造出噪声节点。
   */
  expandTableRows: 'all',
}

/**
 * 代码版本标记。
 *
 * 为什么必须有它：宿主 console 不落盘，ESM 又有模块缓存（cordis HMR 还可能只更新
 * 一部分模块），所以"现在跑的到底是哪一版代码"曾经完全无法判断 —— 排查时出现过
 * "文件里明明有某行、日志里却没有"的死胡同。
 * 它出现在两处：`design_ledger_status` 的返回值，以及 diag 日志的 apply 记录。
 */
const BUILD_ID = 'v4-2026-10-06-table-rows'

/** 从 ctx.config 安全读取配置（缺省值兜底）。 */
function readConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const rawExpand = c.expandTableRows
  const expandTableRows =
    rawExpand === false || rawExpand === 'none' || rawExpand === 'off'
      ? false
      : rawExpand === 'multi-row'
        ? 'multi-row'
        : DEFAULTS.expandTableRows
  return {
    ledgerDir: typeof c.ledgerDir === 'string' && c.ledgerDir.length > 0 ? c.ledgerDir : DEFAULTS.ledgerDir,
    injectEnabled: c.injectEnabled === false ? false : true,
    expandTableRows,
  }
}

/**
 * 工具定义适配器：把本模块的紧凑写法
 *   `{ properties: { rel: { type: 'string', description } }, required: ['rel'] }`
 * 适配成官方 `defineTool` 期望的形态。
 *
 * ⚠️ 官方契约（实测，曾因此**六个工具全部静默失效**）：
 *   `options.parameters` 要的是**隐式属性映射** `{ [prop]: <值 schema>, … }`，
 *   每项的 `required` 是**属性上的布尔标注**；根对象的
 *   `{ type: 'object', properties, required }` 由 `parameterSchemaSpecToJsonSchema()`
 *   内部编译生成。
 *   之前这里手工预编译了一份根 schema（`parameters = { type: 'object', properties }`
 *   + 分开的 `required` 数组），官方编译器把它当成一个"值 schema"节点，
 *   于是抛：
 *     unsupported JSON schema: parameters.type must be a value schema object
 *   六个工具**全部**在构造期被拒 → 插件看起来 active，但一个 design_* 工具都没有。
 *   接缝是 `properties` 这张表，不是它的外壳。
 *
 * `required` 既可以写在属性上（`required: true`），也可以用顶层 `required: []` 数组，
 * 两种都支持；标量属性一律补 `type: 'string'` 兜底（官方要求必须有 type 或 oneOf）。
 */
function defineTool(opt) {
  const required = Array.isArray(opt.required) ? opt.required : []
  /** 隐式属性映射：这就是官方 `parameters` 接口。 */
  const parameters = {}
  for (const key of Object.keys(opt.properties || {})) {
    const spec = Object.assign({}, opt.properties[key])
    if (required.includes(key)) spec.required = true
    if (!spec.type && !spec.oneOf) spec.type = 'string'
    // 注意：不要给 `type: 'array'` 补 items —— 官方把 items 视为可选，补一个会导致
    // 参数校验去匹配元素形状（本插件多数数组参数的元素形状由工具自己校验）。
    // 对象属性必须显式声明 additionalProperties（官方硬要求）
    if (spec.type === 'object' && typeof spec.additionalProperties !== 'boolean') spec.additionalProperties = true
    parameters[key] = spec
  }
  const def = {
    name: opt.name,
    description: opt.description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
  }
  if (opt.timeoutMs) def.timeoutMs = opt.timeoutMs
  def.execute = async function (args, exec) {
    try {
      return await opt.execute(args, exec)
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  }
  // 官方 defineTool 在**构造期**就校验 schema（例如对象参数缺 additionalProperties
  // 会抛 UNSUPPORTED_SCHEMA）。这里兜住：单个工具不合法只记一条告警并跳过，
  // 不要让整个插件 fiber 失败、连带把宿主启动搞挂。
  try {
    return defineToolOfficial(def)
  } catch (e) {
    // 说明：注册期 schema 校验的具体原因只在这里出现一次，所以既写诊断日志也告警，
    // 否则"工具数为 0"这种症状完全没有线索（曾经就是这样被吞掉的）。
    const why = String((e && e.message) || e)
    diag('defineTool rejected: ' + opt.name + ' — ' + why)
    ctxLoggerWarn('[design-ledger] tool definition rejected, skipped: ' + opt.name + ' — ' + why)
    return { __designLedgerDisabled: true, name: opt.name }
  }
}

/** 在模块作用域里没有 ctx 时的告警出口（apply 内会替换为 ctx.logger）。 */
let ctxLoggerWarn = (m) => console.warn(m)

/**
 * 诊断通道自检。
 *
 * 动机：排查本插件时遇到过"源码里明明有某行 diag(...)，日志里却完全没有"的情况，
 * 一度把人引向"宿主加载了旧模块"的错误结论。诊断通道假死比不写日志更危险，所以
 * 每次 apply 都写一条带唯一标记的记录，并**立刻回读**确认它真的落盘了。
 *
 * 结果写进同一份日志：
 *   DIAG-CHANNEL OK ...                    → 通道正常（之后缺行只可能是代码没跑到）
 *   DIAG-CHANNEL BROKEN ... <原因>          → 通道坏了，任何"日志里没有"的推论都不可信
 */
function diagVerifyChannel() {
  const marker = 'DIAG-CHANNEL-PROBE-' + Date.now()
  diag(marker)
  try {
    if (!diagDir) {
      diag('DIAG-CHANNEL BROKEN: diagDir=null（工作区未解析，所有诊断都被丢弃）')
      return
    }
    const content = readFileSync(join(diagDir, 'diag.log'), 'utf8')
    if (content.includes(marker)) {
      diag('DIAG-CHANNEL OK path=' + join(diagDir, 'diag.log') + ' bytes=' + content.length)
    } else {
      diag('DIAG-CHANNEL BROKEN: 写入的标记回读不到（写入被拦截/被其它进程覆盖）')
    }
  } catch (e) {
    diag('DIAG-CHANNEL BROKEN: 回读失败 ' + String((e && e.message) || e))
  }
}

/**
 * 落盘诊断。
 *
 * 为什么需要它：DSH 宿主的 console 输出**不落盘**（实测 userData 与 DSH_HOME 下都没有
 * 日志文件），而"插件加载失败"这类问题又必须看到原因。
 *
 * 写入位置**必须在工作区内**（`<workspaceRoot>/.design-ledger/diag.log`）：这是本会话
 * 文件沙箱允许写入的区域，也不会污染用户主目录。工作区不可得时退化为不写。
 */
let diagDir = null

/** 由 apply() 设置诊断目录（工作区内的 .design-ledger）。 */
function setDiagDir(dir) {
  diagDir = dir
}

function diag(line) {
  try {
    if (!diagDir) return
    mkdirSync(diagDir, { recursive: true })
    writeFileSync(join(diagDir, 'diag.log'), '[' + new Date().toISOString() + '] ' + String(line) + '\n', {
      encoding: 'utf8',
      flag: 'a',
    })
  } catch {
    /* 诊断本身绝不能抛 */
  }
}

/** 注册一组工具定义，跳过构造期被标记为不可用的条目。 */
function registerTools(target, defs) {
  let ok = 0
  for (const d of defs) {
    if (!d || d.__designLedgerDisabled) continue
    try {
      ;(target || []).push(d)
      ok += 1
    } catch (e) {
      ctxLoggerWarn('[design-ledger] tool push failed: ' + String((e && e.message) || e))
    }
  }
  return ok
}

export function apply(ctx) {
  try {
    diag('[' + new Date().toISOString() + '] apply() start')
    // 自检：上面那行 diag 是"诊断通道是否真的落盘"的第一个探针。
    // 曾经出现"代码里有这行、日志里却没有"的诡异情况（诊断通道假死比不写日志更危险，
    // 会把人引向完全错误的结论），所以这里立刻回读一次并记录结论。
    diagVerifyChannel()
    applyInner(ctx)
    diag('[' + new Date().toISOString() + '] apply() returned OK')
  } catch (e) {
    diag('[' + new Date().toISOString() + '] APPLY THREW: ' + String((e && e.stack) || e))
    // 宿主侧兜底：插件初始化异常不应让 DSH 起不来（观测到的失败模式是
    // 启动报 "N entry did not activate" 并连带影响其它条目）。
    ctxLoggerWarn('[design-ledger] host half failed to apply; plugin degraded: ' + String((e && e.stack) || e))
    try {
      ctx.logger?.warn?.('[design-ledger] host half failed to apply; plugin degraded')
    } catch {
      /* ignore */
    }
  }
}

function applyInner(ctx) {
  // 每次 apply 都留一条带版本号的记录：判断"现在跑的到底是哪一版代码"全靠它。
  // （宿主不落盘 console，ESM 又有模块缓存，改完代码必须整应用重启才会生效。）
  diag('BUILD=2026-10-06-contract-fix-v2 applyInner start')
  ctxLoggerWarn = (m) => {
    try {
      if (ctx.logger?.warn) ctx.logger.warn(m)
      else console.warn(m)
    } catch {
      /* ignore */
    }
  }
  // 重要：cordis 不允许裸访问 ctx.config —— 实测抛
  //   Error: cannot get property "config" without inject
  // 之前这里直接读它，导致 applyInner 一开头就抛、被外层兜底吞掉：
  // 结果是插件显示 active，但工具/路由/注入全都没注册、面板路由一律 404。
  let config = { ledgerDir: DEFAULTS.ledgerDir, injectEnabled: DEFAULTS.injectEnabled }
  try {
    config = readConfig(ctx.config)
  } catch (e) {
    diag("ctx.config unavailable (using defaults): " + String((e && e.message) || e))
  }
  const ledgerDirName = config.ledgerDir
  // 诊断目录固定在工作区内（沙箱允许写入，且不污染用户主目录）。
  try {
    const wsForDiag = workspaceRoot(null)
    setDiagDir(join(wsForDiag || process.cwd(), '.design-ledger'))
  } catch {
    /* ignore */
  }

  // （注入文本的缓存见文件后部的注入段：那里用同步缓存，因为 PromptSection.text 必须同步。）

  /**
   * 会话工作区旁路记录。
   *
   * 为什么需要：**路由没有 session 上下文**，`sandboxPolicy.resolve()` 只能给部署默认根
   * （本机是 `D:\AppData\.dsh\profiles\desktop`），不是用户的工作区。而"工作区"这个事实
   * 只有会话侧知道 —— 工具调用（`exec.agent.session`）和 `agent/session-start` 事件都带着它。
   * 于是：任何一次能拿到 session 的调用都把工作区记下来，路由缺省时就用这条记录。
   * 这样面板（乃至旧版面板）都能落在正确的工作区上，而不是 profile 目录。
   */
  let lastSessionWorkspace = null

  /**
   * 判定"这不可能是一个用户工作区"。刻意**不硬编码本机路径**，按结构规则识别：
   *   · 路径里出现 `/.dsh/profiles/<名字>`（DSH 的 profile 目录 = 部署默认根的常见来源）
   *   · 路径里出现 `/node_modules/`
   *   · 恰好等于用户主目录
   * 只用于"不要把部署根误当成工作区"，命中时只是少一个兜底来源，不影响正常工作。
   */
  const isDeploymentRoot = (p) => {
    const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
    // 注意用 \/?$ —— 双保险写法里 `$` 只作用于最后一个分支，曾因此漏判过
    if (/\/\.dsh\/profiles\/[^/]+\/?$/i.test(s)) return true
    if (s.includes('/node_modules/')) return true
    if (/\/node_modules\/?$/i.test(s)) return true
    try {
      const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '')
      if (home && s.toLowerCase() === home.toLowerCase()) return true
    } catch {
      /* ignore */
    }
    return false
  }

  /**
   * 记录会话工作区（已记录则不改）。
   * @returns {boolean} 本次是否**首次**记录（调用方据此决定要不要预热注入缓存）
   */
  function rememberSessionWorkspace(root) {
    try {
      if (!root || typeof root !== 'string') return false
      if (isDeploymentRoot(root)) return false
      if (lastSessionWorkspace !== null) return false
      lastSessionWorkspace = root
      diag('会话工作区已记录: ' + root + '（面板路由缺省将使用它）')
      // 记录到工作区后，注入缓存必须按它重算（apply 阶段只能用部署默认根）。
      const ledger = new Ledger(root, ledgerDirName)
      void ledger
        .exists()
        .then((ok) => {
          if (ok) void refreshInjectionCache(root)
        })
        .catch(() => {})
      return true
    } catch {
      return false
    }
  }

  /**
   * 从事件里学会话工作区。
   *
   * ⚠️ 事件名必须用 DSH 真实存在的：`agent/created`（agent 注册时）与 `agent/pre-step`
   * （每轮每步开始，waterfall）。**曾经写成 `agent/session-start` —— 这个事件在 DSH 里
   * 根本不存在**，所以除了一次巧合之外从未触发过，面板就退回「工作区未知」。
   * 教训：接缝名要对着源码/类型定义核实，别按"听起来应该叫这个"写。
   */
  const learnFromAgent = (agent, source) => {
    try {
      const session = agent && agent.session ? agent.session : null
      if (!session) return
      const resolved = ctx.sandboxPolicy.resolve({ session })
      const root = resolved && resolved.workspaceRoot
      if (root && !isDeploymentRoot(root)) {
        if (rememberSessionWorkspace(root)) diag('会话工作区已记录（来源 ' + source + '）: ' + root)
      }
    } catch (e) {
      diag('从 ' + source + ' 解析工作区失败: ' + String((e && e.message) || e))
    }
  }
  try {
    ctx.on('agent/created', (payload) => learnFromAgent(payload && payload.agent, 'agent/created'))
  } catch (e) {
    diag('注册 agent/created 监听失败: ' + String((e && e.message) || e))
  }
  try {
    // waterfall：必须调用 next() 并返回它的结果，否则会打断回合装配
    ctx.on('agent/pre-step', (payload, next) => {
      learnFromAgent(payload && payload.agent, 'agent/pre-step')
      return next()
    })
  } catch (e) {
    diag('注册 agent/pre-step 监听失败: ' + String((e && e.message) || e))
  }

  /**
   * 主动发现：从**当前活着的 agent** 里取一个会话来解析工作区。
   *
   * 为什么不能只靠 `agent/session-start` 事件：那个事件在**会话诞生**时触发一次。
   * 本插件如果在会话诞生之后才 apply（bundle 刚登记、插件热重载、宿主重启时序等），
   * 就永远收不到它 —— 实测正是这样：事件在 11:12:41 触发过一次并正确记录了工作区，
   * 但下一次重启后没再触发，面板就退回「工作区未知」。
   * 所以必须能**主动去问**，而不是等通知。
   */
  function discoverSessionWorkspace() {
    try {
      const agentsSvc = ctx.agents || (typeof ctx.get === 'function' ? ctx.get('agents') : null)
      if (!agentsSvc || typeof agentsSvc.list !== 'function') return null
      const live = agentsSvc.list()
      if (!Array.isArray(live) || live.length === 0) return null
      for (const agent of live) {
        const session = agent && agent.session ? agent.session : null
        if (!session) continue
        const resolved = ctx.sandboxPolicy.resolve({ session })
        const root = resolved && resolved.workspaceRoot
        if (root && !isDeploymentRoot(root)) {
          diag('主动发现会话工作区: ' + root + '（来自 agents.list()，共 ' + live.length + ' 个 agent）')
          return root
        }
      }
    } catch (e) {
      diag('discoverSessionWorkspace 失败: ' + String((e && e.message) || e))
    }
    return null
  }

  /**
   * 解析工作区根目录（与 godot-bridge 同法）。
   *
   * 优先级：**当前 session** → **已记录过的会话工作区** → **主动发现（agents.list）** →
   * （仅当它不像部署根时）策略缺省值。
   * 路由没有 session，所以中间两档是它们唯一可靠的来源。
   */
  function workspaceRoot(exec) {
    try {
      const policy = ctx.sandboxPolicy
      if (policy) {
        const session = exec && exec.agent && exec.agent.session
        const resolved = session ? policy.resolve({ session }) : policy.resolve()
        if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
          if (session) {
            // 带 session 的解析是权威的：记下来给无 session 的路由复用
            rememberSessionWorkspace(resolved.workspaceRoot)
            return resolved.workspaceRoot
          }
          if (!isDeploymentRoot(resolved.workspaceRoot)) return resolved.workspaceRoot
        }
      }
    } catch {
      /* 忽略：调用方会给出指引 */
    }
    if (lastSessionWorkspace) return lastSessionWorkspace
    // 还没有记录（例如插件在会话诞生之后才加载）：主动问一次
    const found = discoverSessionWorkspace()
    if (found) {
      rememberSessionWorkspace(found)
      return found
    }
    return null
  }

  /** 取台账门面。 */
  function ledgerFor(exec) {
    const root = workspaceRoot(exec)
    if (!root) return { error: 'cannot resolve workspace root for this session' }
    return { root, ledger: new Ledger(root, ledgerDirName) }
  }

  /** 载入台账并建立便捷索引。 */
  async function loadLedger(ledger) {
    const loaded = await ledger.load()
    if (!loaded.ok) return loaded
    return loaded
  }

  /** 递归查找设计文档候选：工作区根下的 .md 与含 .md 的目录（浅层）。 */
  async function listDesignCandidates(root) {
    const out = []
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(root, e.name)
      if (e.isDirectory()) {
        let count = 0
        let bytes = 0
        try {
          const stack = [p]
          while (stack.length > 0 && count < 5000) {
            const cur = stack.pop()
            for (const c of await readdir(cur, { withFileTypes: true })) {
              if (c.name.startsWith('.')) continue
              const cp = join(cur, c.name)
              if (c.isDirectory()) stack.push(cp)
              else if (extname(c.name).toLowerCase() === '.md') {
                count += 1
                try {
                  bytes += (await stat(cp)).size
                } catch {
                  /* ignore */
                }
              }
            }
          }
        } catch {
          /* ignore */
        }
        if (count > 0) out.push({ path: p, type: 'dir', mdCount: count, bytes })
      } else if (extname(e.name).toLowerCase() === '.md') {
        let bytes = 0
        try {
          bytes = (await stat(p)).size
        } catch {
          /* ignore */
        }
        out.push({ path: p, type: 'file', mdCount: 1, bytes })
      }
    }
    out.sort((a, b) => b.mdCount - a.mdCount)
    return out
  }

  // ─────────────────────────── 工具 ───────────────────────────

  const tools = []

  tools.push(
    defineTool({
      name: 'design_ledger_status',
      description:
        '查看设计文档进度台账的当前状态：设计文档绑定、台账位置与文件、系统数量、总体完成度、未修复 bug 数、注入配置。用于确认"这个工作区有没有台账、接上了没有"。只读。',
      properties: {},
      async execute(args, exec) {
        const ctxL = ledgerFor(exec)
        if (ctxL.error) return { error: ctxL.error, build: BUILD_ID }
        const { root, ledger } = ctxL
        const loaded = await loadLedger(ledger)
        if (!loaded.ok) {
          const candidates = await listDesignCandidates(root)
          return {
            build: BUILD_ID,
            bound: false,
            workspaceRoot: root,
            ledgerDir: ledger.root,
            reason: loaded.reason,
            ...(loaded.error ? { error: loaded.error } : {}),
            hint:
              '尚未建立台账。调用 design_ledger_init 绑定设计文档；若不确定用哪个，先看 designCandidates。',
            designCandidates: candidates.slice(0, 20),
          }
        }
        const { index, bySystem, allNodes, state } = loaded
        let total = 0
        let done = 0
        let openBugs = 0
        for (const s of index.systems ?? []) {
          const nodes = bySystem.get(s.id)
          const sysNode = nodes ? [...nodes.values()].find((n) => n.id === s.id) : undefined
          if (sysNode && nodes) {
            const st = countSubtree(sysNode, nodes)
            total += st.total
            done += st.done
          }
        }
        for (const n of allNodes.values()) {
          openBugs += (n.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing').length
        }
        const files = await ledger.listFiles()
        return {
          // 让"当前跑的是哪一版代码"可以直接从工具结果里读出来（见 BUILD_ID 注释）
          build: BUILD_ID,
          bound: true,
          workspaceRoot: root,
          ledgerDir: ledger.root,
          designInput: index.design?.input,
          designStats: {
            files: index.design?.fileCount,
            chars: index.design?.chars,
            tokens: index.design?.tokens,
          },
          systems: (index.systems ?? []).length,
          nodes: total,
          done,
          openBugs,
          markedNodes: [...allNodes.values()].filter((n) => n.marked === true).map((n) => n.id),
          hasTaskPrompt: typeof state?.taskPrompt === 'string' && state.taskPrompt.trim().length > 0,
          injection: index.injection,
          // 功能节点是怎么来的：'all' | 'multi-row' | false（方案 A 的展开策略）
          expandTableRows: index.expandTableRows ?? null,
          // 功能节点数（= 叶子节点）；`nodes` 含系统节点自身，两者差别即"汇总层"
          featureNodes: [...allNodes.values()].filter((n) => (n.children ?? []).length === 0).length,
          ledgerFiles: files.map((f) => ({ path: f.path, bytes: f.bytes })),
        }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'design_ledger_init',
      description:
        '绑定设计文档并生成初始进度台账。design_path 可传工作区内的 .md 文件或文件夹（文件夹会递归读取其中所有 .md，并按子文件夹名称推断系统/子系统层级）；不传则返回候选清单供选择。task_prompt 是"开启这个任务时用户说的那段话"，会被完整注入后续会话，用于让新会话知道目标。会写入 <工作区>/DEVPLAN/。' +
        '生成的只是**骨架与候选条目**：设计文档里带 XXX_001 ID 的表格行会被展开成候选功能节点，但台账最终记的是**实际开发**的功能 —— 该轮不做的候选可以先留着不用，需要新功能时用 design_ledger_update {parent_id, node_name} 新建。',
      properties: {
        design_path: {
          type: 'string',
          description: '工作区内的设计文档路径：单个 .md 或文件夹（相对工作区根或绝对路径）。省略则只列出候选。',
        },
        task_prompt: {
          type: 'string',
          description: '开启本任务时用户的完整需求描述（原话）。会被完整注入后续会话。',
        },
        force: {
          type: 'boolean',
          description: '已存在台账时是否覆盖重建（默认 false，会拒绝覆盖以免丢进度）。',
        },
      },
      async execute(args, exec) {
        const ctxL = ledgerFor(exec)
        if (ctxL.error) return { error: ctxL.error }
        const { root, ledger } = ctxL

        if (!args.design_path) {
          const candidates = await listDesignCandidates(root)
          const existing = await ledger.exists()
          return {
            needChoice: true,
            workspaceRoot: root,
            ledgerExists: existing,
            designCandidates: candidates.slice(0, 30),
            hint:
              '把上面某个 path 作为 design_path 传入。文件夹会递归解析并按子目录名推断系统层级。' +
              (existing ? ' 注意：已有台账，重建需 force=true。' : ''),
          }
        }

        if (await ledger.exists() && args.force !== true) {
          const loaded = await loadLedger(ledger)
          return {
            error: '台账已存在，未覆盖（避免丢进度）。',
            existingDesign: loaded.ok ? loaded.index.design?.input : undefined,
            hint: '确认要重建就传 force=true；只想改绑定可先删除 DEVPLAN/ 或改用 design_ledger_update。',
          }
        }

        const designInput = resolve(root, args.design_path)
        if (!existsSync(designInput)) {
          return { error: 'design_path 不存在: ' + designInput }
        }

        const scan = await scanDesignDocs({ rootPath: designInput })
        const designRoot = (await stat(designInput)).isDirectory() ? designInput : resolve(designInput, '..')
        const built = buildLedgerFromScan({
          scan,
          workspaceRoot: root,
          designRoot,
          designInput,
          ledgerDir: ledgerDirName,
          expandTableRows: config.expandTableRows,
        })
        await ledger.save(built.index, built.systems)
        if (args.task_prompt) {
          await ledger.saveState({ taskPrompt: String(args.task_prompt), taskPromptAt: new Date().toISOString() })
        }

        // 生成后立刻刷新注入缓存（后台重算，不阻塞工具返回）
        invalidateInjection()
        const skeleton = toSkeleton(scan.entry, { maxDepth: 3, maxChildren: 12 })
        const systemList = built.index.systems.map((s) => ({ id: s.id, name: s.name, docTokens: s.docTokens }))
        // 与 AGENTS.md 联动：写入可幂等更新的托管块（块外内容原样保留）
        const agentsFile = await syncAgentsFile({
          workspaceRoot: root,
          designInput,
          ledgerDir: ledgerDirName,
          systemList,
          totals: scan.totals,
        }).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }))
        return {
          ok: true,
          workspaceRoot: root,
          ledgerDir: ledger.root,
          design: { input: designInput, ...scan.totals, truncated: scan.truncated },
          systemsCreated: built.index.systems.length,
          systemList,
          agentsFile,
          designSkeleton: skeleton,
          tokenWarning:
            scan.totals.tokens > 40000
              ? '设计文档总量 ≈ ' + Math.round(scan.totals.tokens / 1000) + 'k tokens，**不会**被整体注入；注入的是索引与聚焦子树，细节请用 design_doc_read 按需读。'
              : undefined,
          nextSteps: [
            '1) 让代理按台账推进开发（台账已建，注入会自动生效）',
            '2) 开始做某个节点时用 design_ledger_update 传 mark=true 设为聚焦',
            '3) 完成功能后更新 status / codeRefs / interfaces',
          ],
        }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'design_ledger_read',
      description:
        '按需读取进度台账（不注入、显式调用）。scope=index 读索引；scope=system 读某系统完整子树（需 system_id）；scope=node 读某节点详情（需 node_id）；scope=bugs 列出所有未修复/已修复 bug；scope=tree 输出系统→子系统→功能的骨架。',
      properties: {
        scope: {
          type: 'string',
          description: 'index | system | node | bugs | tree（默认 index）',
        },
        system_id: { type: 'string', description: 'scope=system 时的系统 id（取自索引）' },
        node_id: { type: 'string', description: 'scope=node 时的节点 id' },
        include_done: { type: 'boolean', description: 'scope=bugs 时是否包含已修复的（默认 false）' },
      },
      async execute(args, exec) {
        const ctxL = ledgerFor(exec)
        if (ctxL.error) return { error: ctxL.error }
        const { ledger } = ctxL
        const loaded = await loadLedger(ledger)
        if (!loaded.ok) return { error: '台账不可用: ' + loaded.reason, hint: '先调用 design_ledger_init' }
        const { index, bySystem, allNodes } = loaded
        const scope = args.scope || 'index'

        if (scope === 'index') {
          const r = renderIndex(index, bySystem, allNodes, Number.MAX_SAFE_INTEGER)
          return { scope, systems: index.systems, indexText: r.text, design: index.design, injection: index.injection }
        }

        if (scope === 'tree') {
          const out = []
          for (const s of index.systems ?? []) {
            const nodes = bySystem.get(s.id)
            if (!nodes) continue
            const sysNode = [...nodes.values()].find((n) => n.id === s.id)
            if (!sysNode) continue
            const lines = []
            function visit(n, depth) {
              lines.push('  '.repeat(depth) + renderNodeSafe(n, nodes))
              for (const cid of n.children ?? []) {
                const c = nodes.get(cid)
                if (c) visit(c, depth + 1)
              }
            }
            visit(sysNode, 0)
            out.push(lines.join('\n'))
          }
          return { scope, tree: out.join('\n\n') }
        }

        if (scope === 'system') {
          if (!args.system_id) return { error: 'scope=system 需要 system_id' }
          const nodes = bySystem.get(args.system_id)
          if (!nodes) return { error: '未找到系统: ' + args.system_id, available: index.systems.map((s) => s.id) }
          const sysNode = [...nodes.values()].find((n) => n.id === args.system_id)
          return {
            scope,
            systemId: args.system_id,
            name: sysNode ? sysNode.name : args.system_id,
            stats: sysNode ? countSubtree(sysNode, nodes) : undefined,
            nodes: [...nodes.values()],
          }
        }

        if (scope === 'node') {
          if (!args.node_id) return { error: 'scope=node 需要 node_id' }
          const n = allNodes.get(args.node_id)
          if (!n) return { error: '未找到节点: ' + args.node_id }
          const children = (n.children ?? []).map((id) => allNodes.get(id)).filter(Boolean)
          return { scope, node: n, children: children.map((c) => ({ id: c.id, name: c.name, status: c.status, kind: c.kind })) }
        }

        if (scope === 'bugs') {
          const want = args.include_done === true
          const out = []
          for (const n of allNodes.values()) {
            for (const b of n.bugs ?? []) {
              if (!want && (b.status === 'fixed' || b.status === 'wontfix')) continue
              out.push({ nodeId: n.id, nodeName: n.name, ...b })
            }
          }
          return { scope, count: out.length, bugs: out }
        }

        return { error: '未知 scope: ' + scope }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'design_ledger_update',
      description:
        '更新进度台账的节点：状态、聚焦标记、代码索引（只记文件+符号名，不记行号）、接口、bug、备注。' +
        '【何时建节点】台账记的是**实际开发**的功能，不是设计文档的清单：动手做（或马上要做）的功能才建节点；' +
        '设计文档里有、但这一轮不做的，先不要建空节点占位，等真要做时再用 parent_id + node_name 新建。' +
        '【必须更新】开工时 mark:true + status:doing；完成后 status:done 并补 code_refs / interfaces，否则台账会与实际脱节。' +
        '【新建】node_id 不存在时，传 parent_id + node_name 会建一个 task 型子节点。',
      properties: {
        node_id: { type: 'string', description: '要更新的节点 id（台账内已存在）' },
        parent_id: { type: 'string', description: '新建节点时挂到哪个父节点下（系统/子系统/功能节点的 id）' },
        node_name: { type: 'string', description: '新建节点时的名称（优先用设计文档里的叫法）' },
        status: { type: 'string', description: 'todo | doing | done | blocked | dropped' },
        mark: { type: 'boolean', description: 'true = 设为当前聚焦节点；false = 取消聚焦' },
        code_refs: {
          type: 'array',
          description: '代码索引数组：[{ file, symbol, note? }]（file 相对工作区；symbol 为函数/类名）',
        },
        add_code_refs: { type: 'array', description: '追加而非覆盖代码索引，元素同上' },
        interfaces: { type: 'array', description: '接口/契约描述数组（覆盖）' },
        add_interfaces: { type: 'array', description: '追加接口描述' },
        notes: { type: 'string', description: '备注（覆盖）' },
        append_note: { type: 'string', description: '追加一行备注' },
        bugs: { type: 'array', description: '覆盖式写入 bug 数组（不推荐）' },
        add_bug: {
          type: 'object',
          additionalProperties: true,
          description: '追加一个 bug：{ summary, status?, severity?, code_ref?, repro? }',
        },
        update_bug: {
          type: 'object',
          additionalProperties: true,
          description: '更新已有 bug：{ id, status?, summary?, code_ref? }',
        },
      },
      async execute(args, exec) {
        const ctxL = ledgerFor(exec)
        if (ctxL.error) return { error: ctxL.error }
        const { root, ledger } = ctxL
        const loaded = await loadLedger(ledger)
        if (!loaded.ok) return { error: '台账不可用: ' + loaded.reason, hint: '先调用 design_ledger_init' }
        const { index, bySystem, allNodes } = loaded

        /** 找到某节点所属的系统分片。 */
        function systemOf(nodeId) {
          for (const [sid, nodes] of bySystem) {
            if (nodes.has(nodeId)) return { sid, nodes }
          }
          return null
        }

        let targetId = args.node_id
        let acted = []

        // 新建子节点
        if (!targetId && args.node_name && args.parent_id) {
          const loc = systemOf(args.parent_id)
          if (!loc) return { error: '父节点不在台账中: ' + args.parent_id }
          const parent = loc.nodes.get(args.parent_id)
          const id = parent.id + '/' + String(args.node_name).replace(/\//g, '_')
          if (loc.nodes.has(id)) {
            targetId = id
          } else {
            loc.nodes.set(id, {
              id,
              name: String(args.node_name),
              kind: 'task',
              status: 'todo',
              parentId: parent.id,
              children: [],
              designRefs: [],
              codeRefs: [],
              interfaces: [],
              bugs: [],
              notes: '',
              docTokens: 0,
              updatedAt: new Date().toISOString(),
            })
            parent.children.push(id)
            acted.push('created ' + id)
            targetId = id
          }
        }

        if (!targetId) return { error: '需要 node_id，或用 parent_id + node_name 新建' }
        const loc = systemOf(targetId)
        if (!loc) return { error: '节点不在台账中: ' + targetId }
        const node = loc.nodes.get(targetId)

        // 状态
        if (typeof args.status === 'string') {
          if (!STATUSES.includes(args.status)) {
            return { error: 'status 必须是 ' + STATUSES.join(' | ') }
          }
          node.status = args.status
          acted.push('status=' + args.status)
        }

        // 聚焦标记。
        //
        // 语义：**只有一个聚焦节点**，且该字段只在 `true` 时存在。
        // 置 false / 取消聚焦都是**删字段**，而不是写 `"marked": false` ——
        // 否则每个节点都会多出一行死字段（本机台账里积累过 19 处），文件噪声大、git diff 也脏。
        // 这里的清理是**无条件**的：即使本次没传 mark，也会顺手抹掉历史残留。
        for (const n of allNodes.values()) if (n.marked !== true) delete n.marked
        if (typeof args.mark === 'boolean') {
          if (args.mark) {
            node.marked = true
            acted.push('marked')
          } else {
            acted.push('unmarked')
          }
        }

        // 代码索引
        if (Array.isArray(args.code_refs)) {
          node.codeRefs = args.code_refs.map(normalizeCodeRef)
          acted.push('codeRefs=' + node.codeRefs.length)
        }
        if (Array.isArray(args.add_code_refs)) {
          for (const r of args.add_code_refs) {
            const nr = normalizeCodeRef(r)
            if (!node.codeRefs.some((x) => x.file === nr.file && x.symbol === nr.symbol)) node.codeRefs.push(nr)
          }
          acted.push('codeRefs+=' + args.add_code_refs.length)
        }

        // 接口
        if (Array.isArray(args.interfaces)) {
          node.interfaces = args.interfaces.map(String)
          acted.push('interfaces=' + node.interfaces.length)
        }
        if (Array.isArray(args.add_interfaces)) {
          for (const s of args.add_interfaces) if (!node.interfaces.includes(String(s))) node.interfaces.push(String(s))
          acted.push('interfaces+=' + args.add_interfaces.length)
        }

        // 备注
        if (typeof args.notes === 'string') {
          node.notes = args.notes
          acted.push('notes')
        }
        if (typeof args.append_note === 'string' && args.append_note.trim()) {
          const stamp = new Date().toISOString().slice(0, 10)
          node.notes = (node.notes ? node.notes + '\n' : '') + '- ' + stamp + ' ' + args.append_note.trim()
          acted.push('note appended')
        }

        // bug
        if (Array.isArray(args.bugs)) {
          node.bugs = args.bugs.map((b, i) => normalizeBug(b, node.id, i))
          acted.push('bugs=' + node.bugs.length)
        }
        if (args.add_bug && typeof args.add_bug === 'object') {
          const b = normalizeBug(args.add_bug, node.id, node.bugs.length)
          node.bugs.push(b)
          acted.push('bug added ' + b.id)
        }
        if (args.update_bug && typeof args.update_bug === 'object' && args.update_bug.id) {
          const b = node.bugs.find((x) => x.id === args.update_bug.id)
          if (!b) return { error: '未找到 bug: ' + args.update_bug.id, available: node.bugs.map((x) => x.id) }
          if (args.update_bug.status) {
            if (!BUG_STATUSES.includes(args.update_bug.status)) {
              return { error: 'bug status 必须是 ' + BUG_STATUSES.join(' | ') }
            }
            b.status = args.update_bug.status
          }
          if (args.update_bug.summary) b.summary = String(args.update_bug.summary)
          if (args.update_bug.code_ref) b.codeRef = normalizeCodeRef(args.update_bug.code_ref)
          b.updatedAt = new Date().toISOString()
          acted.push('bug updated ' + b.id)
        }

        if (acted.length === 0) {
          return { error: '没有可应用的更新（请传 status / mark / code_refs / interfaces / bugs / notes 之一）' }
        }

        node.updatedAt = new Date().toISOString()
        await ledger.save(index, bySystem)
        invalidateInjection()
        const sysNode = [...loc.nodes.values()].find((n) => n.id === loc.sid)
        return {
          ok: true,
          nodeId: node.id,
          name: node.name,
          acted,
          rollup: rollupStatus(node, loc.nodes),
          systemProgress: sysNode ? countSubtree(sysNode, loc.nodes) : undefined,
        }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'design_doc_list',
      description:
        '列出已绑定的设计文档树与各文件体量（字符/token 估算），便于判断该按需读取哪一部分。体量大时不要整体读取。',
      properties: {},
      async execute(args, exec) {
        const ctxL = ledgerFor(exec)
        if (ctxL.error) return { error: ctxL.error }
        const { ledger } = ctxL
        const loaded = await loadLedger(ledger)
        if (!loaded.ok) return { error: '台账不可用，先 design_ledger_init' }
        const input = loaded.index.design?.input
        if (!input) return { error: '台账未记录设计文档路径' }
        const scan = await scanDesignDocs({ rootPath: input })
        return {
          designInput: input,
          totals: scan.totals,
          truncated: scan.truncated,
          files: scan.files.map((f) => ({ rel: f.rel, bytes: f.bytes, tokens: f.tokens, headings: f.headings.slice(0, 5) })),
          skeleton: toSkeleton(scan.entry, { maxDepth: 3, maxChildren: 12 }),
        }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'design_doc_read',
      description:
        '按需读取设计文档原文。rel 指定相对设计文档根的层级（如 03_systems/S02_base_building）或具体 .md 文件（如 01_top_design/design.md）；include_descendants=true 时连其子层级一并读取。max_chars 限制返回体量（默认 40000）。台账本身不注入设计文档原文，需要时用本工具读。',
      properties: {
        rel: { type: 'string', description: '相对设计文档根的路径（目录或 .md 文件）' },
        include_descendants: { type: 'boolean', description: '是否包含子层级的文档（默认 false）' },
        max_chars: { type: 'number', description: '返回字符上限（默认 40000）' },
      },
      async execute(args, exec) {
        const ctxL = ledgerFor(exec)
        if (ctxL.error) return { error: ctxL.error }
        const { ledger } = ctxL
        const loaded = await loadLedger(ledger)
        if (!loaded.ok) return { error: '台账不可用，先 design_ledger_init' }
        const input = loaded.index.design?.input
        if (!input) return { error: '台账未记录设计文档路径' }
        if (!args.rel) return { error: '需要 rel（目录或 .md，相对设计文档根）' }

        const { findNodeByRel } = await import('./design-doc.js')
        const scan = await scanDesignDocs({ rootPath: input })
        const isDirInput = (await stat(input)).isDirectory()
        // 单文件输入时 findNodeByRel 的 rel 是文件名
        const target = findNodeByRel(scan.entry, args.rel)
        if (!target) {
          return {
            error: '未找到: ' + args.rel,
            available: scan.files.map((f) => f.rel),
          }
        }
        const maxChars = Number.isInteger(args.max_chars) ? args.max_chars : 40000
        if (target.kind === 'doc' && target.doc) {
          const node = { kind: 'doc', doc: target.doc, children: [] }
          const r = await readDocContent(node, { maxChars })
          return { rel: args.rel, sources: r.sources, chars: r.text.length, truncated: r.truncated, text: r.text }
        }
        // 目录：默认只读该层级直属文档；include_descendants 时递归
        const node = args.include_descendants === true ? target : { ...target, children: (target.children ?? []).filter((c) => c.kind === 'doc') }
        const r = await readDocContent(node, { maxChars })
        return {
          rel: args.rel,
          includeDescendants: args.include_descendants === true,
          sources: r.sources,
          chars: r.text.length,
          truncated: r.truncated,
          text: r.text,
          ...(isDirInput ? {} : {}),
        }
      },
    }),
  )

  // 注册全部工具。
  // 逐个 try/catch：单个工具定义不合法（例如参数 schema 不受支持）时，
  // 只跳过那一个并告警，**不要让整个 fiber 失败**——fiber 失败会让宿主启动报错。
  diag(
    'tools: built=' + tools.length +
      ' ctx.tools=' + (ctx.tools ? 'obj' : 'MISSING') +
      ' register=' + (ctx.tools ? typeof ctx.tools.register : 'n/a'),
  )
  let registeredCount = 0
  for (const t of tools) {
    try {
      ctx.tools.register(t)
      registeredCount += 1
    } catch (e) {
      ctx.logger?.warn?.('[design-ledger] tool registration failed: ' + (t && t.name) + ' — ' + String((e && e.message) || e))
    }
  }
  diag('tools: registered=' + registeredCount + '/' + tools.length)

  // ─────────── 客户端面板用的 JSON 路由 ───────────
  // 浏览器半区（侧栏「设计文档包含」面板）通过 fetch 读这些路由：显示状态、浏览工作区、
  // 完成绑定。避免走 typert RPC 那套较重的协议链路（与 dsh-whale-widget 同法）。
  //
  // 安全边界：**所有路径都必须落在工作区内** —— 枚举与绑定都先做 isInside 校验，
  // 绝对路径与 .. 穿越一律拒绝。面板读不到工作区外的任何东西。
  // ── 面板路由：注册方式必须与"能跑通的插件"一致 ──
  //
  // 唯一可靠的接缝是 **服务注入作用域**：
  //   ctx.inject(['webServer'], (sctx) => sctx.webServer.register({ kind, path, handler }))
  // cordis 会等 webServer 就绪后才调用回调，并把**该作用域**上的 `sctx.webServer`
  // 交给你；插件 apply 本身跑得比 webServer 服务就绪更早，所以在 apply 里
  // 直接读 `ctx.webServer`（未 inject）或 `ctx.get('webServer')` 都拿不到它 ——
  // 路由没注册，面板 fetch 得到 404 空体，浏览器就报
  //   Failed to execute 'json' on 'Response': Unexpected end of JSON input
  // 这正是「打开设计文档包含 → 读取失败」的原因。
  //
  // 下面 buildPanelRoutes 只负责"怎么注册"，由注入路径调用；另外保留一个
  // 延迟重试兜底（覆盖注入路径因为别的原因没跑起来的极端情况），
  // 两条路径共享 routesRegistered 标志，绝不重复注册（WebRoute 重复 (kind,path) 会抛）。
  /** 路由 disposer 收集（WebRoute 契约：register 返回 disposer）。 */
  const routeDisposers = []
  /** 延迟重试定时器句柄（成功后清掉）。 */
  let routeTimer = null
  /** 路由是否已注册（成功一次即不再重试）。 */
  let routesRegistered = false

  /**
   * 注册三条面板路由。返回是否成功。
   * 调用方负责把可用的 WebServer 实例传进来（注入作用域最可靠）。
   */
  function registerPanelRoutes(webServer) {
    if (routesRegistered) return true
    if (!webServer || typeof webServer.register !== 'function') return false

    /** 注册阶段标志：便于区分"注册抛错"与"后续逻辑抛错"。 */
    let registering = true
    try {
      const readBody = async (req) => {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw) return {}
        try {
          return JSON.parse(raw)
        } catch {
          return {}
        }
      }
      const sendJson = (res, code, value) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      }
      /** 已成功 register 的路由（仅用于日志自证，不塞进 WebRoute）。 */
      const registered = []
      /**
       * 注册一条路由并登记结果。
       * WebRoute 的**严格契约**是 { kind: 'exact' | 'prefix', path, handler }——
       * 不要附加额外字段，也不要用 method（缺 kind 会被 register 抛错）。
       */
      const addRoute = (route) => {
        const disposer = webServer.register(route)
        // 契约：register 返回 disposer。收集起来，便于需要时按序注销。
        if (typeof disposer === 'function') routeDisposers.push(disposer)
        registered.push({ kind: route.kind, path: route.path })
        return disposer
      }
      /** 首次由客户端确认过的工作区（仅在 policy 无根时作为兜底，见下）。 */
      let confirmedWs = null
      /**
       * 解析请求指定的工作区。
       *
       * ⚠️ 这里有三个必须同时成立的性质：
       *
       * 1. **缺省不能落到部署默认根**：`workspaceRoot(undefined)` 在"会话未知"时给的是
       *    sandboxPolicy 的部署默认根（本机实测是 profile 目录），**不是用户的工作区**。
       *    面板列那个目录 → "选择设计文档"里一个文件夹都看不见。
       *    （会话已知时 `workspaceRoot()` 会返回**会话工作区**，那是正确的缺省。）
       * 2. **部署根一律不认**：无论来自缺省还是客户端，profile 目录都不能当工作区 ——
       *    否则面板会把它当成"工作区根"锁死，用户再也切不出去（本机踩过）。
       * 3. **不能被客户端任意改根**：只认第一个被确认的工作区（存在且是目录），
       *    之后必须一致，否则 400。这样面板能工作，又不会变成"枚举任意目录"的入口。
       */
      const confirmWorkspace = (raw) => {
        const norm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '')
        let abs = null
        try {
          abs = resolve(String(raw))
        } catch {
          return null
        }
        if (isDeploymentRoot(abs)) return null
        if (!existsSync(abs) || !statSync(abs).isDirectory()) return null
        if (confirmedWs === null) {
          confirmedWs = abs
          diag('resolveWs: 确认工作区 ' + abs + '（缺省解析 = ' + String(workspaceRoot(undefined)) + '）')
          return abs
        }
        return norm(confirmedWs).toLowerCase() === norm(abs).toLowerCase() ? confirmedWs : null
      }
      const resolveWs = (raw) => {
        if (confirmedWs !== null) {
          if (!raw || typeof raw !== 'string') return confirmedWs
          const abs = confirmWorkspace(raw)
          return abs || null
        }
        if (raw && typeof raw === 'string') {
          const asked = confirmWorkspace(raw)
          return asked || null
        }
        const resolved = workspaceRoot(undefined)
        // 部署根绝不作为工作区交给面板：宁可显示"工作区未知"，也不能让它锁在 profile 里
        if (resolved && isDeploymentRoot(resolved)) return null
        return resolved
      }
      /** 把相对路径安全解析到工作区内；越界返回 null。 */
      const safeJoin = (wsRoot, rel) => {
        if (rel && (rel.includes('..') || /^[a-zA-Z]:/.test(String(rel)) || String(rel).startsWith('/'))) return null
        const target = rel ? resolve(wsRoot, String(rel)) : resolve(wsRoot)
        return isInside(wsRoot, target) ? target : null
      }

      addRoute({
            kind: 'exact',
            path: '/design-ledger/status.json',
            handler: async (req, res) => {
              try {
                sendJson(res, 200, await buildStatusPayload(req))
              } catch (e) {
                sendJson(res, 500, { error: String((e && e.message) || e) })
              }
            },
      })

      // 工作区浏览：列出目录下的子目录与 .md 文件（供面板挑选设计文档）
      addRoute({
            kind: 'exact',
            path: '/design-ledger/list.json',
            handler: async (req, res) => {
              try {
                const url = new URL(req.url, 'http://localhost')
                const wsRoot = resolveWs(url.searchParams.get('workspace'))
                if (!wsRoot) return sendJson(res, 400, { error: 'no-workspace' })
                const rel = url.searchParams.get('rel') || ''
                const dir = safeJoin(wsRoot, rel)
                if (!dir) return sendJson(res, 403, { error: 'path-outside-workspace', rel })
                let entries
                try {
                  entries = await readdir(dir, { withFileTypes: true })
                } catch (e) {
                  return sendJson(res, 404, { error: 'unreadable', rel, detail: String((e && e.message) || e) })
                }
                const dirs = []
                const files = []
                for (const e of entries) {
                  if (e.name.startsWith('.') || e.name === 'node_modules') continue
                  const childRel = rel ? rel + '/' + e.name : e.name
                  if (e.isDirectory()) {
                    let mdCount = 0
                    try {
                      const stack = [join(dir, e.name)]
                      while (stack.length > 0 && mdCount < 5000) {
                        const cur = stack.pop()
                        for (const c of await readdir(cur, { withFileTypes: true })) {
                          if (c.name.startsWith('.') || c.name === 'node_modules') continue
                          if (c.isDirectory()) stack.push(join(cur, c.name))
                          else if (extname(c.name).toLowerCase() === '.md') mdCount += 1
                        }
                      }
                    } catch {
                      /* ignore */
                    }
                    dirs.push({ name: e.name, rel: childRel, type: 'dir', mdCount })
                  } else if (extname(e.name).toLowerCase() === '.md') {
                    let bytes = 0
                    try {
                      bytes = (await stat(join(dir, e.name))).size
                    } catch {
                      /* ignore */
                    }
                    files.push({ name: e.name, rel: childRel, type: 'file', bytes })
                  }
                }
                dirs.sort((a, b) => b.mdCount - a.mdCount || a.name.localeCompare(b.name, 'zh'))
                files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
                sendJson(res, 200, {
                  workspaceRoot: wsRoot,
                  rel,
                  parentRel: rel === '' ? null : rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
                  dirs,
                  files,
                })
              } catch (e) {
                sendJson(res, 500, { error: String((e && e.message) || e) })
              }
            },
      })

      // 绑定：面板里"选定设计文档 → 建台账"
      addRoute({
            kind: 'exact',
            path: '/design-ledger/bind.json',
            handler: async (req, res) => {
              try {
                // 同时接受 JSON 请求体与 query 参数：宿主链路上若有请求体解析中间件
                // 先把流消费掉，query 仍能工作（避免"整个 bind 失效"这类脆弱点）。
                let qs = null
                try {
                  qs = new URL(req.url, 'http://localhost').searchParams
                } catch {
                  qs = null
                }
                const body = await readBody(req)
                const pick = (k) => {
                  if (body && body[k] !== undefined && body[k] !== null && body[k] !== '') return body[k]
                  return qs ? qs.get(k) : null
                }
                const wsRoot = resolveWs(pick('workspace'))
                if (!wsRoot) return sendJson(res, 400, { error: 'no-workspace' })
                const rel = pick('rel')
                const target = safeJoin(wsRoot, rel)
                if (!target) return sendJson(res, 403, { error: 'path-outside-workspace', rel })
                if (!existsSync(target)) return sendJson(res, 404, { error: 'not-found', rel })
                const force = String(pick('force')) === 'true'
                const taskPrompt = pick('taskPrompt')

                const ledger = new Ledger(wsRoot, ledgerDirName)
                if ((await ledger.exists()) && force !== true) {
                  return sendJson(res, 409, {
                    error: 'ledger-exists',
                    hint: '已有台账。要重建请在对话里让代理执行 design_ledger_init 并传 force=true。',
                    workspaceRoot: wsRoot,
                    ledgerDir: ledger.root,
                  })
                }
                const scan = await scanDesignDocs({ rootPath: target })
                const st = await stat(target)
                const designRoot = st.isDirectory() ? target : resolve(target, '..')
                const built = buildLedgerFromScan({
                  scan,
                  workspaceRoot: wsRoot,
                  designRoot,
                  designInput: target,
                  ledgerDir: ledgerDirName,
                  expandTableRows: config.expandTableRows,
                })
                await ledger.save(built.index, built.systems)
                if (typeof taskPrompt === 'string' && taskPrompt.trim()) {
                  await ledger.saveState({ taskPrompt, taskPromptAt: new Date().toISOString() })
                }
                invalidateInjection()
                const systemList = built.index.systems.map((s) => ({ id: s.id, name: s.name, docTokens: s.docTokens }))
                let agents = null
                if (String(pick('syncAgents')) !== 'false') {
                  agents = await syncAgentsFile({
                    workspaceRoot: wsRoot,
                    designInput: target,
                    ledgerDir: ledgerDirName,
                    systemList,
                    totals: scan.totals,
                  }).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }))
                }
                sendJson(res, 200, {
                  ok: true,
                  workspaceRoot: wsRoot,
                  ledgerDir: ledger.root,
                  design: { input: target, ...scan.totals },
                  systemsCreated: built.index.systems.length,
                  systemList,
                  agentsFile: agents,
                })
              } catch (e) {
                sendJson(res, 500, { error: String((e && e.message) || e) })
              }
            },
      })
      registering = false
      routesRegistered = true
      if (routeTimer) {
        clearInterval(routeTimer)
        routeTimer = null
      }
      diag('routes registered=' + registered.length + ' ' + registered.map((r) => r.kind + ' ' + r.path).join(' | '))
      ctxLoggerWarn(
        '[design-ledger] panel routes registered: ' + registered.length +
          ' (' + registered.map((r) => r.kind + ' ' + r.path).join(', ') + ')',
      )
      return true
    } catch (e) {
      diag((registering ? 'ROUTE REGISTRATION FAILED: ' : 'post-registration setup failed: ') + String((e && e.stack) || e))
      ctxLoggerWarn(
        '[design-ledger] ' +
          (registering ? 'ROUTE REGISTRATION FAILED' : 'post-registration setup failed') +
          ': ' + String((e && e.stack) || e),
      )
      // 注册抛错多为契约问题，重试无益；标记为已注册以免刷屏
      routesRegistered = true
      if (routeTimer) {
        clearInterval(routeTimer)
        routeTimer = null
      }
      return false
    }
  }

  // ── 路由注册：注入作用域（主）＋ 状态化重试（兜底） ──
  //
  // 事实（插件自己的 diag.log 实测）：
  //   webServer resolved=true ws.register=undefined ctx.webServer=undefined
  // 即 `ctx.get('webServer')` **能**拿到对象，但在服务真正 init 完成前，那个对象上
  // 没有 `register`（apply 跑在 listen 之前）。反之，`ctx.inject(['webServer'], cb)`
  // 的回调由 cordis 在依赖 fiber 进入 active 之后才调用，那个实例一定是可用的。
  // 所以主路径走注入，重试路径只认"有 register 函数的实例"，两条路径共享
  // routesRegistered，先到先注册（WebRoute 重复 (kind,path) 会抛，绝不能注册两次）。
  /** 从任意来源取一个"真正可用"的 WebServer（必须有 register 函数）。 */
  const usableWebServer = (cand) => {
    try {
      if (cand && typeof cand.register === 'function') return cand
    } catch {
      /* ignore */
    }
    return null
  }

  /** 尝试注册；成功返回 true。 */
  const tryRegister = (cand) => {
    const webServer = usableWebServer(cand)
    if (!webServer) return false
    try {
      return registerPanelRoutes(webServer)
    } catch (e) {
      diag('registerPanelRoutes threw: ' + String((e && e.stack) || e))
      return false
    }
  }

  /** 延迟重试兜底：只在尚未注册成功时跑。 */
  const startRouteRetry = () => {
    if (routesRegistered || routeTimer) return
    let tries = 0
    const MAX_TRIES = 80 // 80 × 250ms = 20s
    routeTimer = setInterval(() => {
      tries += 1
      if (routesRegistered) {
        clearInterval(routeTimer)
        routeTimer = null
        return
      }
      let ws = null
      try {
        // strict=false：即使服务还没 active 也先拿到对象，再看它有没有 register
        ws = typeof ctx.get === 'function' ? ctx.get('webServer', false) : null
      } catch {
        ws = null
      }
      if (ws && tryRegister(ws)) {
        diag('routes registered via retry #' + tries + ' (' + tries * 250 + 'ms)')
        return
      }
      if (tries >= MAX_TRIES) {
        clearInterval(routeTimer)
        routeTimer = null
        diag(
          'webServer never became usable within ' + MAX_TRIES * 250 + 'ms; panel routes unavailable' +
            ' — 末次探测: got=' + (ws ? typeof ws : 'null') + ' register=' + (ws ? typeof ws.register : 'n/a'),
        )
        ctxLoggerWarn('[design-ledger] webServer never became usable; panel routes unavailable')
      }
    }, 250)
    if (routeTimer && typeof routeTimer.unref === 'function') routeTimer.unref()
  }

  try {
    ctx.inject(['webServer'], (sctx) => {
      const cand = sctx && sctx.webServer
      diag('inject([webServer]) fired: got=' + (cand ? typeof cand : 'undefined') + ' register=' + (cand ? typeof cand.register : 'n/a'))
      if (tryRegister(cand)) return
      diag('inject([webServer]) fired but instance not usable yet; falling back to retry')
      startRouteRetry()
    })
  } catch (e) {
    diag('ctx.inject([webServer]) threw: ' + String((e && e.stack) || e))
  }
  // 无论注入回调是否已经跑过，都准备一条重试兜底：
  if (!routesRegistered) startRouteRetry()

  /** 组装面板需要的状态（同时供工具与路由复用）。 */
  async function buildStatusPayload(req) {
    // 路由没有 session 上下文，因此按工作区候选逐一定位：
    // 优先取请求头/查询里带的工作区，其次回退到 sandboxPolicy 的默认解析。
    let wsRoot = null
    try {
      const url = req && req.url ? String(req.url) : ''
      const q = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : null
      const asked = q ? q.get('workspace') : null
      if (asked) wsRoot = asked
    } catch {
      /* ignore */
    }
    if (!wsRoot) wsRoot = workspaceRoot(undefined)
    const candidates = wsRoot ? await listDesignCandidates(wsRoot) : []
    if (!wsRoot) return { bound: false, reason: 'no-workspace', designCandidates: [] }

    const ledger = new Ledger(wsRoot, ledgerDirName)
    const loaded = await ledger.load()
    if (!loaded.ok) {
      return {
        bound: false,
        reason: loaded.reason,
        workspaceRoot: wsRoot,
        ledgerDir: ledger.root,
        designCandidates: candidates.slice(0, 30),
      }
    }
    const { index, bySystem, allNodes, state } = loaded
    const systems = []
    let total = 0
    let done = 0
    let openBugs = 0
    for (const s of index.systems ?? []) {
      const nodes = bySystem.get(s.id)
      const sysNode = nodes ? nodes.get(s.id) : undefined
      if (sysNode && nodes) {
        const st = countSubtree(sysNode, nodes)
        total += st.total
        done += st.done
        const sb = (sysNode.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing').length
        openBugs += sb
        systems.push({
          id: s.id,
          name: sysNode.name,
          done: st.done,
          total: st.total,
          doing: st.doing,
          todo: st.todo,
          blocked: st.blocked,
          openBugs: sb,
          docTokens: s.docTokens ?? 0,
          marked: sysNode.marked === true,
        })
      }
    }
    for (const n of allNodes.values()) {
      openBugs += (n.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing').length
    }
    return {
      bound: true,
      workspaceRoot: wsRoot,
      ledgerDir: ledger.root,
      design: index.design ?? null,
      sections: index.sections ?? [],
      systems,
      totals: { nodes: total, done, openBugs },
      markedNodes: [...allNodes.values()].filter((n) => n.marked === true).map((n) => ({ id: n.id, name: n.name })),
      hasTaskPrompt: typeof state?.taskPrompt === 'string' && state.taskPrompt.trim().length > 0,
      generation: index.updatedAt ?? null,
    }
  }

  // ─────────────────── 注入：system-prompt/assemble ───────────────────

  // ⚠️ 硬约束（这次就是踩在它上面）：`PromptSection.text` 的契约是
  //   `string | ((context) => string)`
  // 宿主在**每一轮**装配时都会对每个已注册段落做：
  //   const t = typeof section.text === 'function' ? section.text(context) : section.text
  //   renderPrompt(assembly) → 对每段 t 调 `interpolate()` → 第一行就是 `t.indexOf('{{')`
  // （见 @deepseek-ai/dsh-system-prompt 的 renderPrompt/interpolate）
  // 只要有一次返回非字符串（Promise / undefined / object），就抛
  //   TypeError: text.indexOf is not a function
  // 而这是**回合开始处**的调用，于是「一按发送键就本轮运行失败 UNKNOWN」，
  // 整个对话直接瘫痪 —— 比面板 404 严重得多。
  //
  // 因此本段的纪律是：
  //   1. text() 体内**不读盘、不 await、不返回 Promise**，只返回内存里的字符串；
  //   2. 文本一律由后台异步任务预先算好（apply 时触发一次，台账变动后再算）；
  //   3. 出口再兜一层 typeof 校验，任何异常值都只记诊断日志并退化成 ''。
  // 渲染失败最多让注入内容缺失，绝不允许影响对话本身。
  /** 当前注入文本（永远初始化为字符串）。 */
  let injectionCache = ''
  /** 缓存对应的工作区根。 */
  let injectionCacheKey = null
  /** 后台刷新任务：同一时刻只保留最新一次。 */
  let pendingRefresh = null

  /** 解析工作区根目录（不依赖 exec，注入与后台刷新共用）。 */
  const syncWorkspaceRoot = () => {
    try {
      const ws = workspaceRoot(null)
      if (ws) return ws
    } catch {
      /* ignore */
    }
    try {
      return process.cwd()
    } catch {
      return null
    }
  }

  /**
   * 判断注入文本是否需要重算：工作区变了，或台账文件比缓存新。
   * 纯 statSync（微秒级、不读文件内容），失败就当作需要重算。
   */
  const injectionCacheStale = (wsRoot) => {
    if (injectionCacheKey !== wsRoot) return true
    try {
      const ledger = new Ledger(wsRoot, ledgerDirName)
      return statSync(ledger.indexPath).mtimeMs > injectionCacheBuiltAt
    } catch {
      return false // 台账不存在：缓存里的 '' 仍然有效
    }
  }

  /** 缓存建立时间（与台账 mtime 比较，避免每次装配都读盘）。 */
  let injectionCacheBuiltAt = 0

  /**
   * 后台重算注入文本（异步读盘，失败不影响任何调用方）。
   * 返回 Promise，但**永远不 reject**；调用方一律不要 await。
   */
  const refreshInjectionCache = (wsRoot) => {
    const run = async () => {
      if (!wsRoot) return
      const ledger = new Ledger(wsRoot, ledgerDirName)
      let text = ''
      let builtAt = Date.now()
      try {
        if (await ledger.exists()) {
          const loaded = await ledger.load()
          if (loaded.ok) {
            const built = assembleInjection({
              index: loaded.index,
              bySystem: loaded.bySystem,
              allNodes: loaded.allNodes,
              state: loaded.state,
            })
            text = typeof built.text === 'string' ? built.text : String(built.text ?? '')
          }
        }
      } catch (e) {
        diag('injection refresh failed: ' + String((e && e.stack) || e))
        return
      }
      injectionCache = text
      injectionCacheKey = wsRoot
      injectionCacheBuiltAt = builtAt
    }
    const task = run().catch(() => {})
    pendingRefresh = task
    void task.then(() => {
      if (pendingRefresh === task) pendingRefresh = null
    })
    return task
  }

  /**
   * 段落文本出口：**同步**返回字符串，绝不抛、绝不返回 Promise。
   *
   * 装配路径上只做内存读取 + 一次 statSync 判断是否过期；过期则**后台**刷新，
   * 本次仍返回上一版文本（可能为空）。这样即使磁盘/台账出问题，
   * 对话也不受影响。
   */
  const injectionTextSync = () => {
    try {
      const wsRoot = syncWorkspaceRoot()
      if (!wsRoot) return ''
      if (injectionCacheStale(wsRoot)) {
        // 首次（缓存为空）时同步读一次：让"刚打开会话"就有注入内容。
        // 读盘失败/台账不存在都退化为上次缓存（''）。
        if (injectionCache === '' && !pendingRefresh) {
          try {
            const ledger = new Ledger(wsRoot, ledgerDirName)
            const index = JSON.parse(readFileSync(ledger.indexPath, 'utf8'))
            const bySystem = new Map()
            const allNodes = new Map()
            for (const sys of index.systems ?? []) {
              const nodeMap = new Map()
              try {
                const shard = JSON.parse(readFileSync(ledger.systemPath(sys.id), 'utf8'))
                for (const n of Object.values(shard.nodes ?? {})) nodeMap.set(n.id, n)
              } catch {
                /* 分片缺失则跳过该系统 */
              }
              bySystem.set(sys.id, nodeMap)
              for (const [id, n] of nodeMap) allNodes.set(id, n)
            }
            let state = {}
            try {
              state = JSON.parse(readFileSync(ledger.statePath, 'utf8'))
            } catch {
              /* state 可缺省 */
            }
            const built = assembleInjection({ index, bySystem, allNodes, state })
            if (typeof built.text === 'string') {
              injectionCache = built.text
              injectionCacheKey = wsRoot
              injectionCacheBuiltAt = Date.now()
            }
          } catch {
            // 台账不存在或读盘失败：保持缓存（''），并交给后台刷新
            void refreshInjectionCache(wsRoot)
          }
        } else {
          void refreshInjectionCache(wsRoot)
        }
      }
    } catch (e) {
      diag('injectionTextSync failed: ' + String((e && e.stack) || e))
      return ''
    }
    // 出口兜底：宿主会对返回值直接调 .indexOf()，非字符串会毁掉整个回合。
    if (typeof injectionCache !== 'string') {
      diag('INJECT-NONSTRING: injectionCache type=' + typeof injectionCache + ' — 已退化为空串以免打断对话')
      injectionCache = ''
      return ''
    }
    return injectionCache
  }

  /** 由工具/路由在台账变动后调用：立刻后台重算（同步下一次装配即可见）。 */
  const invalidateInjection = () => {
    injectionCacheKey = null
    injectionCacheBuiltAt = 0
    const wsRoot = syncWorkspaceRoot()
    if (wsRoot) void refreshInjectionCache(wsRoot)
  }

  ctx.inject(['systemPrompt'], (sp) => {
    if (config.injectEnabled === false) return
    sp.systemPrompt.section({
      name: 'design-ledger',
      /**
       * ⚠️ **同步**函数。绝不要改成 async、也绝不要在这里 await：
       * 返回 Promise 会让宿主在回合开始处抛 `text.indexOf is not a function`，
       * 使整个对话无法进行。见本节顶部说明。
       */
      text: () => {
        try {
          const text = injectionTextSync()
          // 双保险：连"非字符串"这种不可能情况也在这里拦住
          if (typeof text !== 'string') {
            diag('INJECT-NONSTRING(section): type=' + typeof text + ' — 已退化为空串')
            return ''
          }
          return text
        } catch (e) {
          diag('section.text threw: ' + String((e && e.stack) || e))
          return ''
        }
      },
      order: 60,
    })
  })

  // apply 时先主动发现一次会话工作区：这样即便插件是在会话诞生之后才加载的
  // （bundle 刚登记、热重载、宿主重启时序），面板路由也已经能拿到正确的工作区。
  try {
    const found = discoverSessionWorkspace()
    if (found) {
      rememberSessionWorkspace(found)
    } else {
      diag('apply 时未能主动发现会话工作区（尚无存活 agent）：面板会在会话开始后自动拿到它')
    }
  } catch {
    /* ignore */
  }

  // apply 时预热一次：新会话首次装配就有注入内容（不阻塞 apply）。
  try {
    const wsAtApply = syncWorkspaceRoot()
    if (wsAtApply) void refreshInjectionCache(wsAtApply)
  } catch {
    /* ignore */
  }
}

/** 规范化一条代码索引（刻意不含行号）。 */
function normalizeCodeRef(raw) {
  if (!raw || typeof raw !== 'object') return { file: String(raw ?? '') }
  const out = { file: String(raw.file ?? '') }
  if (raw.symbol) out.symbol = String(raw.symbol)
  if (raw.note) out.note = String(raw.note)
  return out
}

/** 规范化一条 bug 记录。 */
function normalizeBug(raw, nodeId, index) {
  const now = new Date().toISOString()
  const id = raw && raw.id ? String(raw.id) : nodeId + '#bug' + (index + 1)
  const out = {
    id,
    summary: String((raw && raw.summary) || '(未填写描述)'),
    status: raw && BUG_STATUSES.includes(raw.status) ? raw.status : 'open',
    createdAt: now,
    updatedAt: now,
  }
  if (raw && raw.severity) out.severity = String(raw.severity)
  if (raw && raw.repro) out.repro = String(raw.repro)
  if (raw && raw.code_ref) out.codeRef = normalizeCodeRef(raw.code_ref)
  return out
}

/** 供 design_ledger_read tree 使用：节点行渲染（避免循环导入）。 */
function renderNodeSafe(node, nodes) {
  const eff = rollupStatus(node, nodes)
  const st = countSubtree(node, nodes)
  const openBugs = (node.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing').length
  const marks = { done: '✅', doing: '🔄', blocked: '⛔', dropped: '⛔', todo: '⬜' }
  return (
    (marks[eff] ?? '⬜') +
    ' ' +
    node.name +
    (node.kind && node.kind !== 'root' ? ' (' + node.kind + ')' : '') +
    '  ' +
    st.done +
    '/' +
    st.total +
    (openBugs ? '  bug:' + openBugs : '')
  )
}
