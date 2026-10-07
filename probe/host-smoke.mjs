/**
 * 宿主侧冒烟测试：不经 DSH，用假 ctx 调 apply()，验证：
 *   1. 工具确实注册（应 6 个）
 *   2. systemPrompt 段落确实注册，且产出文本
 *   3. webServer 路由确实注册
 *   4. 端到端：design_ledger_init 用**真实设计文档**建台账 → status → update → 注入
 *
 * 运行（cwd = 插件目录）：
 *   node --import ./probe/register.mjs probe/host-smoke.mjs <设计文档路径> <工作区路径>
 */
import { cp } from 'node:fs/promises'
import { cleanupTemp, makeTempDir } from './temp.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DESIGN_SRC = process.argv[2]
const WS_RO = process.argv[3]

/** 插件根目录（本文件在 <plugin>/probe/ 下）—— 不写死机器路径，任何 clone 位置都能跑。 */
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)

// ── 假 ctx ──
const registeredTools = new Map()
const promptSections = []
const routes = []
let effects = 0

const fakeCtx = {
  config: {},
  effect(fn, label) {
    effects += 1
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) { if (!routes.includes(route)) routes.push(route); return () => {} },
      }
    }
    return null
  },
  inject(deps, cb) {
    // 本插件用两种：inject(['webServer'], cb) 与 inject(['systemPrompt'], cb)
    if (typeof cb === 'function') {
      const api = {}
      if (Array.isArray(deps) && deps.includes('webServer')) {
        api.webServer = {
          register(route) { if (!routes.includes(route)) routes.push(route); return () => {} },
        }
      }
      if (Array.isArray(deps) && deps.includes('systemPrompt')) {
        api.systemPrompt = {
          section(s) {
            promptSections.push(s)
            return () => {}
          },
        }
      }
      cb(api)
    }
    return () => {}
  },
  tools: {
    register(def) {
      registeredTools.set(def.name, def)
      return () => {}
    },
  },
  sandboxPolicy: {
    resolve() {
      return { workspaceRoot: WS_RO }
    },
  },
}

console.log('=== 1) apply() ===')
plugin.apply(fakeCtx)
console.log('  注册工具数 =', registeredTools.size)
console.log('  工具:', [...registeredTools.keys()].join(', '))
console.log('  systemPrompt 段落数 =', promptSections.length)
console.log('  webServer 路由数 =', routes.length, routes.map((r) => (r.method || '') + ' ' + (r.path || '')).join(', '))
console.log('  effects =', effects)

const exec = { agent: { session: {} } }
const call = async (name, args) => {
  const def = registeredTools.get(name)
  if (!def) throw new Error('工具未注册: ' + name)
  return def.execute(args || {}, exec)
}

if (!DESIGN_SRC || !WS_RO) {
  console.log('\n（未提供设计文档/工作区路径，跳过端到端）')
  process.exit(0)
}

// ── 在临时工作区里复制一份设计文档，避免污染真实目录 ──
const ws = await makeTempDir('dl-smoke-')
try {
  const designDst = join(ws, 'design-docs')
  await cp(DESIGN_SRC, designDst, { recursive: true })
  // 覆盖 sandboxPolicy 指向临时工作区
  fakeCtx.sandboxPolicy.resolve = () => ({ workspaceRoot: ws })

  console.log('\n=== 2) design_ledger_status（应为未绑定）===')
  const st0 = await call('design_ledger_status')
  console.log('  bound =', st0.bound, '| 候选数 =', (st0.designCandidates || []).length)
  console.log('  候选前 3:', (st0.designCandidates || []).slice(0, 3).map((c) => `${c.path} (${c.mdCount} md)`).join(' | '))

  console.log('\n=== 3) design_ledger_init（用真实设计文档）===')
  const init = await call('design_ledger_init', {
    design_path: designDst,
    task_prompt: '把这份设计文档变成可实时更新的开发进度台账，并按系统推进开发。',
  })
  console.log('  ok =', init.ok)
  console.log('  设计文档统计 =', JSON.stringify(init.design))
  console.log('  系统数 =', init.systemsCreated)
  console.log('  系统清单:')
  for (const s of init.systemList || []) console.log('    -', s.id, '|', s.name, '| ≈' + Math.round(s.docTokens / 1000) + 'k tok')
  if (init.tokenWarning) console.log('  tokenWarning =', init.tokenWarning)

  console.log('\n=== 4) design_ledger_status（应为已绑定）===')
  const st1 = await call('design_ledger_status')
  console.log('  bound =', st1.bound, '| systems =', st1.systems, '| nodes =', st1.nodes, '| done =', st1.done)
  console.log('  hasTaskPrompt =', st1.hasTaskPrompt)
  console.log('  台账文件 =', (st1.ledgerFiles || []).length)

  console.log('\n=== 5) design_ledger_read tree（骨架）===')
  const tree = await call('design_ledger_read', { scope: 'tree' })
  console.log((tree.tree || '').split('\n').slice(0, 14).join('\n'))

  const firstSystem = (init.systemList || [])[0]
  if (firstSystem) {
    console.log('\n=== 6) design_ledger_update（标记 + 置 doing + 代码索引 + bug）===')
    const upd = await call('design_ledger_update', {
      node_id: firstSystem.id,
      mark: true,
      status: 'doing',
      add_code_refs: [{ file: 'src/systems/core/CoreSystem.ts', symbol: 'CoreSystem' }],
      add_interfaces: ['init(config): void'],
      add_bug: {
        summary: '示例 bug：初始化顺序依赖未满足',
        severity: 'medium',
        code_ref: { file: 'src/systems/core/CoreSystem.ts', symbol: 'init' },
      },
    })
    console.log('  ok =', upd.ok, '| acted =', (upd.acted || []).join(', '))
    console.log('  systemProgress =', JSON.stringify(upd.systemProgress))

    console.log('\n=== 7) 注入文本（systemPrompt 段落产出）===')
    const section = promptSections[0]
    if (!section) {
      console.log('  !! 未注册 systemPrompt 段落')
    } else {
      const text = await section.text({})
      console.log('  长度 =', String(text).length, '字符')
      console.log('  前 900 字符:')
      console.log(String(text).slice(0, 900))
      console.log('  ...')
      console.log('  含"任务开启提示词" =', String(text).includes('任务开启提示词'))
      console.log('  含"当前聚焦子树"   =', String(text).includes('当前聚焦子树'))
      console.log('  含代码索引符号     =', String(text).includes('CoreSystem'))
    }

    console.log('\n=== 8) design_ledger_read bugs ===')
    const bugs = await call('design_ledger_read', { scope: 'bugs' })
    console.log('  count =', bugs.count, JSON.stringify(bugs.bugs))
  }

  console.log('\n=== 9) design_doc_read（按需读取一份系统文档，限 600 字符）===')
  const sysRel = firstSystem ? firstSystem.id + '/design.md' : null
  if (sysRel) {
    const doc = await call('design_doc_read', { rel: sysRel, max_chars: 600 })
    console.log('  sources =', JSON.stringify(doc.sources), '| chars =', doc.chars, '| truncated =', doc.truncated)
    console.log('  前 200 字符:', String(doc.text || '').slice(0, 200).replace(/\n/g, ' ⏎ '))
  }
} finally {
  // 同上：清理失败不该伪装成测试失败（Windows 临时目录偶发 EPERM）。
  try {
    await cleanupTemp(ws)
  } catch (e) {
    console.log('  ℹ️ 临时目录清理失败（不影响上面的结论）: ' + String((e && e.message) || e))
  }
}
