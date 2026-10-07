/**
 * 设计文档扫描与解析。
 *
 * 纯逻辑 + 只读文件系统访问，不依赖任何 DSH API，因此可以直接单测。
 *
 * 支持两种输入：
 *  1. 单个 .md 文件 —— 按 Markdown 标题层级建树；
 *  2. 文件夹（递归）—— 按目录结构推断层级（"严格项目管理"结构下最可靠）。
 *
 * 目录名推断规则（取自真实项目实测）：
 *   `00_concept` / `01_top_design`  → 分组（group），非系统
 *   `S01_core_gameplay`             → 系统（system）
 *   `SNN_<名称>`（两个以上数字）     → 子系统（subsystem）
 *   `design.md`                     → 该层级的正文
 *   `analysis.md`                   → 该层级的分析（附加引用，不建节点）
 *   其他 `*.md`                      → 归入最近祖先层级，作为补充材料
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

/** 层级种类。 */
export const KINDS = /** @type {const} */ ([
  'root',
  'group',
  'system',
  'subsystem',
  'feature',
  'subfeature',
  'task',
  'doc',
])

/** 默认忽略的目录名。 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.dsh', '.godot', 'dist', 'build', '.vscode'])

/**
 * 中英混排的 token 粗估。中文约 1.5–2 字符/token，英文约 4 字符/token；
 * 这里取 1.7 作为保守系数，用于判断"能否整体注入"。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp >= 0x2e80 && cp <= 0x9fff) cjk += 1
    else if (cp >= 0xf900 && cp <= 0xfaff) cjk += 1
    else if (cp >= 0xff00 && cp <= 0xffef) cjk += 1
  }
  const other = text.length - cjk
  // 中文 0.65 token/字；其余按 0.28 token/字符（约 3.5 字符/token）。
  return Math.round(cjk * 0.65 + other * 0.28)
}

/**
 * 判断 `child` 是否位于 `parent` 之内（含相等）。用于把用户给的路径限制在设计文档根内。
 * @param {string} parent
 * @param {string} child
 */
export function isInside(parent, child) {
  const p = resolve(parent)
  const c = resolve(child)
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 表格行的 ID 形态：全大写短前缀 + 下划线 + 数字（ABC_001 / DEF_002）。 */
const FEATURE_ID_RE = /^[A-Z][A-Z0-9]{1,9}_\d{2,4}$/

/** 表格列名里表示"名称"的写法。 */
const NAME_HEADER_RE = /名称$/

/** 表格列名里表示"开发状态"的写法。 */
const STATUS_HEADER_RE = /^(当前状态|状态|开发状态)$/

/** 判断一个表格单元格是否是"待定/空"这类没有信息量的占位值。 */
function isPlaceholder(text) {
  const s = String(text ?? '').trim()
  if (s.length === 0) return true
  return s === '待定' || s === '待补充' || s === '-' || s === '—' || s === '无'
}

/** 按 `|` 切分一行表格，去掉首尾空单元与空白。 */
function splitTableRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.map((c) => c.trim())
}

/** 分隔行：`|---|---|` 或 `| --- | :--: |`。 */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()))
}

/**
 * 分节 + 抽取"功能表"。
 *
 * 用户方案 A 的核心：这类设计文档把**功能清单写成表格**（每行一个 `XXX_001` 条目，
 * 表格自带「当前状态」列），而标题基本上是文档模板的固定节。所以：
 *   · `sections`  —— 按标题切分，供"按标题建树"和按层级读取使用；
 *   · `tables[].rows` —— 表格数据行，供生成功能节点使用。
 *
 * **只有"首列形如 ID"的表才算功能表**（`feature: true`）：
 * 判据是每一行数据行的第一列都匹配 `PREFIX_数字`。这样"白天预报与建设 | S01、S02"这种
 * 普通表格不会被误当成功能清单。
 *
 * @param {string} text markdown 原文
 * @returns {{
 *   sections: { level: number, title: string, line: number, chars: number, tokens: number }[],
 *   tables: {
 *     heading: string | null, line: number, feature: boolean,
 *     headers: string[], idColumn: number | null, nameColumn: number | null, statusColumn: number | null,
 *     rows: { id: string | null, name: string, cells: string[] }[],
 *   }[],
 * }}
 */
