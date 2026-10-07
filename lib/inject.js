/**
 * 分层注入文本装配。
 *
 * 依据实测约束（一份真实设计文档 ≈133k tokens），**全量注入不可行**，因此按层装配：
 *
 *   L0 任务开启提示词（完整）      —— 用户开启任务时的那段话
 *   L1 索引                        —— 系统清单 + 完成度 + 设计文档体量（受体量预算约束）
 *   L2 当前聚焦子树（优先 marked）  —— 含祖先链，便于理解上下文位置
 *   L3 设计文档正文                —— 默认不注入；仅在显式请求时按层读取
 *
 * 纯函数，不碰文件系统（正文读取由调用方完成后传入），便于单测。
 */

import { countSubtree, rollupStatus } from './ledger.js'

/** 状态的紧凑标记。 */
const STATUS_MARK = {
  done: '✅',
  doing: '🔄',
  blocked: '⛔',
  dropped: '⛔',
  todo: '⬜',
}

/** 显示状态标记。 */
export function mark(status) {
  return STATUS_MARK[status] ?? '⬜'
}
/**
 * 渲染单行节点摘要（用于索引与子树）。
 * @param {import('./ledger.js').LedgerNode} node
 * @param {Map<string, import('./ledger.js').LedgerNode>} nodes
 * @param {{ showChildren?: boolean, childLimit?: number }} [opts]
 */
