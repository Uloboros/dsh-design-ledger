/**
 * 核心逻辑测试（零依赖，node --test）。
 *
 * 覆盖：
 *  1. 目录名推断（真实项目的编号 + S0N 结构）
 *  2. Markdown 标题解析（含代码围栏内的 # 必须忽略）
 *  3. token 估算数量级
 *  4. 台账构建 → 保存 → 载入 往返一致
 *  5. 状态汇总（rollup）规则
 *  6. 分层注入装配（索引 + 聚焦子树 + 预算截断）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyDirName, estimateTokens, parseHeadings, parseStructure, scanDesignDocs, findNodeByRel } from '../lib/design-doc.js'
import { buildLedgerFromScan, countSubtree, Ledger, rollupStatus } from '../lib/ledger.js'
import { assembleInjection, renderFocusSubtree, renderIndex } from '../lib/inject.js'

test('classifyDirName：真实项目的命名结构', () => {
  // 纯数字前缀 → 分组
  assert.deepEqual(classifyDirName('00_concept'), {
    index: 0,
    slug: 'concept',
    name: 'concept',
    kind: 'group',
    code: '00',
    depth: 1,
  })
  assert.equal(classifyDirName('03_systems').kind, 'group')
  assert.equal(classifyDirName('03_systems').index, 3)

  // S0N_名称 → 系统
  const sys = classifyDirName('S01_core_gameplay')
  assert.equal(sys.kind, 'system')
  assert.equal(sys.name, 'core_gameplay')
  assert.equal(sys.code, 'S01')
  assert.equal(sys.index, 100)

  // S0N_0M_名称 → 子系统
  const sub = classifyDirName('S02_01_inventory')
  assert.equal(sub.kind, 'subsystem')
  assert.equal(sub.name, 'inventory')
  assert.equal(sub.code, 'S02_01')

  // 更深层次必须继续细分种类（设计文档层级不受限）
  assert.equal(classifyDirName('S02_01_03_stack').kind, 'feature')
  assert.equal(classifyDirName('S02_01_03_01_overflow').kind, 'subfeature')
  assert.equal(classifyDirName('S02_01_03_02_underflow').kind, 'subfeature')

  // 无前缀 → 不推断
  const plain = classifyDirName('战斗系统')
  assert.equal(plain.kind, null)
  assert.equal(plain.name, '战斗系统')
})

test('parseHeadings：忽略代码围栏内的 #', () => {
  const md = [
    '# 一级标题',
    '',
    '正文',
    '```bash',
    '# 这是注释，不是标题',
    '```',
    '## 二级标题',
    '### 三级标题 ###',
    '~~~',
    '# 也不是标题',
    '~~~',
  ].join('\n')
  const hs = parseHeadings(md)
  assert.deepEqual(
    hs.map((h) => [h.level, h.title]),
    [
      [1, '一级标题'],
      [2, '二级标题'],
      [3, '三级标题'],
    ],
  )
})

test('estimateTokens：中文量级合理', () => {
  const zh = '中'.repeat(1000)
  const en = 'a'.repeat(1000)
  const tz = estimateTokens(zh)
  const te = estimateTokens(en)
  assert.ok(tz > 500 && tz < 800, '中文 1000 字约 650 token，实际 ' + tz)
  assert.ok(te > 200 && te < 350, '英文 1000 字符约 280 token，实际 ' + te)
})

test('scanDesignDocs + buildLedgerFromScan：按目录结构建树，名称取文档 H1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-test-'))
  try {
    // 构造与真实项目同构的目录
    await mkdir(join(root, '01_top_design'), { recursive: true })
    await writeFile(join(root, '01_top_design', 'design.md'), '# 顶层设计总纲\n\n正文内容\n', 'utf8')
    await mkdir(join(root, '03_systems', 'S01_core_gameplay'), { recursive: true })
    await writeFile(join(root, '03_systems', 'S01_core_gameplay', 'design.md'), '# 核心玩法系统\n\n## 战斗\n\n## 移动\n', 'utf8')
    await writeFile(join(root, '03_systems', 'S01_core_gameplay', 'analysis.md'), '# 分析\n', 'utf8')
    await mkdir(join(root, '03_systems', 'S02_base_building'), { recursive: true })
    await writeFile(join(root, '03_systems', 'S02_base_building', 'design.md'), '# 基地建造系统\n', 'utf8')

    const scan = await scanDesignDocs({ rootPath: root })
    assert.equal(scan.totals.files, 4)
    assert.equal(scan.truncated, false)

    // 顶层应有 01_top_design(组) 与 03_systems(组)
    const dirs = scan.entry.children.filter((c) => c.kind !== 'doc')
    assert.deepEqual(
      dirs.map((d) => d.kind),
      ['group', 'group'],
    )

    const built = buildLedgerFromScan({
      scan,
      workspaceRoot: root,
      designRoot: root,
      designInput: root,
    })
    // 两个系统各自一个分片
    assert.equal(built.index.systems.length, 2)
    const ids = built.index.systems.map((s) => s.id).sort()
    assert.deepEqual(ids, ['03_systems/S01_core_gameplay', '03_systems/S02_base_building'])

    // 名称必须取设计文档的 H1，而不是目录名
    const s1 = built.index.systems.find((s) => s.id.endsWith('S01_core_gameplay'))
    assert.equal(s1.name, '核心玩法系统')
    const sysNodes = built.systems.get(s1.id)
    const rootNode = sysNodes.get(s1.id)
    assert.equal(rootNode.name, '核心玩法系统')
    // designRefs 指向 design.md 与分析文档
    assert.deepEqual(
      rootNode.designRefs.map((r) => r.file).sort(),
      ['03_systems/S01_core_gameplay/analysis.md', '03_systems/S01_core_gameplay/design.md'],
    )
    assert.equal(rootNode.designRefs.find((r) => r.file.endsWith('design.md')).heading, '核心玩法系统')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parseStructure：只把「首列是 ID」的表当功能表，普通表格不算', () => {
  const md = [
    '# 系统',
    '',
    '## 状态与规则',
    '',
    '### 局内升级增益表',
    '',
    '| 增益ID | 增益名称 | 增益类别 | 效果文本 | 当前状态 |',
    '|---|---|---|---|---|',
    '| BFT_001 | 待定 | 通用增益 | 提高容量 | 机制已明确，名称待定 |',
    '',
    '### 系统协作表',
    '',
    '| 核心环节 | 主要系统 | 协作系统 |',
    '| --- | --- | --- |',
    '| 白天预报与建设 | S01、S02 | S03 |',
    '',
    '## 数值结构',
    '',
    '正文若干',
    '',
  ].join('\n')

  const st = parseStructure(md)
  // 分节：正文体量按"到下一个同级标题"计算
  const titles = st.sections.map((s) => s.title)
  assert.deepEqual(titles, ['系统', '状态与规则', '局内升级增益表', '系统协作表', '数值结构'])
  const numeric = st.sections.find((s) => s.title === '数值结构')
  assert.equal(numeric.level, 2)
  assert.ok(numeric.tokens > 0, '数值结构小节应统计到体量')

  // 两张表，只有第一张算功能表
  assert.equal(st.tables.length, 2)
  const feature = st.tables.find((t) => t.feature === true)
  const plain = st.tables.find((t) => t.feature === false)
  assert.ok(feature, '首列是 ID 的表应判为功能表')
  assert.ok(plain, '普通表格不应判为功能表')
  assert.equal(feature.heading, '局内升级增益表')
  assert.equal(feature.rows.length, 1)
  assert.equal(feature.rows[0].id, 'BFT_001')
  // 名称是"待定"时用同行的类别补一个可读名字，避免一堆同名节点
  assert.match(feature.rows[0].name, /BFT_001/)
  assert.match(feature.rows[0].name, /通用增益/)
})

test('buildLedgerFromScan：功能表行展开成 feature 子节点（方案 A）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-test-'))
  try {
    await mkdir(join(root, '03_systems', 'S03_economy'), { recursive: true })
    await writeFile(
      join(root, '03_systems', 'S03_economy', 'design.md'),
      [
        '# 局内成长与经济',
        '',
        '## 状态与规则',
        '',
        '### 局外通用科技树表',
        '',
        '| 科技ID | 科技名称 | 科技类别 | 当前状态 |',
        '|---|---|---|---|',
        '| TEC_001 | 工业复兴计划 | 通用科技 | 名称已明确，成本待定 |',
        '| TEC_002 | 待定 | 通用科技 | 机制已明确，名称待定 |',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(join(root, '03_systems', 'S03_economy', 'analysis.md'), '# 分析\n\n分析正文\n', 'utf8')

    const scan = await scanDesignDocs({ rootPath: root })
    const built = buildLedgerFromScan({ scan, workspaceRoot: root, designRoot: root, designInput: root })
    const sysId = built.index.systems[0].id
    const nodes = built.systems.get(sysId)
    const rootNode = nodes.get(sysId)

    // 两个功能节点都是 system 的子节点
    assert.equal(rootNode.children.length, 2)
    const features = rootNode.children.map((id) => nodes.get(id))
    assert.ok(features.every((n) => n.kind === 'feature'), '子节点应为 feature')
    assert.ok(features.every((n) => n.parentId === sysId))
    assert.deepEqual(features.map((n) => n.name), ['工业复兴计划', 'TEC_002（通用科技）'])
    // id 必须唯一且可读（组名 # 行 ID）；每行都带表名前缀，便于对回设计文档
    assert.equal(new Set(features.map((n) => n.id)).size, 2)
    assert.ok(features[0].id.startsWith(sysId + '/'))
    assert.match(features[0].id, /局外通用科技树表#TEC_001/)
    assert.match(features[1].id, /局外通用科技树表#TEC_002/)
    // 表格的「当前状态」列原样进 notes（渲染时由 inject 加前缀，不再套两层）
    assert.equal(features[0].notes, '名称已明确，成本待定')
    assert.ok(!features[0].notes.startsWith('设计态：'), 'notes 不应自带"设计态："前缀')
    assert.equal(features[0].designRefs[0].file, '03_systems/S03_economy/design.md')
    assert.equal(features[0].designRefs[0].heading, '局外通用科技树表')
    assert.equal(features[0].designRefs[0].anchor, 'TEC_001')
    assert.ok(features[0].docTokens > 0, '功能节点应带上所在小节的体量')

    // analysis.md 的体量单独记，不再混进 docTokens（否则索引与 designStats 对不上）
    assert.ok(rootNode.analysisTokens > 0, 'analysis 体量应单独记录')
    assert.equal(built.index.expandTableRows, true)

    // 关掉展开 → 回到"只有系统节点"的旧行为
    const plain = buildLedgerFromScan({
      scan,
      workspaceRoot: root,
      designRoot: root,
      designInput: root,
      expandTableRows: false,
    })
    const plainNodes = plain.systems.get(sysId)
    assert.equal(plainNodes.get(sysId).children.length, 0)
    assert.equal(plain.index.expandTableRows, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Ledger：保存后载入往返一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-test-'))
  try {
    // 规范结构：系统用 S0N_ 前缀，另有纯文档分组
    await mkdir(join(root, '01_top_design'), { recursive: true })
    await writeFile(join(root, '01_top_design', 'design.md'), '# 顶层设计\n', 'utf8')
    await mkdir(join(root, '03_systems', 'S01_logging'), { recursive: true })
    await writeFile(join(root, '03_systems', 'S01_logging', 'design.md'), '# 日志系统\n', 'utf8')

    const scan = await scanDesignDocs({ rootPath: root })
    const built = buildLedgerFromScan({ scan, workspaceRoot: root, designRoot: root, designInput: root })

    // 纯文档分组记为 section，不生成系统分片
    assert.equal(built.index.systems.length, 1)
    assert.equal(built.index.systems[0].name, '日志系统')
    assert.deepEqual(built.index.sections.map((s) => s.name), ['顶层设计'])

    const ledger = new Ledger(root, 'DEVPLAN')
    assert.equal(await ledger.exists(), false)
    await ledger.save(built.index, built.systems)
    assert.equal(await ledger.exists(), true)

    const loaded = await ledger.load()
    assert.equal(loaded.ok, true)
    assert.equal(loaded.index.systems.length, 1)
    assert.equal(loaded.index.sections.length, 1)
    const nodes = loaded.bySystem.get(loaded.index.systems[0].id)
    assert.ok(nodes.size >= 1)
    for (const n of nodes.values()) {
      assert.ok(typeof n.id === 'string' && n.id.length > 0)
      assert.ok(Array.isArray(n.codeRefs))
      assert.ok(Array.isArray(n.bugs))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rollupStatus：子节点全完成才算完成；有 blocked 则 blocked', () => {
  /** @type {Map<string, any>} */
  const nodes = new Map()
  nodes.set('p', { id: 'p', children: ['a', 'b'], status: 'todo', bugs: [] })
  nodes.set('a', { id: 'a', children: [], status: 'done', bugs: [] })
  nodes.set('b', { id: 'b', children: [], status: 'done', bugs: [] })
  assert.equal(rollupStatus(nodes.get('p'), nodes), 'done')

  nodes.get('b').status = 'doing'
  assert.equal(rollupStatus(nodes.get('p'), nodes), 'doing')

  // a=done + b=todo → 部分完成 = doing（不是 todo）
  nodes.get('b').status = 'todo'
  assert.equal(rollupStatus(nodes.get('p'), nodes), 'doing')

  // 全部子节点都 todo → 才是 todo
  nodes.get('a').status = 'todo'
  assert.equal(rollupStatus(nodes.get('p'), nodes), 'todo')

  // 恢复 a=done 后把 b 置为 blocked → blocked 优先暴露
  nodes.get('a').status = 'done'
  nodes.get('b').status = 'blocked'
  assert.equal(rollupStatus(nodes.get('p'), nodes), 'blocked')

  const cnt = countSubtree(nodes.get('p'), nodes)
  assert.equal(cnt.total, 3)
  assert.equal(cnt.done, 1)
  assert.equal(cnt.blocked, 2)
})