export function parseStructure(text) {
  const empty = { sections: [], tables: [] }
  if (typeof text !== 'string' || text.length === 0) return empty
  const lines = text.split(/\r?\n/)

  // ── 1) 标题索引（跳过代码围栏内） ──
  /** @type {{ level: number, title: string, line: number }[]} */
  const heads = []
  let inFence = false
  let fenceMarker = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1][0]
      } else if (fence[1][0] === fenceMarker) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (m) {
      const title = m[2].replace(/\s+#+\s*$/, '').trim()
      if (title.length > 0) heads.push({ level: m[1].length, title, line: i + 1 })
    }
  }

  /** 每个标题覆盖到"下一个同级或更高级标题"之前的原文（含子节）。 */
  const sections = heads.map((h, idx) => {
    let end = lines.length
    for (let j = idx + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].line - 1
        break
      }
    }
    const body = lines.slice(h.line, end).join('\n')
    return { level: h.level, title: h.title, line: h.line, chars: body.length, tokens: estimateTokens(body) }
  })

  /** 1-based 行号 → 所属标题（最近的上方标题）。 */
  const headingAt = (lineNo) => {
    let found = null
    for (const h of heads) {
      if (h.line <= lineNo) found = h
      else break
    }
    return found ? found.title : null
  }

  // ── 2) 表格抽取 ──
  /** @type {ReturnType<typeof parseStructure>['tables']} */
  const tables = []
  inFence = false
  fenceMarker = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1][0]
      } else if (fence[1][0] === fenceMarker) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    if (!line.trim().startsWith('|')) continue

    // 表头 + 分隔行 + 数据行
    const headers = splitTableRow(line)
    const sep = i + 1 < lines.length && lines[i + 1].trim().startsWith('|') ? splitTableRow(lines[i + 1]) : null
    if (!sep || !isSeparatorRow(sep)) continue

    const rows = []
    let j = i + 2
    for (; j < lines.length; j++) {
      const cur = lines[j]
      if (!cur.trim().startsWith('|')) break
      const cells = splitTableRow(cur)
      if (cells.every((c) => c.length === 0)) continue
      if (isSeparatorRow(cells)) continue
      rows.push(cells)
    }

    const idColumn = headers.findIndex((h) => /ID$/i.test(h.replace(/\s/g, '')))
    const nameColumn = headers.findIndex((h) => NAME_HEADER_RE.test(h.replace(/\s/g, '')))
    const statusColumn = headers.findIndex((h) => STATUS_HEADER_RE.test(h.replace(/\s/g, '')))
    // 功能表判据：首列即 ID 列，且**每一行**的首列都长得像 ID
    const feature = idColumn === 0 && rows.length > 0 && rows.every((r) => FEATURE_ID_RE.test(r[0] ?? ''))

    const outRows = rows.map((cells) => {
      const rawId = cells[0] ?? ''
      const id = FEATURE_ID_RE.test(rawId) ? rawId : null
      let name = nameColumn >= 0 ? String(cells[nameColumn] ?? '').trim() : ''
      if (isPlaceholder(name)) {
        // 名称是"待定"时，用同行的类别/作用对象补一个可读名字，避免一堆"待定"节点
        const alt = [cells[2], cells[3]].map((c) => String(c ?? '').trim()).find((c) => !isPlaceholder(c))
        name = (id ? id : rawId) + (alt ? '（' + alt + '）' : '')
      }
      return { id, name, cells }
    })

    tables.push({
      heading: headingAt(i + 1),
      line: i + 1,
      feature,
      headers,
      idColumn: idColumn >= 0 ? idColumn : null,
      nameColumn: nameColumn >= 0 ? nameColumn : null,
      statusColumn: statusColumn >= 0 ? statusColumn : null,
      rows: outRows,
    })
    i = j - 1
  }

  return { sections, tables }
}