export function renderNodeLine(node, nodes, opts = {}) {
  const childLimit = Number.isInteger(opts.childLimit) ? opts.childLimit : 0
  const eff = rollupStatus(node, nodes)
  const stat = countSubtree(node, nodes)
  const bits = []
  bits.push(mark(eff))
  bits.push(node.name)
  if (node.kind && node.kind !== 'root') bits.push('(' + node.kind + ')')
  // 叶子节点（功能）显示自己；有子节点时显示"功能完成数/功能总数"，
  // 而不是含自身的 total —— 否则一个功能标记 doing 会显示成 doing=2。
  if ((node.children ?? []).length === 0) {
    bits.push(stat.done + '/' + stat.total)
  } else {
    bits.push(stat.featuresDone + '/' + stat.features)
  }
  const openBugs = (node.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing').length
  if (openBugs > 0) bits.push('bug:' + openBugs)
  if (childLimit > 0 && (node.children ?? []).length > 0) {
    const kids = node.children
      .map((id) => nodes.get(id))
      .filter(Boolean)
      .slice(0, childLimit)
    if (kids.length > 0) {
      bits.push('→ ' + kids.map((k) => mark(rollupStatus(k, nodes)) + k.name).join(', '))
      const rest = (node.children ?? []).length - kids.length
      if (rest > 0) bits.push('…+' + rest)
    }
  }
  return bits.join(' ')
}

/**
 * 渲染 L1 索引（受体量预算约束；超预算时按系统逐个截断并标注）。
 *
 * @param {any} index 台账 index
 * @param {Map<string, Map<string, import('./ledger.js').LedgerNode>>} bySystem
 * @param {Map<string, import('./ledger.js').LedgerNode>} allNodes
 * @param {number} maxChars
 */
export function renderIndex(index, bySystem, allNodes, maxChars) {
  const lines = []
  const d = index.design ?? {}
  lines.push(
    '设计文档：' +
      String(d.input ?? '') +
      '（' +
      (d.fileCount ?? 0) +
      ' 个 .md，' +
      Math.round((d.chars ?? 0) / 1000) +
      'k 字符 ≈ ' +
      Math.round((d.tokens ?? 0) / 1000) +
      'k tokens）',
  )
  lines.push('系统清单（' + (index.systems ?? []).length + ' 个）：')
  let used = lines.join('\n').length
  let truncated = false

  const sorted = [...(index.systems ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh'))
  for (const s of sorted) {
    const nodes = bySystem.get(s.id)
    const sysNode = nodes ? [...nodes.values()].find((n) => n.id === s.id) : undefined
    let line
    if (sysNode && nodes) {
      const stat = countSubtree(sysNode, nodes)
      const openBugs = (sysNode.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing').length
      // 进度按**功能（叶子）**统计：`total` 含系统节点自身，直接用会出现"标 1 个功能 → 变成 2"
      const doingTxt = stat.featuresDoing > 0 ? ' 进行中 ' + stat.featuresDoing : ''
      line =
        '- ' +
        mark(rollupStatus(sysNode, nodes)) +
        ' [' +
        s.id +
        '] ' +
        sysNode.name +
        '  ' +
        stat.featuresDone +
        '/' +
        stat.features +
        doingTxt +
        (openBugs > 0 ? '  bug:' + openBugs : '') +
        '  ≈' +
        Math.round((s.docTokens ?? 0) / 1000) +
        'k tok'
    } else {
      line = '- ⬜ [' + s.id + '] ' + s.name + '（分片缺失）'
    }
    if (used + line.length + 1 > maxChars) {
      truncated = true
      lines.push('- …（其余 ' + (sorted.length - sorted.indexOf(s)) + ' 个系统因索引体量预算未展开）')
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return { text: lines.join('\n'), truncated }
}

/**
 * 渲染 L2 聚焦子树：从 marked 节点（或指定节点）向上取祖先链，再展开其子树。
 *
 * @param {{ focusIds: string[], allNodes: Map<string, import('./ledger.js').LedgerNode>, maxChars: number }} args
 */
export function renderFocusSubtree(args) {
  const { focusIds, allNodes, maxChars } = args
  const lines = []
  let truncated = false

  if (!focusIds || focusIds.length === 0) {
    return { text: '', truncated: false, empty: true }
  }

  for (const fid of focusIds) {
    const node = allNodes.get(fid)
    if (!node) {
      lines.push('（聚焦节点 ' + fid + ' 不存在于台账中）')
      continue
    }
    // 祖先链
    const chain = []
    let cur = node
    const guard = new Set()
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id)
      chain.unshift(cur)
      cur = cur.parentId ? allNodes.get(cur.parentId) : undefined
    }
    lines.push('聚焦：' + chain.map((n) => n.name).join(' › '))
    lines.push('')

    const rendered = []
    let used = 0
    function visit(n, depth) {
      if (!n || truncated) return
      const line = '  '.repeat(depth) + renderNodeLine(n, allNodes)
      if (used + line.length + 1 > maxChars) {
        truncated = true
        return
      }
      rendered.push(line)
      used += line.length + 1

      // 节点明细（只在该节点自身有内容时输出，避免噪声）
      const details = []
      if ((n.status ?? 'todo') !== 'todo' || (n.children ?? []).length === 0) {
        details.push('状态: ' + (n.status ?? 'todo'))
      }
      if ((n.designRefs ?? []).length > 0) {
        details.push(
          '设计: ' +
            n.designRefs
              .map((r) => {
                let s = r.file
                if (r.heading) s += ' #' + r.heading
                // anchor：功能节点用它指出"这一行在表格里的 ID"（如 ABC_001），
                // 不渲染的话就没法从注入直接对回设计文档的具体条目。
                if (r.anchor) s += ' ›' + r.anchor
                return s
              })
              .join(' | '),
        )
      }
      if ((n.codeRefs ?? []).length > 0) {
        details.push(
          '代码: ' +
            n.codeRefs.map((r) => r.file + (r.symbol ? '::' + r.symbol : '')).join(' | '),
        )
      }
      if ((n.interfaces ?? []).length > 0) details.push('接口: ' + n.interfaces.join(' | '))
      const openBugs = (n.bugs ?? []).filter((b) => b.status === 'open' || b.status === 'fixing')
      for (const b of openBugs) {
        const loc = b.codeRef ? ' @' + b.codeRef.file + (b.codeRef.symbol ? '::' + b.codeRef.symbol : '') : ''
        details.push('bug[' + b.status + '] ' + b.summary + loc)
      }
      if (n.notes) details.push('备注: ' + String(n.notes).split('\n')[0])
      for (const dline of details) {
        const dl = '  '.repeat(depth + 1) + '- ' + dline
        if (used + dl.length + 1 > maxChars) {
          truncated = true
          break
        }
        rendered.push(dl)
        used += dl.length + 1
      }

      for (const cid of n.children ?? []) visit(allNodes.get(cid), depth + 1)
    }
    visit(node, 0)
    lines.push(rendered.join('\n'))
  }

  return { text: lines.join('\n'), truncated, empty: false }
}

/**
 * 装配完整注入块。
 *
 * @param {{
 *   index: any,
 *   bySystem: Map<string, Map<string, import('./ledger.js').LedgerNode>>,
 *   allNodes: Map<string, import('./ledger.js').LedgerNode>,
 *   state?: any,
 *   focusId?: string,
 *   designExcerpt?: { text: string, sources: string[] } | null,
 * }} args
 */
export function assembleInjection(args) {
  const { index, bySystem, allNodes, state } = args
  const inj = index.injection ?? {}
  const parts = []
  const notes = []

  parts.push('## 开发进度台账（dsh-design-ledger）')
  parts.push(
    '本工作区存在设计文档进度台账。**开始任何开发动作前，先按此处的索引与聚焦子树确认当前位置，' +
      '完成一个功能后立刻用 `design_ledger_update` 更新对应节点**（状态 / 代码索引 / 接口 / bug）。' +
      '需要细节时用 `design_ledger_read` 或 `design_doc_read` 按需读取，不要臆测。',
  )
  parts.push(
    '台账记的是**实际开发**的功能，不是设计文档的清单：要动手做的功能先 `design_ledger_update ' +
      '{parent_id, node_name, status:"doing", mark:true}` 建节点并聚焦；设计文档里有但这一轮不做的，' +
      '先不要建空节点占位，等真要做时再建。',
  )

  // L0：任务开启提示词
  const taskPrompt = state && typeof state.taskPrompt === 'string' ? state.taskPrompt.trim() : ''
  if (inj.includeTaskPrompt !== false && taskPrompt.length > 0) {
    parts.push('')
    parts.push('### 任务开启提示词')
    parts.push(taskPrompt)
  }

  // L1：索引
  if (inj.includeIndex !== false) {
    const r = renderIndex(index, bySystem, allNodes, inj.indexMaxChars ?? 4000)
    parts.push('')
    parts.push('### 索引（系统与完成度）')
    parts.push(r.text)
    if (r.truncated) notes.push('索引因体量预算被截断')
  }

  // L2：聚焦子树
  if (inj.includeFocusSubtree !== false) {
    const marked = [...allNodes.values()].filter((n) => n.marked === true).map((n) => n.id)
    const focusIds = args.focusId ? [args.focusId, ...marked.filter((id) => id !== args.focusId)] : marked
    const r = renderFocusSubtree({ focusIds, allNodes, maxChars: inj.focusMaxChars ?? 12000 })
    if (!r.empty) {
      parts.push('')
      parts.push('### 当前聚焦子树')
      parts.push(r.text)
      if (r.truncated) notes.push('聚焦子树因体量预算被截断')
    } else {
      parts.push('')
      parts.push(
        '### 当前聚焦子树\n（未设置聚焦节点。用 `design_ledger_update` 传 `mark: true` 标记当前工作的节点。）',
      )
    }
  }

  // L3：设计文档摘录（仅当调用方显式提供）
  if (args.designExcerpt && args.designExcerpt.text) {
    parts.push('')
    parts.push('### 设计文档摘录（' + (args.designExcerpt.sources ?? []).join(', ') + '）')
    parts.push(args.designExcerpt.text)
  }

  if (notes.length > 0) {
    parts.push('')
    parts.push('> 注：' + notes.join('；') + '。完整内容请用工具按需读取。')
  }

  return { text: parts.join('\n'), notes }
}
