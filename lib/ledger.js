/**
 * 进度台账内核：树数据模型 + JSON 分片存储 + 状态汇总。
 *
 * 纯逻辑（只依赖 node:fs），不依赖 DSH API，可直接单测。
 *
 * 存储布局（在项目根下）：
 *   DEVPLAN/
 *   ├── index.json        索引：设计文档绑定、系统清单、完成度、注入配置
 *   ├── systems/
 *   │   └── <systemId>.json   每个系统的完整子树（节点表）
 *   └── state.json        易变进度：聚焦节点、上次任务提示词（建议 gitignore）
 */

import { mkdir, readFile, readdir, writeFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 台账目录名（可被配置覆盖）。 */
export const DEFAULT_LEDGER_DIR = 'DEVPLAN'

/** 节点状态取值。 */
export const STATUSES = /** @type {const} */ (['todo', 'doing', 'done', 'blocked', 'dropped'])

/** bug 状态取值。 */
export const BUG_STATUSES = /** @type {const} */ (['open', 'fixing', 'fixed', 'wontfix'])

/**
 * @typedef {{
 *   file: string,          // 设计文档路径（相对设计文档根或工作区）
 *   heading?: string,      // 该文档内的标题
 *   anchor?: string,       // 可选锚点/标识
 * }} DesignRef
 *
 * @typedef {{
 *   file: string,          // 代码文件路径（相对工作区）
 *   symbol?: string,       // 符号名（函数/类/变量名）—— 刻意不记行号，避免漂移
 *   note?: string,
 * }} CodeRef
 *
 * @typedef {{
 *   id: string,
 *   summary: string,
 *   status: 'open' | 'fixing' | 'fixed' | 'wontfix',
 *   severity?: 'low' | 'medium' | 'high' | 'critical',
 *   designRef?: DesignRef,
 *   codeRef?: CodeRef,
 *   repro?: string,
 *   createdAt?: string,
 *   updatedAt?: string,
 * }} BugEntry
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: string,
 *   status: 'todo' | 'doing' | 'done' | 'blocked' | 'dropped',
 *   parentId: string | null,
 *   children: string[],
 *   designRefs: DesignRef[],
 *   codeRefs: CodeRef[],
 *   interfaces: string[],
 *   bugs: BugEntry[],
 *   notes: string,
 *   docTokens: number,
 *   updatedAt: string | null,
 * }} LedgerNode
 */

/** 原子写：先写临时文件再 rename，避免半截文件。 */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

/**
 * 读取 JSON，不存在时返回 null（并区分"不存在"与"解析失败"）。
 * @param {string} path
 * @returns {Promise<{ ok: true, value: any } | { ok: false, reason: 'missing' } | { ok: false, reason: 'corrupt', error: string }>}
 */
export async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8')
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch (e) {
      return { ok: false, reason: 'corrupt', error: String((e && e.message) || e) }
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'corrupt', error: String((e && e.message) || e) }
  }
}

/** 由相对路径派生稳定节点 id：把路径分隔与空白规范化为 `/`。 */
export function nodeIdFromRel(rel) {
  return String(rel ?? '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
}

/** 系统 id（用于分片文件名）：把不适合做文件名的字符替换掉。 */
export function systemFileId(systemId) {
  return String(systemId)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 120)
}

/**
 * 从扫描结果构建初始台账。
 *
 * 命名规则（用户确认）：节点名**优先取设计文档里的名称**（design.md 的一级标题），
 * 没有标题时回退到目录名派生的名称。
 *
 * @param {{ scan: any, workspaceRoot: string, designRoot: string, designInput: string, ledgerDir?: string }} args
 * @returns {{ index: any, systems: Map<string, any> }}
 */