/**
 * 从目录名解析出 (序号, 名称, 推断种类)。
 *
 * 例：
 *   `03_systems`            → { index: 3, slug: 'systems', name: 'systems', kind: 'group' }
 *   `S01_core_gameplay`     → { index: 100, slug: 'core_gameplay', name: 'core_gameplay', kind: 'system' }
 *   `S02_01_inventory`      → { index: 201, slug: 'inventory', name: 'inventory', kind: 'subsystem' }
 *   `S02_01_03_stack`       → { index: 203, slug: 'stack', name: 'stack', kind: 'feature' }
 *   `S02_01_03_01_overflow` → { kind: 'subfeature' }
 *   `战斗系统`               → { index: null, slug: '战斗系统', name: '战斗系统', kind: null }
 *
 * @param {string} dirName
 * @returns {{ index: number | null, slug: string, name: string, kind: 'group' | 'system' | 'subsystem' | 'feature' | 'subfeature' | null, code: string | null, depth?: number | null }}
 */
export function classifyDirName(dirName) {
  const raw = String(dirName ?? '').trim()

  // S<两位数字>[_<两位数字>...]_<名称>  —— 按深度映射层级种类
  //   S01_x           → system      （1 段）
  //   S01_01_x        → subsystem   （2 段）
  //   S01_01_01_x     → feature     （3 段）
  //   S01_01_01_01_x  → subfeature  （4 段及以上）
  // 设计文档里的层级深度不受限，因此种类随深度递进而不是只有两档。
  const sMatch = /^S(\d{2})((?:_\d{2})*)_(.+)$/i.exec(raw)
  if (sMatch) {
    const primary = Number(sMatch[1])
    const rest = sMatch[2] ? sMatch[2].split('_').filter(Boolean) : []
    const depth = 1 + rest.length
    const suffix = rest.length > 0 ? Number(rest[rest.length - 1]) : null
    const index = depth === 1 ? primary * 100 : primary * 100 + (suffix ?? 0)
    const kindByDepth = { 1: 'system', 2: 'subsystem', 3: 'feature' }
    return {
      index,
      slug: sMatch[3],
      name: sMatch[3],
      kind: kindByDepth[depth] ?? 'subfeature',
      code: raw.split('_').slice(0, depth).join('_'),
      depth,
    }
  }

  // <NN>_<名称>（纯数字前缀）—— 顶层分组
  const nMatch = /^(\d{1,3})_(.+)$/.exec(raw)
  if (nMatch) {
    return {
      index: Number(nMatch[1]),
      slug: nMatch[2],
      name: nMatch[2],
      kind: 'group',
      code: nMatch[1],
      depth: 1,
    }
  }

  // 无编号前缀：不推断种类，由调用方按位置决定
  return { index: null, slug: raw, name: raw, kind: null, code: null, depth: null }
}

/**
 * 解析 Markdown 标题层级，返回扁平的标题列表（含层级与行号）。
 * 跳过代码围栏内的 `#`。
 *
 * @param {string} text
 * @returns {{ level: number, title: string, line: number }[]}
 */
export function parseHeadings(text) {
  const out = []
  if (typeof text !== 'string') return out
  const lines = text.split(/\r?\n/)
  let inFence = false
  let fenceMarker = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1][0]
      } else if (fence[1][0] === fenceMarker) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (m) {
      // ATX 标题允许用等量或更多的 # 收尾（`### 标题 ###`），需剥离
      const title = m[2].replace(/\s+#+\s*$/, '').trim()
      if (title.length > 0) out.push({ level: m[1].length, title, line: i + 1 })
    }
  }
  return out
}

/**
 * 单个设计文档文件的读取结果。
 * @typedef {{
 *   path: string,        // 绝对路径
 *   rel: string,         // 相对设计文档根
 *   name: string,        // 文件名（不含扩展名）
 *   bytes: number,
 *   chars: number,
 *   tokens: number,
 *   headings: { level: number, title: string, line: number }[],
 *   sections: { level: number, title: string, line: number, chars: number, tokens: number }[],
 *   tables: any[],       // 见 parseStructure：含"功能表"行数据
 * }} DocFile
 */

