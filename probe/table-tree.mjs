/**
 * 方案 A 真实验证：拿**真实设计文档**跑一遍，看表格行是否变成可推进的功能节点。
 *
 * 只读：不写台账、不碰工作区的 DEVPLAN/。
 *
 * 运行：node --import ./probe/register.mjs probe/table-tree.mjs <设计文档目录>
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const DESIGN_ROOT = process.argv[2]
if (!DESIGN_ROOT) {
  console.error('用法: node --import ./probe/register.mjs probe/table-tree.mjs <设计文档目录>')
  process.exit(1)
}

const { scanDesignDocs } = await import(pathToFileURL(join(process.cwd(), 'lib', 'design-doc.js')).href)
const { buildLedgerFromScan, countSubtree } = await import(pathToFileURL(join(process.cwd(), 'lib', 'ledger.js')).href)

const scan = await scanDesignDocs({ rootPath: DESIGN_ROOT })

console.log('=== 1) 文档里的表格识别情况 ===')
let featureTables = 0
let plainTables = 0
let featureRows = 0
for (const f of scan.files) {
  const tables = f.tables ?? []
  if (tables.length === 0) continue
  for (const t of tables) {
    if (t.feature) {
      featureTables += 1
      featureRows += t.rows.length
      console.log(
        `  ✅ 功能表 ${f.rel} :: ${t.heading ?? '(无标题)'} — ${t.rows.length} 行` +
          `  名称列=${t.nameColumn} 状态列=${t.statusColumn}`,
      )
      console.log('     行 ID:', t.rows.map((r) => r.id).join(', '))
    } else {
      plainTables += 1
      console.log(`  ·  普通表 ${f.rel} :: ${t.heading ?? '(无标题)'} — 表头[${t.headers.slice(0, 4).join(' | ')}…]（不建节点）`)
    }
  }
}
console.log(`\n  合计：功能表 ${featureTables} 张 / ${featureRows} 行；普通表 ${plainTables} 张被正确忽略`)

const built = buildLedgerFromScan({
  scan,
  workspaceRoot: process.cwd(),
  designRoot: DESIGN_ROOT,
  designInput: DESIGN_ROOT,
})

console.log('\n=== 2) 生成的台账树 ===')
let totals = { nodes: 0, features: 0 }
for (const [sid, nodes] of built.systems) {
  const rootNode = nodes.get(sid)
  const st = countSubtree(rootNode, nodes)
  const feats = [...nodes.values()].filter((n) => n.kind === 'feature').length
  totals.nodes += nodes.size
  totals.features += feats
  console.log(`\n■ ${rootNode.name}  [${sid}]`)
  console.log(
    `   节点 ${st.total}（功能 ${feats}）  完成度 ${st.done}/${st.total}  ` +
      `design≈${rootNode.docTokens} tok  analysis≈${rootNode.analysisTokens ?? 0} tok`,
  )
  for (const cid of rootNode.children) {
    const n = nodes.get(cid)
    if (!n) continue
    console.log(`   ├─ ${n.name}   [${n.id.split('/').slice(1).join('/')}]`)
    if (n.notes) console.log(`   │    设计态：${n.notes}`)
  }
}

console.log('\n=== 3) 体量对账（修掉"analysis 不计入"的不一致）===')
let designSum = 0
let analysisSum = 0
for (const [, nodes] of built.systems) {
  for (const n of nodes.values()) {
    if (n.parentId === null) {
      designSum += n.docTokens ?? 0
      analysisSum += n.analysisTokens ?? 0
    }
  }
}
console.log(`  design.md  合计 ≈${designSum} tok`)
console.log(`  analysis.md 合计 ≈${analysisSum} tok（单独记录，不混进 docTokens）`)
console.log(`  两者相加 ≈${designSum + analysisSum} tok`)
console.log(`  scan.totals.tokens = ${scan.totals.tokens} tok（全部 14 个 .md）`)

console.log('\n=== 4) 断言 ===')
const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(name)
}
/** 真正的系统根节点：parentId 为 null 的那个（不能拿"分片里第一个 key"当根）。 */
const systemRoots = []
for (const [, nodes] of built.systems) {
  for (const n of nodes.values()) if (n.parentId === null) systemRoots.push({ nodes, root: n })
}
const withChildren = systemRoots.filter(({ root }) => (root.children ?? []).length > 0)
const withoutChildren = systemRoots.filter(({ root }) => (root.children ?? []).length === 0)

check('识别出功能表', featureTables > 0, featureTables + ' 张')
check('生成了功能节点', totals.features > 0, totals.features + ' 个')
check(
  'design + analysis 与总 token 量级一致',
  Math.abs(designSum + analysisSum - scan.totals.tokens) / scan.totals.tokens < 0.35,
  `${designSum + analysisSum} vs ${scan.totals.tokens}`,
)
console.log(`  ℹ️ 展开到功能节点的系统：${withChildren.length}/${systemRoots.length}`)
if (withoutChildren.length > 0) {
  console.log('  ℹ️ 仍是单节点的系统（其 design.md 里**没有带 ID 列的功能表**）：')
  for (const { root } of withoutChildren) {
    console.log(`      · ${root.name}  — 该文档的功能清单是正文/无 ID 表格，需人工补节点，或给表格加 ID 列`)
  }
}
check(
  '至少展开了主要功能表（S03 这类带 ID 表的系统）',
  withChildren.length >= 1,
  withChildren.map(({ root }) => root.name).join('、'),
)
// 「有系统没展开」在方案 A 的设计下是**预期结果**（那些文档没有带 ID 列的功能表），
// 所以只在 --strict 下当成失败；默认只如实报告，不让它掩盖真正的回归。
if (process.argv.includes('--strict')) {
  check('每个系统都有功能节点（--strict）', withoutChildren.length === 0, withoutChildren.map(({ root }) => root.name).join('、'))
}

console.log('\n' + (failures.length === 0 ? '全部通过 ✅' : '失败 ' + failures.length + ' 项 ❌'))
process.exitCode = failures.length === 0 ? 0 : 1
