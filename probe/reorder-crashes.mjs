/**
 * 一次性维护脚本：把两版 README 里的「崩溃 N / Crash N」小节统一重排为**升序**。
 *
 * 为什么需要：这些小节是排查过程中陆续追加的，实际顺序成了 7,5,6,3,4,1,2；
 * 公开发布时按编号升序更易读。重排只动小节的先后，**正文一字不改**。
 *
 * 用法：node probe/reorder-crashes.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILES = ['README.md', 'README.en.md']
const checkOnly = process.argv.includes('--check')

/** 小节标题里的编号：中文 `### 崩溃 5：…` / 英文 `### Crash 5: …`。 */
const NUM_RE = /^### (?:Crash|崩溃) (\d+)/

function reorder(file) {
  const src = readFileSync(file, 'utf8')
  const marker = '## ⚠️'
  const at = src.indexOf(marker)
  if (at < 0) {
    console.log(file + ': 未找到坑位小节（## ⚠️）')
    return false
  }
  const head = src.slice(0, at)
  const rest = src.slice(at)
  // 按 "### " 行切块；切出来就是「前言 + 各小节」的原始顺序
  const parts = rest.split(/\n(?=### )/)
  const preamble = parts.shift()
  const crash = []
  const other = []
  for (const p of parts) {
    const m = NUM_RE.exec(p)
    if (m) crash.push({ raw: p, num: Number(m[1]) })
    else other.push(p) // 非崩溃的 ### 小节（如「验证顺序」）保持在后
  }
  crash.sort((a, b) => a.num - b.num)
  const out = head + [preamble, ...crash.map((c) => c.raw), ...other].join('\n')
  const order = crash.map((c) => c.num).join(',')
  if (out === src) {
    console.log('  ' + file + ': 已是升序 (' + order + ')，未改动')
    return false
  }
  if (checkOnly) {
    console.log('  ' + file + ': ❌ 需要重排，当前顺序 ' + order)
    return true
  }
  writeFileSync(file, out, 'utf8')
  console.log('  ' + file + ': ✅ 已按升序重排 -> ' + order)
  return true
}

let changed = 0
for (const f of FILES) if (reorder(f)) changed += 1
console.log(checkOnly ? (changed === 0 ? '全部已是升序 ✅' : changed + ' 个文件需要重排 ❌') : '完成')
process.exitCode = checkOnly && changed > 0 ? 1 : 0
