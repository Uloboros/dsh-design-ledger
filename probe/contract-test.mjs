/**
 * 契约自检（这两个契约都真的把 DSH 弄坏过，必须自动化守住）：
 *
 *  A. `systemPrompt.section().text` 必须**同步返回字符串**。
 *     宿主每轮都对每个已注册段落的文本调 `interpolate()` → `text.indexOf('{{')`；
 *     返回 Promise / undefined / object 会抛
 *       TypeError: text.indexOf is not a function
 *     而这是回合开始处的调用 —— 结果是"一按发送键就本轮运行失败"，整个对话瘫痪。
 *
 *  B. 面板路由必须经 `ctx.inject(['webServer'], …)` 注册。
 *     apply 跑得比 webServer 就绪更早，直接读 `ctx.webServer`（未 inject）拿不到实例，
 *     路由没注册 → 面板 fetch 得到 404 空体 → 浏览器报
 *       Failed to execute 'json' on 'Response': Unexpected end of JSON input
 *
 * 运行：node --import ./probe/register.mjs probe/contract-test.mjs
 * 退出码非 0 = 契约被破坏。
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE_URL = pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href

/**
 * 清理临时工作区，**绝不让清理失败伪装成测试失败**。
 * Windows 上临时目录偶发 EPERM/ENOTEMPTY（杀软或文件句柄未释放），而 `finally` 里
 * 抛出的错误会让进程以退出码 1 结束 —— 看起来像断言失败，非常误导（本机踩过）。
 */
async function cleanup(dir) {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    console.log('  ℹ️ 临时目录清理失败（不影响结论）: ' + String((e && e.message) || e))
  }
}

/** 记录所有失败的断言。 */
const failures = []
function check(name, ok, detail) {
  if (ok) {
    console.log('  ✅ ' + name)
  } else {
    console.log('  ❌ ' + name + (detail ? ' — ' + detail : ''))
    failures.push(name)
  }
}

/**
 * 造一个假 ctx。`inject` 会**同步**调用回调（cordis 的真实语义是等依赖就绪后
 * 再调，这里同步调用来断言"回调里能不能拿到服务"这一层逻辑）。
 * @param {{ workspaceRoot: string, webServer?: any }} opts
 */
function makeCtx(opts) {
  const tools = new Map()
  const registerCalls = []
  const schemaProblems = []
  const sections = []
  const routes = []
  const injectCalls = []
  const state = { webServer: opts.webServer ?? null }

  const api = {
    tools: {
      register(def) {
        // 插件交给宿主的已经是 defineTool() 编译好的工具对象。这里只做登记与体检：
        // parameters 必须已经是 object-rooted 的 JSON Schema（宿主就用它生成工具签名）。
        registerCalls.push(def && def.name)
        if (def && def.name) tools.set(def.name, def)
        const p = def && def.parameters
        if (!p || p.type !== 'object' || typeof p.properties !== 'object') {
          schemaProblems.push((def && def.name) + ': parameters 不是 object-rooted schema: ' + JSON.stringify(p))
        }
        return () => {}
      },
    },
  }
  if (state.webServer) api.webServer = state.webServer

  const ctx = {
    config: {},
    logger: { warn() {}, info() {}, error() {} },
    // 把 tools（以及可选的 webServer）挂在 ctx 上：真实 cordis 里服务就是这样解析到
    // 属性上的；漏挂会让插件在 `ctx.tools.register` 处抛错并被它自己的兜底吞掉。
    tools: api.tools,
    ...(state.webServer ? { webServer: state.webServer } : {}),
    effect(fn) {
      try {
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      } catch {
        return () => {}
      }
    },
    get(name) {
      if (name === 'webServer') return state.webServer
      return null
    },
    inject(deps, cb) {
      injectCalls.push(Array.isArray(deps) ? deps.slice() : deps)
      const scoped = Object.assign({}, ctx, api)
      if (Array.isArray(deps) && deps.includes('webServer') && state.webServer) scoped.webServer = state.webServer
      if (Array.isArray(deps) && deps.includes('systemPrompt')) {
        scoped.systemPrompt = {
          section(s) {
            sections.push(s)
            return () => {}
          },
        }
      }
      try {
        cb(scoped)
      } catch {
        /* 由被测代码自己兜 */
      }
      return () => {}
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: opts.workspaceRoot }) },
  }

  return {
    ctx,
    tools,
    registerCalls,
    schemaProblems,
    sections,
    routes,
    injectCalls,
    /** 模拟宿主装配：对每个段落取文本并调用 .indexOf('{{')（宿主 interpolate 的第一行）。 */
    renderLikeHost() {
      const texts = []
      for (const s of sections) {
        const t = typeof s.text === 'function' ? s.text({}) : s.text
        if (typeof t !== 'string') {
          throw new TypeError('text.indexOf is not a function')
        }
        t.indexOf('{{') // 宿主真实调用
        texts.push(t)
      }
      return texts
    },
  }
}