export function buildLedgerFromScan(args) {
  const { scan, workspaceRoot, designRoot, designInput } = args
  const ledgerDir = args.ledgerDir ?? DEFAULT_LEDGER_DIR
  const now = new Date().toISOString()

  /**
   * 是否把设计文档里的**功能表行**变成功能节点（方案 A）。
   * 默认开：这类设计文档把功能清单写成 `XXX_001` 表格，不展开的话系统节点下永远是空的。
   */
  const expandTableRows = args.expandTableRows !== false

  /** systemId -> Map<nodeId, LedgerNode>（与该字段在 Ledger.save 中的期望一致） */
  const systems = new Map()

  /** 每个层级名称：优先 design.md 的一级标题，其次目录名 */
  function pickName(dirNode) {
    const docs = (dirNode.children ?? []).filter((c) => c.kind === 'doc' && c.doc)
    const design = docs.find((c) => c.name.toLowerCase() === 'design')
    const source = design ?? docs[0]
    if (source && source.doc) {
      const h1 = (source.doc.headings ?? []).find((h) => h.level === 1)
      if (h1 && h1.title.trim().length > 0) return h1.title.trim()
    }
    return dirNode.name
  }

  /**
   * 把文档里的**功能表行**变成该节点下的 `feature` 子节点。
   *
   * 为什么这么做：这类项目把「功能清单」写成表格（`增益ID | 增益名称 | … | 当前状态`），
   * 标题基本是文档模板的固定节。按标题建树会造一堆噪声节点，而表格行才是**可直接推进
   * 的开发项**，且表格自带状态列。
   *
   * 规则：
   *   · 只认 `parseStructure` 判定为 feature 的表（首列即 ID 列，且每行首列都是 `XXX_001` 形态）；
   *   · 节点 id = `<父节点 id>/<表格标题或行 ID>`，**子行 ID 用 `表#行ID` 保唯一**；
   *   · 表格的「当前状态」列写入节点 notes（保留原话，便于人读）；
   *   · `docTokens` 取该表格所在小节的体量，便于看清这个功能背后有多少设计正文。
   *
   * @returns {{ ids: string[], nextSeq: number }} 新建的功能节点 id 列表
   */
  function addFeatureNodes(owner, doc, bucket, seqStart) {
    const ids = []
    let seq = seqStart
    // 先筛出所有**带 ID 的功能表**：这样下面可以按"每表 → 一行 → 两行"逐级放宽，
    // 而不是简单地"要就全要、不要就全不要"（后者会把只有 1 行的表整张丢掉）。
    const featureTables = (doc.tables ?? []).filter((t) => t && t.feature === true)
    if (featureTables.length === 0) return { ids: [], nextSeq: seq }
    const perTableRows = featureTables.map((t) => t.rows ?? [])
    /** 「展开到哪一级」：默认全展开；每张表只有 1 行时只展开第一张（避免单个示例条目膨胀）。 */
    let plan = []
    if (expandTableRows === 'all' || expandTableRows === undefined || expandTableRows === true) {
      plan = featureTables.map((t, i) => (perTableRows[i].length > 1 ? i : -1)).filter((i) => i >= 0)
      // 所有表都只有 1 行 → 至少展开第一张，让系统节点不至于空着
      if (plan.length === 0) plan = [0]
    } else if (expandTableRows === 'multi-row') {
      plan = featureTables.map((t, i) => (perTableRows[i].length > 1 ? i : -1)).filter((i) => i >= 0)
    } else {
      // false（或未知取值）：不建任何功能节点
      plan = []
    }
    // 表格所在小节（用标题找 sections 里的体量；找不到就退化为该文档体量）
    const sectionTokens = (heading) => {
      const hit = (doc.sections ?? []).find((s) => s.title === heading)
      return hit ? hit.tokens : 0
    }
    for (const table of featureTables) {
      const tableIndex = featureTables.indexOf(table)
      if (!plan.includes(tableIndex)) continue
      const heading = table.heading ? String(table.heading).trim() : ''
      // 表格标题作为 id 的分组前缀（如「局内升级增益表#TEC_001」），
      // **每一行都带前缀**：只用裸行 ID 在跨表同名时不稳，且无法一眼看出它出自哪张表。
      const groupName = heading.length > 0 ? heading : '功能表'
      for (const row of table.rows ?? []) {
        if (!row) continue
        seq += 1
        const localId = row.id ? String(row.id) : 'row' + seq
        const id = owner.id + '/' + groupName + '#' + localId
        if (bucket.nodes.has(id)) continue
        const statusText =
          table.statusColumn !== null && table.statusColumn >= 0
            ? String(row.cells?.[table.statusColumn] ?? '').trim()
            : ''
        /** @type {LedgerNode} */
        const feature = {
          id,
          name: row.name || localId,
          kind: 'feature',
          status: 'todo',
          parentId: owner.id,
          children: [],
          designRefs: [{ file: doc.rel, ...(heading ? { heading } : {}), anchor: localId }],
          codeRefs: [],
          interfaces: [],
          bugs: [],
          // 原样保留设计文档里那一列的说法（渲染时会自己加「备注:」前缀，别再套一层）
          notes: statusText,
          docTokens: sectionTokens(heading),
          updatedAt: null,
        }
        bucket.nodes.set(id, feature)
        ids.push(id)
      }
    }
    return { ids, nextSeq: seq }
  }

  /** 把扫描树的目录节点递归转成 LedgerNode。 */
  function convert(dirNode, parentId, systemId, bucket) {
    const id = nodeIdFromRel(dirNode.rel)
    const docs = (dirNode.children ?? []).filter((c) => c.kind === 'doc' && c.doc)
    const designRefs = docs.map((c) => {
      const h1 = (c.doc.headings ?? []).find((h) => h.level === 1)
      const ref = { file: c.doc.rel }
      if (h1) ref.heading = h1.title
      return ref
    })
    // ⚠️ 只把 design.md 的体量算作"可推进的设计正文"；analysis.md 单独记（见下），
    // 否则索引里的 docTokens 与 designStats 对不上（曾经差 21k tokens，就是因为
    // analysis 既进 designRefs 又没进 docTokens）。
    const designTokens = docs
      .filter((c) => c.name.toLowerCase() === 'design')
      .reduce((a, c) => a + (c.doc?.tokens ?? 0), 0)
    const analysisTokens = docs
      .filter((c) => c.name.toLowerCase() !== 'design')
      .reduce((a, c) => a + (c.doc?.tokens ?? 0), 0)
    const docTokens = designTokens

    /** @type {LedgerNode & { analysisTokens?: number }} */
    const node = {
      id,
      name: pickName(dirNode),
      kind: dirNode.kind === 'root' ? 'root' : dirNode.kind,
      status: 'todo',
      parentId,
      children: [],
      designRefs,
      codeRefs: [],
      interfaces: [],
      bugs: [],
      notes: '',
      docTokens,
      updatedAt: null,
    }
    if (analysisTokens > 0) node.analysisTokens = analysisTokens
    bucket.nodes.set(id, node)

    for (const child of dirNode.children ?? []) {
      if (child.kind === 'doc') continue
      const childNode = convert(child, id, systemId, bucket)
      node.children.push(childNode.id)
    }

    // 方案 A：把该层级 design.md 里的功能表行展开成子节点
    const designDoc = docs.find((c) => c.name.toLowerCase() === 'design')?.doc
    if (designDoc) {
      const { ids } = addFeatureNodes(node, designDoc, bucket, 0)
      for (const fid of ids) node.children.push(fid)
    }
    return node
  }

  // 顶层：根之下找出所有非 doc 子节点，每个 system 一个分片；
  // 分组（group，如 03_systems）下的 system 也各自分片，分组本身作为一个薄层。
  const rootScan = scan.entry
  const groups = (rootScan.children ?? []).filter((c) => c.kind !== 'doc')

  /** @type {{ id: string, name: string, kind: string, rel: string, docTokens: number }[]} */
  const systemList = []
  /** @type {{ id: string, name: string, rel: string, docTokens: number, files: string[] }[]} */
  const sections = []

  for (const g of groups) {
    const isContainer = (g.children ?? []).some((c) => c.kind !== 'doc')
    const gKind = g.kind

    if (gKind === 'system') {
      // 顶层直接就是系统
      const bucket = { nodes: new Map() }
      const sysNode = convert(g, null, nodeIdFromRel(g.rel), bucket)
      sysNode.kind = 'system'
      systems.set(sysNode.id, bucket.nodes)
      systemList.push({
        id: sysNode.id,
        name: sysNode.name,
        kind: 'system',
        rel: g.rel,
        docTokens: sysNode.docTokens,
      })
      continue
    }

    if (!isContainer) {
      // 只有直属文档、没有子目录 → 这是「文档分组」（如 01_top_design / 02_architecture），
      // 不是系统：不建分片，只在索引里记一条 section。
      const docs = (g.children ?? []).filter((c) => c.kind === 'doc' && c.doc)
      const h1 = docs.map((c) => (c.doc.headings ?? []).find((x) => x.level === 1)).find(Boolean)
      sections.push({
        id: nodeIdFromRel(g.rel),
        name: h1 ? h1.title : g.name,
        rel: g.rel,
        docTokens: docs.reduce((a, c) => a + (c.doc.tokens ?? 0), 0),
        files: docs.map((c) => c.doc.rel),
      })
      continue
    }

    // 容器（如 03_systems）：其下的 system 子节点各自分片
    const inner = (g.children ?? []).filter((c) => c.kind !== 'doc')
    const innerSystems = inner.filter((c) => c.kind === 'system')
    const targets = innerSystems.length > 0 ? innerSystems : inner

    for (const s of targets) {
      const bucket = { nodes: new Map() }
      const sysNode = convert(s, null, nodeIdFromRel(s.rel), bucket)
      if (sysNode.kind !== 'system') sysNode.kind = 'system'
      if (!systems.has(sysNode.id)) {
        systems.set(sysNode.id, bucket.nodes)
        systemList.push({
          id: sysNode.id,
          name: sysNode.name,
          kind: 'system',
          rel: s.rel,
          docTokens: sysNode.docTokens,
        })
      }
    }
  }

  const index = {
    schemaVersion: 1,
    ledgerVersion: 1,
    createdAt: now,
    updatedAt: now,
    workspaceRoot,
    ledgerDir,
    design: {
      input: designInput,
      root: designRoot,
      fileCount: scan.totals.files,
      bytes: scan.totals.bytes,
      chars: scan.totals.chars,
      tokens: scan.totals.tokens,
      scannedAt: now,
    },
    expandTableRows,
    injection: {
      includeTaskPrompt: true,
      includeIndex: true,
      includeFocusSubtree: true,
      indexMaxChars: 4000,
      focusMaxChars: 12000,
      designRefMaxChars: 2000,
    },
    systems: systemList,
    sections,
  }

  return { index, systems }
}

