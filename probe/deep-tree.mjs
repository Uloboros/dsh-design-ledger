/**
 * 多层树验证：设计文档的目录层次是否真的映射成 系统 → 子系统 → 功能 → 子功能。
 *
 * 你的真实文档在 S0N_* 下没有子目录，所以这里用合成结构验证深层能力：
 *   03_systems/
 *     S01_sample_system/            → 系统
 *       design.md                   → 该层级正文（名称取 H1）
 *       S01_01_combat/              → 子系统
 *         design.md
 *         S01_01_01_hitbox/         → 功能
 *           design.md
 *         S01_01_02_damage/         → 功能
 *           design.md
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件根目录（本文件在 <plugin>/probe/ 下）—— 不写死机器路径。 */
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { scanDesignDocs, classifyDirName } = await import(
  pathToFileURL(join(PLUGIN, 'lib', 'design-doc.js')).href
)
const { buildLedgerFromScan, countSubtree } = await import(
  pathToFileURL(join(PLUGIN, 'lib', 'ledger.js')).href
)

console.log('=== 目录名推断（深层）===')
for (const n of ['S01_sample_system', 'S01_01_combat', 'S01_01_01_hitbox', '03_systems', '01_top_design']) {
  const c = classifyDirName(n)
  console.log(`  ${n.padEnd(22)} kind=${String(c.kind).padEnd(10)} index=${c.index} code=${c.code}`)
}

const root = await mkdtemp(join(tmpdir(), 'dl-deep-'))
try {
  const w = async (rel, text) => {
    await mkdir(join(root, rel.split('/').slice(0, -1).join('\\')), { recursive: true })
    await writeFile(join(root, rel.split('/').join('\\')), text, 'utf8')
  }
  await w('03_systems/S01_sample_system/design.md', '# 示例系统\n')
  await w('03_systems/S01_sample_system/S01_01_combat/design.md', '# 战斗子系统\n')
  await w('03_systems/S01_sample_system/S01_01_combat/S01_01_01_hitbox/design.md', '# 命中判定\n')
  await w('03_systems/S01_sample_system/S01_01_combat/S01_01_02_damage/design.md', '# 伤害计算\n')
  await w('03_systems/S02_base/design.md', '# 基地系统\n')

  const scan = await scanDesignDocs({ rootPath: root })
  console.log('\n=== 扫描结果（目录层级）===')
  const show = (n, d) => {
    console.log('  '.repeat(d) + `[${n.kind}] ${n.name}  (rel=${n.rel})`)
    for (const c of n.children ?? []) show(c, d + 1)
  }
  show(scan.entry, 0)

  const built = buildLedgerFromScan({ scan, workspaceRoot: root, designRoot: root, designInput: root })
  console.log('\n=== 台账结构与层级 ===')
  console.log('系统分片:', built.index.systems.map((s) => s.id + ' = ' + s.name).join(' | '))
  for (const [sid, nodes] of built.systems) {
    const rootNode = nodes.get(sid)
    console.log(`\n系统 ${sid} (${rootNode.name})：`)
    const walk = (id, depth) => {
      const n = nodes.get(id)
      if (!n) return
      const st = countSubtree(n, nodes)
      console.log('  '.repeat(depth + 1) + `- ${n.name}  kind=${n.kind}  children=${n.children.length}  完成度=${st.done}/${st.total}`)
      for (const c of n.children) walk(c, depth + 1)
    }
    walk(sid, 0)
  }

  const sys = built.systems.get('03_systems/S01_sample_system')
  const kinds = [...sys.values()].map((n) => n.kind)
  console.log('\n=== 断言 ===')
  console.log('  节点总数 =', sys.size, '(期望 4：系统+子系统+2功能)')
  console.log('  含 subsystem 节点 =', kinds.includes('subsystem'))
  const hitbox = [...sys.values()].find((n) => n.name === '命中判定')
  console.log('  「命中判定」存在 =', !!hitbox, '| 其父 =', hitbox ? sys.get(hitbox.parentId)?.name : 'n/a')
} finally {
  // 清理失败不影响结论：Windows 上临时目录偶发 EPERM/ENOTEMPTY，
  // 在 finally 里抛出会让进程以退出码 1 结束，看起来像"测试失败"（本机踩过）。
  try {
    await rm(root, { recursive: true, force: true })
  } catch (e) {
    console.log('  ℹ️ 临时目录清理失败（不影响上面的结论）: ' + String((e && e.message) || e))
  }
}