/** 造一个最小可用台账（index + 分片 + state）。 */
async function writeLedger(root, designDir) {
  const dir = join(root, 'DEVPLAN')
  await mkdir(join(dir, 'systems'), { recursive: true })
  await writeFile(
    join(dir, 'index.json'),
    JSON.stringify({
      design: { input: designDir, fileCount: 1, chars: 10, tokens: 3 },
      systems: [{ id: 'S01_x', name: '示例系统', docTokens: 3 }],
    }),
    'utf8',
  )
  await writeFile(
    join(dir, 'systems', 'S01_x.json'),
    JSON.stringify({
      nodes: {
        'S01_x': {
          id: 'S01_x',
          name: '示例系统',
          kind: 'system',
          status: 'doing',
          parentId: null,
          children: [],
          designRefs: [],
          codeRefs: [],
          interfaces: [],
          bugs: [],
          notes: '',
        },
      },
    }),
    'utf8',
  )
  await writeFile(join(dir, 'state.json'), JSON.stringify({ taskPrompt: '契约自检' }), 'utf8')
}

const mod = await import(MODULE_URL)

// 让"被吞掉的"告警显形：本插件对工具定义失败只 console.warn 一句。
// 契约自检必须看到它，否则会误报成"工具数为 0"这种没有信息量的失败。
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '))
  originalWarn('[plugin warn]', ...args)
}