/**
 * 汇总节点状态（**子节点的真实 status，不做递归**）。
 *
 * 规则（顺序即优先级）：
 *   1. 叶子节点 → 用自身 status；
 *   2. 有子节点 blocked → blocked（阻塞要向上暴露）；
 *   3. 全部子节点 done/dropped → done；
 *   4. 有子节点 doing → doing；
 *   5. 有子节点 done（但未全完成） → doing（部分完成即"进行中"）；
 *   6. 否则 → todo。
 *
 * 注意：`rollupStatus` 只看直接子节点；要判断整棵子树是否完成请用 `countSubtree`。
 */
export function rollupStatus(node, nodes) {
  const ids = node.children ?? []
  if (ids.length === 0) return node.status
  const kids = ids.map((id) => nodes.get(id)).filter(Boolean)
  if (kids.length === 0) return node.status
  if (kids.some((k) => k.status === 'blocked')) return 'blocked'
  if (kids.every((k) => k.status === 'done' || k.status === 'dropped')) return 'done'
  if (kids.some((k) => k.status === 'doing')) return 'doing'
  if (kids.some((k) => k.status === 'done')) return 'doing'
  if (kids.every((k) => k.status === 'todo')) return 'todo'
  return 'todo'
}

/**
 * 统计一棵子树的进度。
 *
 * `total` 含父节点（用于"整体完成度"），`features` 只数叶子（= 真正可推进的条目）。
 * 两者都给，是因为只看 total 会产生歧义：把**一个**功能标记为 doing 时，系统节点会因
 * 向上汇总也变成 doing，于是"doing=2"看起来像有两个功能在做（本机实测踩到）。
 */