test('注入装配：索引 + 聚焦子树 + 预算截断', () => {
  const nodes = new Map()
  const mk = (id, name, parent, kids, status) => ({
    id,
    name,
    kind: 'feature',
    status,
    parentId: parent,
    children: kids,
    designRefs: [],
    codeRefs: [],
    interfaces: [],
    bugs: [],
    notes: '',
    docTokens: 0,
    updatedAt: null,
  })
  nodes.set('S/log', mk('S/log', '日志系统', null, ['S/log/retention'], 'doing'))
  nodes.set('S/log/retention', mk('S/log/retention', '留存策略', 'S/log', [], 'doing'))
  nodes.get('S/log/retention').codeRefs = [{ file: 'src/log/retention.ts', symbol: 'pruneOldEntries' }]
  nodes.get('S/log/retention').bugs = [
    { id: 'S/log/retention#bug1', summary: '超过 90 天未清理', status: 'open', codeRef: { file: 'src/log/retention.ts', symbol: 'pruneOldEntries' } },
  ]
  nodes.get('S/log/retention').marked = true

  const index = {
    design: { input: '<root>', fileCount: 3, chars: 1000, tokens: 600 },
    systems: [{ id: 'S/log', name: '日志系统', docTokens: 600 }],
    injection: { indexMaxChars: 4000, focusMaxChars: 12000 },
  }
  const bySystem = new Map([['S/log', nodes]])

  const idx = renderIndex(index, bySystem, nodes, 4000)
  assert.match(idx.text, /日志系统/)
  assert.equal(idx.truncated, false)

  const focus = renderFocusSubtree({ focusIds: ['S/log/retention'], allNodes: nodes, maxChars: 12000 })
  assert.equal(focus.empty, false)
  assert.match(focus.text, /留存策略/)
  assert.match(focus.text, /src\/log\/retention\.ts::pruneOldEntries/)
  assert.match(focus.text, /超过 90 天未清理/)

  const inj = assembleInjection({
    index,
    bySystem,
    allNodes: nodes,
    state: { taskPrompt: '把日志留存做成可配置的' },
  })
  assert.match(inj.text, /任务开启提示词/)
  assert.match(inj.text, /把日志留存做成可配置的/)
  assert.match(inj.text, /索引/)
  assert.match(inj.text, /当前聚焦子树/)

  // 预算极小 → 必须触发截断标注
  const tiny = assembleInjection({
    index: { ...index, injection: { indexMaxChars: 80, focusMaxChars: 120 } },
    bySystem,
    allNodes: nodes,
    state: {},
  })
  assert.match(tiny.text, /预算/)
})

test('readDocContent / findNodeByRel：按层级读取设计文档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-test-'))
  try {
    await mkdir(join(root, '03_systems', 'S01_a'), { recursive: true })
    await writeFile(join(root, '03_systems', 'S01_a', 'design.md'), '# 系统A\n\nA 的正文\n', 'utf8')
    const scan = await scanDesignDocs({ rootPath: root })
    const hit = findNodeByRel(scan.entry, '03_systems/S01_a')
    assert.ok(hit, '应能按相对路径找到节点')
    assert.equal(hit.kind, 'system')
    const file = findNodeByRel(scan.entry, '03_systems/S01_a/design.md')
    assert.ok(file)
    assert.equal(file.kind, 'doc')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
