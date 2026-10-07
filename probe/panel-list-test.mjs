/**
 * 面板取数探针：验证「选择设计文档」能列到**正确工作区**的目录。
 *
 * 背景（用户实测症状）：弹窗里"此目录下没有子目录或 .md 文件"，而且点「工作区根」
 * 也切不回工作区 —— 因为面板把 `D:\AppData\.dsh\profiles\desktop`（部署默认根）
 * 当成了工作区根，还把它"确认"下来锁死了。
 *
 * 机制：宿主路由**没有 session 上下文**，`sandboxPolicy.resolve()` 只能给部署默认根。
 * 「工作区」这个事实只在会话侧出现（工具调用的 `exec.agent.session`、`agent/session-start`
 * 事件）。因此插件必须：
 *   · 任何一次带 session 的解析 → 记下会话工作区；
 *   · 路由缺省 → 用这条记录；
 *   · **部署根（profile / node_modules / 主目录）一律不认**，否则面板会锁死在 profile 里。
 *
 * 运行：node --import ./probe/register.mjs probe/panel-list-test.mjs <会话工作区>
 * 退出码非 0 = 契约被破坏。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** 会话工作区（真实待浏览目录）。 */
const WS = process.argv[2] || process.cwd()
/**
 * 模拟宿主 sandboxPolicy 在**无 session** 时的缺省解析。
 *
 * 注意这是**测试夹具**，故意写成本机实测到的那个 profile 目录 —— 要复现的正是
 * "面板把部署默认根当成工作区"这个现象。它不是隐私泄漏，也不是可移植性缺陷：
 * 任何值都能验证同一条逻辑（`isDeploymentRoot` 按结构识别，不看具体盘符）。
 * 换机器复现时，把它改成本机实际的 profile 目录即可。
 */
const DEPLOY_ROOT = 'D:\\AppData\\.dsh\\profiles\\desktop'

const mod = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)

const routes = []
/** 记录插件注册的事件监听，供探针模拟"会话开始"。 */
const listeners = new Map()

/** 假 session：有它时 policy 给会话工作区，没有时给部署根（与真实宿主一致）。 */
const fakeSession = { cwd: WS, id: 'probe-session' }
const policy = {
  resolve: (req) => ({
    mode: 'workspace-write',
    workspaceRoot: req && req.session ? WS : DEPLOY_ROOT,
  }),
}

const ctx = {
  config: {},
  logger: { warn() {}, info() {}, error() {} },
  tools: { register: () => () => {} },
  effect: (fn) => {
    try {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    } catch {
      return () => {}
    }
  },
  on(name, handler) {
    listeners.set(name, handler)
    return () => {}
  },
  /** 默认"还没有活着的 agent"（用例 2/2b 之前不该有任何工作区来源）。 */
  agents: { list: () => [] },
  get: () => null,
  inject(deps, cb) {
    const scoped = Object.assign({}, ctx)
    if (Array.isArray(deps) && deps.includes('webServer')) {
      scoped.webServer = { register: (r) => (routes.push(r), () => {}) }
    }
    if (Array.isArray(deps) && deps.includes('systemPrompt')) scoped.systemPrompt = { section: () => () => {} }
    try {
      cb(scoped)
    } catch {
      /* 由插件自己兜 */
    }
    return () => {}
  },
  sandboxPolicy: policy,
}

mod.apply(ctx)
await new Promise((r) => setTimeout(r, 100))

const byPath = new Map(routes.map((r) => [r.path, r]))
const listRoute = byPath.get('/design-ledger/list.json')
const statusRoute = byPath.get('/design-ledger/status.json')
if (!listRoute || !statusRoute) {
  console.error('❌ 面板路由未注册（实际注册: ' + routes.map((r) => r.path).join(', ') + '）')
  process.exit(1)
}

/** 造一个最小的 req/res 驱动器。 */
async function call(route, query) {
  const req = { method: 'GET', url: route.path + (query ? '?' + query : '') }
  let code = 0
  let body = ''
  const res = {
    writeHead(c) {
      code = c
    },
    end(t) {
      body = t
    },
  }
  await route.handler(req, res)
  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = null
  }
  return { code, parsed }
}
const get = (query) => call(listRoute, query)
const status = () => call(statusRoute, '')

const failures = []
function check(name, ok, detail) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(name)
}

console.log('会话工作区 =', WS)
console.log('部署默认根 =', DEPLOY_ROOT)

console.log('\n=== 1) 会话未知时：绝不能把部署根当工作区（修复前就是这样锁死的）===')
const s0 = await status()
console.log('  status.workspaceRoot =', s0.parsed && s0.parsed.workspaceRoot)
check(
  '部署根不被当作工作区（面板显示"工作区未知"，而不是锁在 profile 里）',
  !s0.parsed || s0.parsed.workspaceRoot !== DEPLOY_ROOT,
  '实际 ' + (s0.parsed && s0.parsed.workspaceRoot),
)
const l0 = await get('rel=')
check('会话未知时 list 直接 400，不去列 profile 目录', l0.code === 400 && l0.parsed.error === 'no-workspace', JSON.stringify(l0.parsed))