// 直接体检：官方 defineTool 是否接受本模块用的定义形态。
// 这是"6 个工具全被跳过"这类问题的第一现场（插件只 console.warn 一句就跳过了）。
const official = await import('@deepseek-ai/dsh-tools')
try {
  const def = official.defineTool({
    name: 'probe_echo',
    description: 'contract probe echo',
    parameters: { rel: { type: 'string', description: 'x', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: async () => ({ ok: true }),
  })
  console.log('defineTool 体检: OK (' + typeof def + ')')
} catch (e) {
  console.log('defineTool 体检: FAILED — ' + String((e && e.message) || e))
}

// ── 场景 1：台账存在 + webServer 可用 ──
console.log('\n=== 场景 1：台账存在，webServer 可用 ===')
const ws1 = await mkdtemp(join(tmpdir(), 'dl-contract-'))
try {
  await writeLedger(ws1, join(ws1, 'docs'))
  const env1Routes = []
  const env = makeCtx({
    workspaceRoot: ws1,
    webServer: { register: (r) => (env1Routes.push(r), () => {}) },
  })
  mod.apply(env.ctx)
  // 后台预热是异步的：给它一点时间落定（apply 时不阻塞）。
  await new Promise((r) => setTimeout(r, 200))

  // A. 工具
  check(
    '注册 6 个工具',
    env.tools.size === 6,
    '实际 ' + env.tools.size + ' | register() 调用 = ' + JSON.stringify(env.registerCalls) +
      (warnings.length ? ' | 插件告警: ' + warnings.join(' ;; ') : ''),
  )
  check('每个工具的 parameters 都是 object-rooted JSON Schema', env.schemaProblems.length === 0, env.schemaProblems.join(' | '))
  check(
    '工具名齐全',
    ['design_ledger_status', 'design_ledger_init', 'design_ledger_read', 'design_ledger_update', 'design_doc_list', 'design_doc_read'].every(
      (n) => env.tools.has(n),
    ),
    [...env.tools.keys()].join(','),
  )
  {
    // 宿主会按这份 schema 校验模型参数，也应能拒绝多余键（object 根 + required 数组）
    const upd = env.tools.get('design_ledger_update')
    const p = upd && upd.parameters
    check('design_ledger_update.parameters.type === object', !!p && p.type === 'object', JSON.stringify(p && p.type))
    check(
      'design_ledger_update 的 add_bug 是显式开放对象（additionalProperties: true）',
      !!p && !!p.properties && !!p.properties.add_bug &&
        p.properties.add_bug.type === 'object' &&
        p.properties.add_bug.additionalProperties === true,
      JSON.stringify(p && p.properties && p.properties.add_bug),
    )
    check('design_ledger_update 仍是可调用工具（有 execute）', typeof (upd && upd.execute) === 'function')
  }
  // A. 段落契约
  const section = env.sections.find((s) => s.name === 'design-ledger')
  check('注册了 design-ledger 段落', !!section)
  if (section) {
    const raw = section.text({})
    check('section.text() 返回值是 string', typeof raw === 'string', '实际 ' + typeof raw)
    check('section.text() 不是 Promise/thenable', !(raw && typeof raw.then === 'function'))
    check('宿主式 interpolate 不抛错', (() => {
      try {
        env.renderLikeHost()
        return true
      } catch (e) {
        return false
      }
    })(), '宿主会抛 text.indexOf is not a function')
    check('注入文本含系统名（缓存已预热或同步读到）', raw.includes('示例系统') || raw === '', '长度 ' + raw.length)
    check('后台预热后注入文本非空且含任务提示词', raw.includes('示例系统') && raw.includes('任务开启提示词'), '长度 ' + raw.length)
  }

  // B. 路由契约
  check('通过 inject([\'webServer\']) 注册面板路由', env.injectCalls.some((d) => Array.isArray(d) && d.includes('webServer')), JSON.stringify(env.injectCalls))
  check('注册 3 条 /design-ledger/* 路由', env1Routes.length === 3, '实际 ' + env1Routes.length)
  check(
    '每条路由都有合法 kind',
    env1Routes.every((r) => r.kind === 'exact' || r.kind === 'prefix'),
    JSON.stringify(env1Routes.map((r) => r.kind)),
  )
  check(
    '路由路径正确',
    env1Routes.map((r) => r.path).sort().join(',') ===
      ['/design-ledger/bind.json', '/design-ledger/list.json', '/design-ledger/status.json'].join(','),
    env1Routes.map((r) => r.path).join(','),
  )

  // 端点冒烟：status.json 必须返回**非空合法 JSON**
  const statusRoute = env1Routes.find((r) => r.path === '/design-ledger/status.json')
  if (statusRoute) {
    let body = ''
    let code = 0
    await statusRoute.handler(
      { method: 'GET', url: '/design-ledger/status.json' },
      {
        writeHead(c) {
          code = c
        },
        end(t) {
          body = t
        },
      },
    )
    check('status.json 返回 200', code === 200, '实际 ' + code)
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = null
    }
    check('status.json 是合法 JSON（非空体）', parsed !== null, JSON.stringify(body.slice(0, 80)))
    check('status.json bound=true', !!parsed && parsed.bound === true, JSON.stringify(parsed && parsed.bound))
  }

  // 关键回归：注册时序。cordis 在 webServer 真正 active 之前，ctx.get('webServer')
  // 可能返回一个**没有 register** 的对象（插件自己 diag.log 里的
  // `ws.register=undefined` 就是它）。此时不能误判成"已注册"，也不能崩。
  {
    const lateRoutes = []
    const envLate = makeCtx({ workspaceRoot: ws1, webServer: null })
    // 先给一个"还没 init 完"的对象：有 get、没有 register
    let lateWs = { port: 0 }
    envLate.ctx.get = (name) => (name === 'webServer' ? lateWs : null)
    mod.apply(envLate.ctx)
    check('webServer 尚未就绪时不注册、不抛', lateRoutes.length === 0 && envLate.sections.length > 0)
    // 服务就绪：把可用实例塞进去，等重试兜底把它捡起来
    await new Promise((r) => setTimeout(r, 400))
    lateWs = { port: 19400, register: (r) => (lateRoutes.push(r), () => {}) }
    let picked = false
    for (let i = 0; i < 20 && !picked; i += 1) {
      await new Promise((r) => setTimeout(r, 150))
      picked = lateRoutes.length === 3
    }
    check('webServer 就绪后由重试兜底完成注册（3 条）', lateRoutes.length === 3, '实际 ' + lateRoutes.length)
  }
} finally {
  await cleanup()
}

// ── 场景 2：无台账（注入文本必须退化为 ''，仍然不能抛） ──
console.log('\n=== 场景 2：工作区没有台账 ===')
const ws2 = await mkdtemp(join(tmpdir(), 'dl-contract-empty-'))
try {
  const env = makeCtx({ workspaceRoot: ws2, webServer: { register: () => () => {} } })
  mod.apply(env.ctx)
  const section = env.sections.find((s) => s.name === 'design-ledger')
  check('仍注册段落', !!section)
  if (section) {
    const raw = section.text({})
    check('无台账时返回空串且是 string', raw === '' && typeof raw === 'string', JSON.stringify(raw))
    check('宿主式 interpolate 不抛错', (() => {
      try {
        env.renderLikeHost()
        return true
      } catch {
        return false
      }
    })())
  }
} finally {
  await cleanup()
}

// ── 场景 3：台账 JSON 损坏（读盘抛错也必须退化为字符串） ──
console.log('\n=== 场景 3：台账 index.json 损坏 ===')
const ws3 = await mkdtemp(join(tmpdir(), 'dl-contract-corrupt-'))
try {
  await mkdir(join(ws3, 'DEVPLAN'), { recursive: true })
  await writeFile(join(ws3, 'DEVPLAN', 'index.json'), '{ this is not json', 'utf8')
  const env = makeCtx({ workspaceRoot: ws3, webServer: { register: () => () => {} } })
  mod.apply(env.ctx)
  const section = env.sections.find((s) => s.name === 'design-ledger')
  if (section) {
    const raw = section.text({})
    check('损坏台账下仍返回 string', typeof raw === 'string', '实际 ' + typeof raw)
    check('损坏台账下宿主式 interpolate 不抛错', (() => {
      try {
        env.renderLikeHost()
        return true
      } catch {
        return false
      }
    })())
  }
} finally {
  await cleanup()
}

// ── 场景 4：webServer 尚未就绪（注入回调暂时不触发） ──
console.log('\n=== 场景 4：webServer 未就绪（apply 时不注册，但不能抛） ===')
const ws4 = await mkdtemp(join(tmpdir(), 'dl-contract-latews-'))
try {
  let threw = null
  const env = makeCtx({ workspaceRoot: ws4, webServer: null })
  try {
    mod.apply(env.ctx)
  } catch (e) {
    threw = e
  }
  check('apply() 不抛', threw === null, threw ? String(threw && threw.message) : '')
  const section = env.sections.find((s) => s.name === 'design-ledger')
  check('段落仍注册（与路由解耦）', !!section)
} finally {
  await cleanup()
}

console.log('\n' + (failures.length === 0 ? '全部通过 ✅' : '失败 ' + failures.length + ' 项 ❌：' + failures.join(' | ')))
process.exitCode = failures.length === 0 ? 0 : 1