export function countSubtree(node, nodes) {
  const acc = {
    total: 0,
    done: 0,
    doing: 0,
    todo: 0,
    blocked: 0,
    dropped: 0,
    bugsOpen: 0,
    features: 0,
    featuresDoing: 0,
    featuresDone: 0,
  }
  function visit(n) {
    if (!n) return
    acc.total += 1
    const isLeaf = (n.children ?? []).length === 0
    if (isLeaf) acc.features += 1
    const eff = rollupStatus(n, nodes)
    if (eff === 'done') {
      acc.done += 1
      if (isLeaf) acc.featuresDone += 1
    } else if (eff === 'doing') {
      acc.doing += 1
      if (isLeaf) acc.featuresDoing += 1
    } else if (eff === 'blocked') acc.blocked += 1
    else if (eff === 'dropped') acc.dropped += 1
    else acc.todo += 1
    acc.bugsOpen += (n.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing').length
    for (const id of n.children ?? []) visit(nodes.get(id))
  }
  visit(node)
  return acc
}

/** 台账读写门面。 */
export class Ledger {
  /**
   * @param {string} workspaceRoot 工作区根目录绝对路径
   * @param {string} [ledgerDir] 台账目录名（默认 DEVPLAN）
   */
  constructor(workspaceRoot, ledgerDir = DEFAULT_LEDGER_DIR) {
    this.workspaceRoot = workspaceRoot
    this.ledgerDir = ledgerDir
    this.root = join(workspaceRoot, ledgerDir)
  }

  get indexPath() {
    return join(this.root, 'index.json')
  }
  get statePath() {
    return join(this.root, 'state.json')
  }
  systemPath(id) {
    return join(this.root, 'systems', systemFileId(id) + '.json')
  }

  /** 台账是否已建立（index.json 存在且可解析）。 */
  async exists() {
    const r = await readJson(this.indexPath)
    return r.ok === true
  }

  /** 载入完整台账：index + 所有系统分片（每个系统一张扁平节点表）。 */
  async load() {
    const idx = await readJson(this.indexPath)
    if (!idx.ok) {
      if (idx.reason === 'missing') return { ok: false, reason: 'missing' }
      return { ok: false, reason: 'corrupt', error: idx.error }
    }
    const index = idx.value
    /** @type {Map<string, Map<string, LedgerNode>>} systemId -> nodes */
    const bySystem = new Map()
    /** @type {Map<string, LedgerNode>} 全局节点索引（跨系统按 id） */
    const allNodes = new Map()

    for (const s of index.systems ?? []) {
      const r = await readJson(this.systemPath(s.id))
      if (!r.ok) continue
      const nodes = new Map(Object.entries(r.value.nodes ?? {}))
      bySystem.set(s.id, nodes)
      for (const [k, v] of nodes) allNodes.set(k, v)
    }

    const st = await readJson(this.statePath)
    const state = st.ok ? st.value : {}

    return { ok: true, index, bySystem, allNodes, state }
  }

  /**
   * 写入 index 与全部系统分片。
   * @param {any} index
   * @param {Map<string, Map<string, import('./ledger.js').LedgerNode>>} systems systemId -> 节点表
   */
  async save(index, systems) {
    index.updatedAt = new Date().toISOString()
    await writeJsonAtomic(this.indexPath, index)
    for (const [systemId, nodeMap] of systems) {
      const nodes = {}
      for (const [id, node] of nodeMap) nodes[id] = node
      await writeJsonAtomic(this.systemPath(systemId), {
        schemaVersion: 1,
        systemId,
        updatedAt: index.updatedAt,
        nodes,
      })
    }
    return index
  }

  /** 写入易变状态（聚焦节点、任务提示词等）。 */
  async saveState(state) {
    await writeJsonAtomic(this.statePath, { schemaVersion: 1, ...state })
  }

  /** 列出台账目录下的所有文件（用于状态展示）。 */
  async listFiles() {
    const out = []
    async function walk(dir) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else {
          try {
            const st = await stat(p)
            out.push({ path: p, bytes: st.size })
          } catch {
            /* ignore */
          }
        }
      }
    }
    await walk(this.root)
    return out
  }
}

/** 台账目录的 .gitignore 内容建议（state.json 易变，不参与版本管理）。 */
export const STATE_GITIGNORE_HINT = 'state.json'
