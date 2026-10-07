/**
 * AGENTS.md 联动测试：托管块必须
 *   1. 首次写入时不破坏（不存在则创建）
 *   2. 幂等：重复写入不累积
 *   3. **绝不覆盖块外的用户内容**
 *   4. 用户删掉标签后仍可再次接管（追加新托管块）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BEGIN, END, findManagedBlock, renderAgentsBlock, stripManagedBlock, syncAgentsFile } from '../lib/agents-md.js'

const base = {
  designInput: 'E:/proj/design-docs',
  ledgerDir: 'DEVPLAN',
  systemList: [{ id: 's1', name: '核心玩法系统' }],
  totals: { files: 19, chars: 226885, tokens: 132141 },
}

test('syncAgentsFile：创建、幂等、不覆盖用户内容', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dl-agents-'))
  try {
    const file = join(ws, 'AGENTS.md')

    // 1) 首次：文件不存在 → 创建
    const r1 = await syncAgentsFile({ ...base, workspaceRoot: ws })
    assert.equal(r1.ok, true)
    assert.equal(r1.created, true)
    assert.equal(r1.replaced, false)
    let text = await readFile(file, 'utf8')
    assert.ok(text.includes(BEGIN) && text.includes(END))
    assert.ok(text.includes('核心玩法系统'))
    assert.ok(text.includes('132k tokens'))

    // 2) 幂等：再写一次，托管块只有一份，且不重复累积
    const r2 = await syncAgentsFile({ ...base, workspaceRoot: ws })
    assert.equal(r2.created, false)
    assert.equal(r2.replaced, true)
    const text2 = await readFile(file, 'utf8')
    assert.equal((findManagedBlock(text2) || {}).count, 1, '托管块必须只有一份')
    assert.equal(text2.length, text.length, '同参数重复写入应逐字节一致')

    // 3) 用户内容保留 + 内容更新
    await writeFile(file, '# 我的项目手记\n\n这段是用户手写内容，绝不能被覆盖。\n\n' + text2, 'utf8')
    const r3 = await syncAgentsFile({
      ...base,
      workspaceRoot: ws,
      systemList: [{ id: 's1', name: '核心玩法系统' }, { id: 's2', name: '基地系统' }],
    })
    assert.equal(r3.ok, true)
    const text3 = await readFile(file, 'utf8')
    assert.ok(text3.includes('这段是用户手写内容，绝不能被覆盖。'), '用户内容必须原样保留')
    assert.equal((findManagedBlock(text3) || {}).count, 1, '仍只有一份托管块')
    assert.ok(text3.includes('基地系统'), '系统清单应已更新')

    // 4) 用户删掉标签 → 再次写入会追加新的托管块（首次接管路径）
    await writeFile(file, '# 只有用户内容\n', 'utf8')
    const r4 = await syncAgentsFile({ ...base, workspaceRoot: ws })
    assert.equal(r4.created, false)
    assert.equal(r4.replaced, false)
    const text4 = await readFile(file, 'utf8')
    assert.ok(text4.includes('# 只有用户内容'))
    assert.equal((findManagedBlock(text4) || {}).count, 1)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('renderAgentsBlock：包含纪律要点与可移除说明', () => {
  const b = renderAgentsBlock(base)
  assert.ok(b.startsWith(BEGIN))
  assert.ok(b.endsWith(END))
  assert.ok(b.includes('design_ledger_status'))
  assert.ok(b.includes('只记文件+符号名'))
  assert.ok(b.includes('design_doc_read'))
  assert.ok(b.includes('删除'), '应说明删除标签即接管')
})

test('findManagedBlock：行内引用不影响边界定位', () => {
  const text = '引用 ' + BEGIN + ' 与 ' + END + ' 的行内文字\n\n' + BEGIN + '\n正文\n' + END + '\n\n尾部\n'
  const b = findManagedBlock(text)
  assert.ok(b, '应找到托管块')
  assert.equal(b.count, 1, '只应计一个托管块')
  const s = stripManagedBlock(text)
  assert.ok(s.stripped)
  assert.ok(s.text.includes('行内文字'), '行内引用的文字应保留')
  assert.ok(s.text.includes('尾部'), '尾部内容应保留')
  assert.ok(!s.text.includes('正文'), '托管块正文应被剥离')
})