console.log('\n=== 2) 事件学习：agent/created（真实事件名）→ 记下会话工作区 ===')
const createdHandler = listeners.get('agent/created')
check('插件注册了 agent/created 监听（不是不存在的 agent/session-start）', typeof createdHandler === 'function', [...listeners.keys()].join(', '))
check('没有注册不存在的事件名 agent/session-start', !listeners.has('agent/session-start'))
if (typeof createdHandler === 'function') createdHandler({ agent: { session: fakeSession } })
const l2 = await get('rel=')
const dirs = (l2.parsed && l2.parsed.dirs) || []
console.log('  list.workspaceRoot =', l2.parsed && l2.parsed.workspaceRoot)
console.log('  dirs =', dirs.map((d) => d.name + '(' + d.mdCount + ' md)').join(', ') || '(空)')
check('记录会话工作区后 list 用会话工作区', !!l2.parsed && l2.parsed.workspaceRoot === WS, '实际 ' + (l2.parsed && l2.parsed.workspaceRoot))
check('能看到工作区里的文件夹', dirs.length > 0, '数量 ' + dirs.length)
check('能看到设计文档候选目录', dirs.some((d) => d.name.includes('game-design-docs')), dirs.map((d) => d.name).join(','))
const s1 = await status()
check('status 也改用会话工作区（面板据此取数）', !!s1.parsed && s1.parsed.workspaceRoot === WS, '实际 ' + (s1.parsed && s1.parsed.workspaceRoot))

console.log('\n=== 2b) 插件在会话诞生之后才加载：主动发现（agents.list）===')
// 这是本机真实踩到的场景：bundle 刚登记 / 宿主重启时序导致错过事件。
// 另起一个全新实例（没有事件学习），但 agents.list() 里有活着的 session。
const routes2 = []
const ctx2 = Object.assign({}, ctx)
ctx2.inject = (deps, cb) => {
  const scoped = Object.assign({}, ctx2)
  if (Array.isArray(deps) && deps.includes('webServer')) scoped.webServer = { register: (r) => (routes2.push(r), () => {}) }
  if (Array.isArray(deps) && deps.includes('systemPrompt')) scoped.systemPrompt = { section: () => () => {} }
  try {
    cb(scoped)
  } catch {
    /* ignore */
  }
  return () => {}
}
ctx2.agents = { list: () => [{ session: fakeSession }] }
ctx2.on = () => () => {}
const mod2 = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href + '?fresh=1')
mod2.apply(ctx2)
await new Promise((r) => setTimeout(r, 150))
const list2 = routes2.find((r) => r.path === '/design-ledger/list.json')
const req2 = { method: 'GET', url: '/design-ledger/list.json?rel=' }
let code2 = 0
let body2 = ''
await list2.handler(req2, {
  writeHead(c) {
    code2 = c
  },
  end(t) {
    body2 = t
  },
})
let parsed2 = null
try {
  parsed2 = JSON.parse(body2)
} catch {
  parsed2 = null
}
console.log('  workspaceRoot =', parsed2 && parsed2.workspaceRoot)
check('没有事件也能主动发现会话工作区（面板开箱即用）', !!parsed2 && parsed2.workspaceRoot === WS, '实际 ' + (parsed2 && parsed2.workspaceRoot))

console.log('\n=== 3) 带 workspace 参数（面板显式回传，含正斜杠写法）===')
const slash = WS.replace(/\\/g, '/')
const l3 = await get('rel=&workspace=' + encodeURIComponent(slash))
check('正斜杠写法的 workspace 被接受且一致', !!l3.parsed && l3.parsed.workspaceRoot === WS, '实际 ' + (l3.parsed && l3.parsed.workspaceRoot))

console.log('\n=== 4) 部署根 / 越界目录 / node_modules 都不能被"确认" ===')
const dep = await get('rel=&workspace=' + encodeURIComponent(DEPLOY_ROOT))
console.log('  部署根 -> status', dep.code, '| error =', dep.parsed && dep.parsed.error)
check('显式传部署根也被拒（防止锁死、切不回来）', dep.code === 400, 'status ' + dep.code)
const outside = await get('rel=&workspace=' + encodeURIComponent('C:\\Windows'))
check('越界目录被拒', outside.code === 400, 'status ' + outside.code)
const nm = await get('rel=&workspace=' + encodeURIComponent(WS + '\\node_modules'))
check('node_modules 被拒', nm.code === 400, 'status ' + nm.code)
const stillOk = await get('rel=')
check('拒绝之后原工作区仍然可用', !!stillOk.parsed && stillOk.parsed.workspaceRoot === WS, '实际 ' + (stillOk.parsed && stillOk.parsed.workspaceRoot))

console.log('\n' + (failures.length === 0 ? '全部通过 ✅' : '失败 ' + failures.length + ' 项 ❌：' + failures.join(' | ')))
process.exitCode = failures.length === 0 ? 0 : 1
