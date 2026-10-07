/**
 * 与 AGENTS.md 的联动。
 *
 * 分工（不重复内容）：
 *   - `AGENTS.md`：DSH 原生经 dsh-agent-instructions **注入**，给人读的摘要与指针；
 *   - `DEVPLAN/`：本插件的结构化台账，给机器读的细节（索引 + 分片 + 注入）。
 *
 * **安全纪律**：只维护带标签的一段托管块（`<!-- dsh-design-ledger:begin -->` …
 * `<!-- dsh-design-ledger:end -->`），块外内容一律原样保留；重复写入是幂等的
 * （先把旧托管块整段剥掉再追加）。用户删掉标签即视为接管，之后不再自动改写。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const BEGIN = '<!-- dsh-design-ledger:begin -->'
export const END = '<!-- dsh-design-ledger:end -->'

/**
 * 只把**独占整行**的标记算作托管块边界；行内引用（块内的说明文字会引用标记）
 * 不算。返回精确的 [start, end) 字符区间，找不到返回 null。
 *
 * 这一步很关键：标记在块正文里被引用，若用 `indexOf` 天真定位，
 * 会剥错区间并累积出重复块（实测踩过）。
 *
 * @param {string} text
 * @returns {{ start: number, end: number, count: number } | null}
 */
export function findManagedBlock(text) {
  const re = /^[ \t]*(<!-- dsh-design-ledger:(?:begin|end) -->)[ \t]*$/gm
  const marks = []
  let m
  while ((m = re.exec(text)) !== null) {
    marks.push({ index: m.index, len: m[0].length, kind: m[1].includes('begin') ? 'begin' : 'end' })
  }
  const begins = marks.filter((x) => x.kind === 'begin')
  const ends = marks.filter((x) => x.kind === 'end')
  if (begins.length === 0 || ends.length === 0) return null
  const start = begins[0].index
  const last = ends[ends.length - 1]
  return { start, end: last.index + last.len, count: Math.min(begins.length, ends.length) }
}

/** 剥掉托管块，返回剩余内容（块外内容原样保留）。 */
export function stripManagedBlock(text) {
  const b = findManagedBlock(text)
  if (!b) return { text, stripped: false }
  return {
    text: (text.slice(0, b.start) + text.slice(b.end)).replace(/\n{3,}/g, '\n\n'),
    stripped: true,
  }
}

/** AGENTS.md 里托管块的正文。 */
export function renderAgentsBlock(args) {
  const { designInput, ledgerDir, systemList = [], totals = {} } = args
  const lines = []
  lines.push(BEGIN)
  lines.push('## 开发进度台账（dsh-design-ledger 维护）')
  lines.push('')
  lines.push('本工作区的开发进度以 **设计文档** 为纲，台账在 `' + ledgerDir + '/`（**不要**手工编辑该目录）。')
  lines.push('')
  lines.push('- 设计文档：`' + String(designInput ?? '') + '`')
  lines.push(
    '- 体量：' +
      (totals.files ?? 0) +
      ' 个 .md / ' +
      Math.round((totals.chars ?? 0) / 1000) +
      'k 字符 ≈ ' +
      Math.round((totals.tokens ?? 0) / 1000) +
      'k tokens —— **不会整体注入**，细节按需读取',
  )
  if (systemList.length > 0) {
    lines.push('- 系统（' + systemList.length + ' 个）：' + systemList.map((s) => s.name).join('、'))
  }
  lines.push('')
  lines.push('接手任务的纪律：')
  lines.push('')
  lines.push('1. 先 `design_ledger_status` 看当前进度与聚焦节点；')
  lines.push('2. 读 `design_ledger_read {scope:"tree"}` 看骨架、`{scope:"bugs"}` 看未修 bug；')
  lines.push('3. 开工时 `design_ledger_update {node_id, mark:true, status:"doing"}`；')
  lines.push('4. 完成后 `status:"done"` 并补 `code_refs`（**只记文件+符号名**）与 `interfaces`；')
  lines.push('5. 发现 bug 立即 `add_bug`（挂到最可能出问题的节点），修好 `update_bug {status:"fixed"}`；')
  lines.push('6. 需要设计细节时 `design_doc_read` **按层级**读，不要整体读。')
  lines.push('')
  lines.push('> 本段由插件自动维护；删除 `' + BEGIN + '` 标签即视为接管，之后不再自动改写。')
  lines.push(END)
  return lines.join('\n')
}

/**
 * 把托管块写入（或更新）AGENTS.md。
 *
 * @param {{ workspaceRoot: string, designInput: string, ledgerDir: string, systemList?: any[], totals?: any, fileName?: string }} args
 * @returns {Promise<{ ok: boolean, file: string, created: boolean, replaced: boolean, reason?: string }>}
 */
export async function syncAgentsFile(args) {
  const fileName = args.fileName ?? 'AGENTS.md'
  const file = join(args.workspaceRoot, fileName)
  const block = renderAgentsBlock(args)

  let existing = null
  let created = false
  try {
    existing = await readFile(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      created = true
      existing = ''
    } else {
      return { ok: false, file, created: false, replaced: false, reason: String((e && e.message) || e) }
    }
  }

  // 若已存在托管块（即使内容过期），整段替换以保证幂等；
  // 若用户已删除标签，则视为接管——只追加新的托管块，不动其它内容。
  const stripped = stripManagedBlock(existing)
  const replaced = stripped.stripped
  const base = stripped.text

  const trimmed = base.replace(/\s+$/, '')
  const next = (trimmed.length > 0 ? trimmed + '\n\n' : '') + block + '\n'

  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, next, 'utf8')
  return { ok: true, file, created, replaced }
}