/**
 * 读取单个 .md 文件并统计。
 * @param {string} absPath
 * @param {string} root
 * @returns {Promise<DocFile>}
 */
export async function readDocFile(absPath, root) {
  const text = await readFile(absPath, 'utf8')
  const st = await stat(absPath)
  const structure = parseStructure(text)
  return {
    path: absPath,
    rel: relative(root, absPath).split(sep).join('/'),
    name: basename(absPath, extname(absPath)),
    bytes: st.size,
    chars: text.length,
    tokens: estimateTokens(text),
    headings: parseHeadings(text),
    sections: structure.sections,
    tables: structure.tables,
  }
}

/**
 * 扫描设计文档，返回树。
 *
 * @typedef {{
 *   type: 'dir' | 'file',
 *   name: string,
 *   rel: string,
 *   kind: string,
 *   code: string | null,
 *   index: number | null,
 *   children: any[],
 *   doc?: DocFile,
 * }} TreeNode
 *
 * @param {{ rootPath: string, maxDepth?: number, maxFiles?: number }} options
 * @returns {Promise<{ root: string, entry: TreeNode, files: DocFile[], totals: { files: number, bytes: number, chars: number, tokens: number }, truncated: boolean }>}
 */
export async function scanDesignDocs(options) {
  const root = resolve(options.rootPath)
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 12
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 2000

  const st = await stat(root)
  const files = []
  let truncated = false

  /** @param {string} abs @param {number} depth @param {string} kindHint */
  async function walk(abs, depth, kindHint) {
    if (depth > maxDepth) return null
    const name = basename(abs)
    const rel = relative(root, abs).split(sep).join('/') || name

    if (st.isFile() || !(await isDir(abs))) {
      if (extname(abs).toLowerCase() !== '.md') return null
      if (files.length >= maxFiles) {
        truncated = true
        return null
      }
      const doc = await readDocFile(abs, root)
      files.push(doc)
      return {
        type: 'file',
        name: doc.name,
        rel,
        kind: 'doc',
        code: null,
        index: null,
        children: [],
        doc,
      }
    }

    const cls = classifyDirName(name)
    /** @type {TreeNode} */
    const node = {
      type: 'dir',
      name: cls.name,
      rel,
      kind: cls.kind ?? kindHint ?? 'group',
      code: cls.code,
      index: cls.index,
      children: [],
    }

    const entries = await readdir(abs, { withFileTypes: true })
    const dirs = []
    const mds = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.') ) continue
        dirs.push(e.name)
      } else if (e.isFile() && extname(e.name).toLowerCase() === '.md') {
        mds.push(e.name)
      }
    }

    // 子目录优先按推断序号排序，其次名称；无序号者排后
    dirs.sort((a, b) => {
      const ca = classifyDirName(a)
      const cb = classifyDirName(b)
      const ia = ca.index ?? Number.MAX_SAFE_INTEGER
      const ib = cb.index ?? Number.MAX_SAFE_INTEGER
      if (ia !== ib) return ia - ib
      return a.localeCompare(b, 'zh')
    })

    // design.md / analysis.md 先入，保证它们排在子目录前面（作为本层级正文）
    mds.sort((a, b) => {
      const rank = (n) => (n.toLowerCase() === 'design.md' ? 0 : n.toLowerCase() === 'analysis.md' ? 1 : 2)
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      return a.localeCompare(b, 'zh')
    })

    for (const f of mds) {
      const child = await walk(join(abs, f), depth + 1, 'doc')
      if (child) node.children.push(child)
    }
    for (const d of dirs) {
      const child = await walk(join(abs, d), depth + 1, undefined)
      if (child) node.children.push(child)
    }
    return node
  }

  async function isDir(p) {
    try {
      return (await stat(p)).isDirectory()
    } catch {
      return false
    }
  }

  if (!st.isDirectory()) {
    // 单文件输入
    if (extname(root).toLowerCase() !== '.md') {
      throw new Error('设计文档路径必须是 .md 文件或文件夹：' + root)
    }
    const doc = await readDocFile(root, resolve(root, '..'))
    files.push(doc)
    const entry = {
      type: 'file',
      name: doc.name,
      rel: doc.name,
      kind: 'doc',
      code: null,
      index: null,
      children: [],
      doc,
    }
    return {
      root,
      entry,
      files,
      totals: { files: 1, bytes: doc.bytes, chars: doc.chars, tokens: doc.tokens },
      truncated: false,
    }
  }

  const entry = await walk(root, 0, 'group')
  const totals = files.reduce(
    (acc, f) => {
      acc.files += 1
      acc.bytes += f.bytes
      acc.chars += f.chars
      acc.tokens += f.tokens
      return acc
    },
    { files: 0, bytes: 0, chars: 0, tokens: 0 },
  )
  return { root, entry, files, totals, truncated }
}

