/**
 * 路由行为测试：直接调用三个路由的 handler，验证：
 *   1. list 能列目录与 .md，且带 mdCount
 *   2. **路径安全**：绝对路径 / .. 穿越 / 工作区外 一律拒绝
 *   3. bind 能在工作区内建台账（真实设计文档）
 *   4. bind 拒绝越界路径
 *   5. status 反映绑定结果
 */
import { cp } from 'node:fs/promises'
import { cleanupTemp, makeTempDir } from './temp.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DESIGN_SRC = process.argv[2]

/** 插件根目录（本文件在 <plugin>/probe/ 下）—— 不写死机器路径，任何 clone 位置都能跑。 */
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)

const routes = []
const tools = new Map()
let wsRoot = null
const promptSections = []

const fakeCtx = {
  config: {},
  effect(fn) {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  get(n) {
    if (n === 'webServer') {
      return {
        register(r) { if (!routes.includes(r)) routes.push(r); return () => {} },
      }
    }
    return null
  },
  inject(deps, cb) {
    if (typeof cb !== 'function') return () => {}
    // 插件用 ctx.inject(['webServer'], cb) 与 ctx.inject(['systemPrompt'], cb)
    const api = {}
    if (Array.isArray(deps) && deps.includes('webServer')) {
      api.webServer = {
        register(r) { if (!routes.includes(r)) routes.push(r); return () => {} },
      }
    }
    if (Array.isArray(deps) && deps.includes('systemPrompt')) {
      api.systemPrompt = { section: (s) => (promptSections.push(s), () => {}) }
    }
    cb(api)
    return () => {}
  },
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => {}
    },
  },
  sandboxPolicy: { resolve: () => ({ workspaceRoot: wsRoot }) },
}

plugin.apply(fakeCtx)
// WebRoute 用 kind（'exact'|'prefix'）匹配，**不是** method；按 path 索引即可
const byPath = new Map(routes.map((r) => [r.path, r]))
console.log('路由契约自检: ' + routes.map((r) => r.kind + ' ' + r.path).join(' | '))
const badRoutes = routes.filter((r) => r.kind !== 'exact' && r.kind !== 'prefix')
if (badRoutes.length > 0) {
  console.error('!! 路由缺少合法 kind:', JSON.stringify(badRoutes.map((r) => r.path)))
  process.exitCode = 1
}

/** 造一个最小的 req/res 驱动 handler。查表按 path（WebRoute 用 kind 匹配，不是 method）。 */
async function invoke(method, path, { query = '', body = null } = {}) {
  const route = byPath.get(path)
  if (!route) throw new Error('路由未注册: ' + path)
  const req = {
    method,
    url: path + (query ? '?' + query : ''),
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  let statusCode = 0
  let payload = ''
  const res = {
    writeHead(code) {
      statusCode = code
    },
    end(text) {
      payload = text
    },
  }
  await route.handler(req, res)
  let parsed = null
  try {
    parsed = JSON.parse(payload)
  } catch {
    parsed = payload
  }
  return { statusCode, body: parsed }
}

const ws = await makeTempDir('dl-route-')
try {
  wsRoot = ws
  await cp(DESIGN_SRC, join(ws, 'design-docs'), { recursive: true })

  console.log('=== 1) list 根目录 ===')
  const r1 = await invoke('GET', '/design-ledger/list.json')
  console.log('  status =', r1.statusCode)
  console.log('  dirs  =', (r1.body.dirs || []).map((d) => `${d.name}(${d.mdCount} md)`).join(', '))
  console.log('  parentRel =', JSON.stringify(r1.body.parentRel))

  console.log('\n=== 2) list 进入设计文档目录 ===')
  const r2 = await invoke('GET', '/design-ledger/list.json', { query: 'rel=design-docs' })
  console.log('  status =', r2.statusCode)
  console.log('  dirs  =', (r2.body.dirs || []).map((d) => `${d.name}(${d.mdCount})`).join(', '))
  console.log('  files =', (r2.body.files || []).map((f) => f.name).join(', '))
  console.log('  parentRel =', JSON.stringify(r2.body.parentRel))

  console.log('\n=== 3) 路径安全（必须全部拒绝）===')
  for (const bad of [
    'rel=../../Windows',
    'rel=..%2F..%2FWindows',
    'rel=C:%5CWindows',
    'rel=/etc',
  ]) {
    const r = await invoke('GET', '/design-ledger/list.json', { query: bad })
    console.log(`  ${bad.padEnd(28)} -> status=${r.statusCode} ${r.body.error || ''}`)
  }

  console.log('\n=== 4) status（未绑定）===')
  const s0 = await invoke('GET', '/design-ledger/status.json')
  console.log('  status =', s0.statusCode, '| bound =', s0.body.bound, '| 候选 =', (s0.body.designCandidates || []).length)

  console.log('\n=== 5) bind 越界路径（应 403）===')
  const b0 = await invoke('POST', '/design-ledger/bind.json', { body: { rel: '../../etc' } })
  console.log('  status =', b0.statusCode, '| error =', b0.body.error)

  console.log('\n=== 6) bind 合法路径（真实设计文档）===')
  const b1 = await invoke('POST', '/design-ledger/bind.json', {
    body: { rel: 'design-docs', taskPrompt: '把设计文档变成可实时更新的开发进度台账。' },
  })
  console.log('  status =', b1.statusCode)
  console.log('  ok =', b1.body.ok, '| systemsCreated =', b1.body.systemsCreated)
  console.log('  design =', JSON.stringify(b1.body.design))
  for (const s of b1.body.systemList || []) console.log('    -', s.id, '|', s.name)

  console.log('\n=== 7) status（已绑定）===')
  const s1 = await invoke('GET', '/design-ledger/status.json')
  console.log('  bound =', s1.body.bound, '| systems =', s1.body.systems, '| nodes =', s1.body.totals?.nodes)
  console.log('  hasTaskPrompt =', s1.body.hasTaskPrompt)

  console.log('\n=== 8) 重复 bind（应 409，避免覆盖进度）===')
  const b2 = await invoke('POST', '/design-ledger/bind.json', { body: { rel: 'design-docs' } })
  console.log('  status =', b2.statusCode, '| error =', b2.body.error)

  console.log('\n=== 9) 注入段落（应含系统名与任务提示词）===')
  const text = await promptSections[0].text({})
  console.log('  长度 =', String(text).length)
  console.log('  含任务提示词 =', String(text).includes('任务开启提示词'))
  console.log('  含系统名 =', String(text).includes('核心玩法系统'))
} finally {
  // 清理失败**不能**影响结论：Windows 上临时目录偶发 EPERM/ENOTEMPTY（杀软或文件句柄未释放），
  // 而 finally 里抛出的错误会直接让进程以退出码 1 结束，看起来像"测试失败"，非常误导。
  try {
    await cleanupTemp(ws)
  } catch (e) {
    console.log('  ℹ️ 临时目录清理失败（不影响上面的结论）: ' + String((e && e.message) || e))
  }
}
