#!/usr/bin/env node
/**
 * 发布包内容审计：tarball 里**只允许**出现 package.json 的 `files` 白名单列出的内容
 * （外加 npm 强制包含的 package.json / README / LICENSE 等）。
 *
 * 为什么单独抽成文件、并挂进发布 workflow：
 *   起因是 Release 在 CI 上失败，报 "tarball 内出现不该有的路径：.design-ledger"，
 *   而这台开发机上 `.design-ledger/` 恰好不存在 —— **本地永远复现不出来**。
 *   更麻烦的是原来的 bash 自检用 `grep -q` 只回报"哪条黑名单命中"，不回报**命中了哪条路径**，
 *   于是无法判断是真打进了运行痕迹、还是判据本身误报。所以这里改成：
 *
 *     1. **白名单判据**：凡是"不在 `files` 里、也不是 npm 强制包含项"的条目一律失败 ——
 *        比黑名单更强：任何意料之外的东西都拦得住，不只是我想到的那几个；
 *     2. **精确匹配路径分量**（`.design-ledger/` 作为一段路径），不再用子串包含，
 *        避免"README 里提到该字样"之类的误报；
 *     3. **失败时打印完整清单**，让日志自带证据，不必再猜。
 *
 * 用法：node probe/pack-audit.mjs <tarball 路径 | ->      （`-` 表示从 stdin 读 tar 流）
 * 退出码非 0 = 发布包内容不合规，不要发布。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读取 tar 内的路径清单（保留完整路径原文，便于报错）。 */
function listTar(source, useStdin) {
  if (useStdin) {
    const buf = readFileSync(0)
    const out = execFileSync('tar', ['-tf', '-'], { input: buf, maxBuffer: 64 * 1024 * 1024 })
    return out.toString('utf8')
  }
  return execFileSync('tar', ['-tf', source], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** npm 无视 `files` 也会包含的项（包根下的固定清单）。 */
const ALWAYS_INCLUDED = new Set([
  'package.json',
  'README.md',
  'README',
  'LICENSE',
  'LICENCE',
  'CHANGELOG.md',
  'CHANGELOG',
  'npm-shrinkwrap.json',
])

function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('用法: node probe/pack-audit.mjs <tarball 路径 | ->')
    process.exit(2)
  }
  const fromStdin = arg === '-'
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  const raw = listTar(arg, fromStdin)
  const entries = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // 去掉 npm 统一加的 "package/" 前缀，得到包内相对路径
  const rel = entries.map((e) => (e.startsWith('package/') ? e.slice('package/'.length) : e)).filter((e) => e !== '')

  const filesField = Array.isArray(pkg.files) ? pkg.files : []
  /** 是否被 `files` 白名单允许：目录前缀匹配，或精确文件匹配。 */
  const allowedByFiles = (p) =>
    filesField.some((f) => {
      const norm = String(f).replace(/^\.\//, '').replace(/\/$/, '')
      return p === norm || p.startsWith(norm + '/')
    })

  const allowed = (p) => allowedByFiles(p) || ALWAYS_INCLUDED.has(p)

  // 目录条目（以 / 结尾）也一并检查：空目录不该出现在发布包里
  const offenders = rel.filter((p) => !allowed(p))
  /** 运行痕迹（独立于白名单再报一次，给出更明确的原因）。 */
  const RESIDUE = ['.design-ledger', 'DEVPLAN', 'node_modules', '.git', '.github', 'AGENTS.md']
  const residueHits = rel.filter((p) =>
    RESIDUE.some((r) => p === r || p.startsWith(r + '/') || p.split('/').includes(r)),
  )

  console.log('发布包内容审计')
  console.log('  条目总数      = ' + entries.length)
  console.log('  白名单来源    = package.json 的 files (' + filesField.length + ' 项) + npm 固定项')
  console.log('')
  console.log('  完整清单:')
  for (const e of entries) console.log('    ' + e)
  console.log('')

  let failed = false
  if (residueHits.length > 0) {
    failed = true
    console.log('  ❌ 发现本机运行痕迹（绝不允许随发布包分发）:')
    for (const p of residueHits) console.log('       ' + p)
  } else {
    console.log('  ✅ 无本机运行痕迹（.design-ledger / DEVPLAN / node_modules / .git / .github / AGENTS.md）')
  }

  if (offenders.length > 0) {
    failed = true
    console.log('  ❌ 出现不在 files 白名单里的条目:')
    for (const p of offenders) console.log('       ' + p)
    console.log('       （要么删掉它，要么显式加入 package.json 的 files）')
  } else {
    console.log('  ✅ 全部条目都在 files 白名单内')
  }

  // 关键文件必须在（否则包不可用）
  const REQUIRED = ['lib/index.js', 'client/client.js', 'package.json', 'cordis.patch.yml']
  const missing = REQUIRED.filter((r) => !rel.includes(r))
  if (missing.length > 0) {
    failed = true
    console.log('  ❌ 缺少发布必需文件: ' + missing.join(', '))
  } else {
    console.log('  ✅ lib/index.js / client/client.js / package.json / cordis.patch.yml 均在包内')
  }

  console.log('')
  console.log(failed ? '发布包审计失败 ❌' : '发布包审计通过 ✅')
  process.exitCode = failed ? 1 : 0
}

main()