/**
 * 把扫描树压缩成"层级骨架"，用于注入索引（不展开到 doc 叶子）。
 *
 * @param {TreeNode} node
 * @param {{ maxDepth?: number, maxChildren?: number }} [opts]
 * @returns {{ name: string, kind: string, rel: string, docTokens: number, children: any[] } | null}
 */
export function toSkeleton(node, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 3
  const maxChildren = Number.isInteger(opts.maxChildren) ? opts.maxChildren : 12

  function visit(n, depth) {
    if (!n || n.kind === 'doc') return null
    const kids = []
    if (depth < maxDepth) {
      let shown = 0
      for (const c of n.children ?? []) {
        if (shown >= maxChildren) break
        const s = visit(c, depth + 1)
        if (s) {
          kids.push(s)
          shown += 1
        }
      }
    }
    return {
      name: n.name,
      kind: n.kind,
      rel: n.rel,
      docTokens: directDocTokens(n),
      childCount: (n.children ?? []).filter((c) => c.kind !== 'doc').length,
      children: kids,
    }
  }

  /** 该层级直属文档的 token 合计（design.md + analysis.md 等）。 */
  function directDocTokens(n) {
    let t = 0
    for (const c of n.children ?? []) {
      if (c.kind === 'doc' && c.doc) t += c.doc.tokens
    }
    return t
  }

  return visit(node, 0)
}

/**
 * 在扫描树中按相对路径查找节点。
 * @param {TreeNode} node
 * @param {string} rel
 * @returns {TreeNode | null}
 */
export function findNodeByRel(node, rel) {
  const want = String(rel ?? '').split(sep).join('/')
  if (!node) return null
  if (node.rel === want) return node
  for (const c of node.children ?? []) {
    const hit = findNodeByRel(c, want)
    if (hit) return hit
  }
  return null
}

/**
 * 读取设计文档某个层级（或整个前缀）的正文，用于按需注入。
 * 返回拼接后的文本与来源清单。
 *
 * @param {TreeNode} node
 * @param {{ includeDescendants?: boolean, maxChars?: number }} [opts]
 * @returns {Promise<{ text: string, sources: string[], truncated: boolean }>}
 */
export async function readDocContent(node, opts = {}) {
  const maxChars = Number.isInteger(opts.maxChars) ? opts.maxChars : 120000
  const sources = []
  const parts = []
  let total = 0
  let truncated = false

  async function visit(n) {
    if (!n || truncated) return
    if (n.kind === 'doc' && n.doc) {
      if (total >= maxChars) {
        truncated = true
        return
      }
      const text = await readFile(n.doc.path, 'utf8')
      const remain = maxChars - total
      const slice = text.length > remain ? text.slice(0, remain) : text
      if (slice.length < text.length) truncated = true
      parts.push('<!-- design-doc: ' + n.doc.rel + ' -->\n' + slice)
      sources.push(n.doc.rel)
      total += slice.length
      return
    }
    for (const c of n.children ?? []) {
      await visit(c)
      if (truncated) return
    }
  }

  await visit(node)
  return { text: parts.join('\n\n'), sources, truncated }
}
