/**
 * README 体检：结构对齐 + 代码围栏成对 + 内部链接可解析。
 *
 * 为什么需要：两版 README 是手工维护的对照文本，重排/翻译都可能把 ``` 拆散、
 * 或让链接指向不存在的小节 —— 这类问题在 GitHub 上表现为"半篇变代码块"，肉眼很难发现。
 *
 * 用法：node probe/readme-check.mjs
 * 退出码非 0 = 体检不通过。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ZH = 'README.md'
const EN = 'README.en.md'

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(name)
}

const read = (f) => readFileSync(join(ROOT, f), 'utf8')

/** 围栏计数（``` 与 ~~~ 都算，且忽略行内三个反引号的极少数情况）。 */
function fenceCount(text) {
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```+|~~~+)/.test(line)) n += 1
  }
  return n
}

/** 收集标题与其 GitHub 风格锚点。 */
function headings(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const title = m[2].replace(/\s+#+\s*$/, '').trim()
    const slug = title
      .toLowerCase()
      .replace(/[`*_~()[\]{}:,.!?'"，。！？：；、（）【】]/g, '')
      .replace(/\s+/g, '-')
    out.push({ level: m[1].length, title, slug })
  }
  return out
}

console.log('=== 1) 结构对齐 ===')
const zhText = read(ZH)
const enText = read(EN)
const zhHeads = headings(zhText)
const enHeads = headings(enText)
check('两版标题数一致', zhHeads.length === enHeads.length, `zh=${zhHeads.length} en=${enHeads.length}`)
check(
  '两版标题层级逐一对齐',
  zhHeads.every((h, i) => enHeads[i] && h.level === enHeads[i].level),
)

console.log('\n=== 2) 代码围栏成对（重排最易破坏点）===')
for (const f of [ZH, EN]) {
  const n = fenceCount(read(f))
  check(f + ' 围栏数为偶数', n % 2 === 0, '实际 ' + n)
}
const zhBlocks = fenceCount(zhText) / 2
const enBlocks = fenceCount(enText) / 2
check('两版代码块数量一致', zhBlocks === enBlocks, `zh=${zhBlocks} en=${enBlocks}`)

console.log('\n=== 3) 内部链接可解析 ===')
/** 同文件锚点 `#abc` 与同目录文件链接 `README.en.md`。 */
const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g
const enSlugs = new Set(enHeads.map((h) => h.slug))
const zhSlugs = new Set(zhHeads.map((h) => h.slug))
for (const [file, slugs] of [
  [ZH, zhSlugs],
  [EN, enSlugs],
]) {
  const text = read(file)
  let anchors = 0
  let files = 0
  for (const m of text.matchAll(linkRe)) {
    const target = m[2].trim()
    if (target.startsWith('#')) {
      anchors += 1
      const slug = target.slice(1)
      if (!slugs.has(slug)) {
        check(`${file} 锚点 #${slug}`, false, '标题里找不到对应 slug')
      }
    } else if (!/^[a-z]+:/i.test(target)) {
      files += 1
      const path = target.split('#')[0]
      if (path && !existsSync(join(ROOT, path))) check(`${file} 链接 ${path}`, false, '文件不存在')
    }
  }
  console.log(`  ℹ️ ${file}: 同文件锚点 ${anchors} 个、相对文件链接 ${files} 个`)
}
check('语言切换链接双向存在', zhText.includes('(README.en.md)') && /\]\(README(\.[a-z]{2})?\.md\)/.test(enText))
// 两版互为入口：中文版是 README.md（GitHub 默认展示），英文版指向它。
// 若日后改名为 README.zh.md，请同时更新英文版的链接与该断言，不要留下死链。
const enBack = /\]\((README(?:\.[a-z]{2})?\.md)\)/.exec(enText)
check('英文版回链指向真实存在的文件', Boolean(enBack) && existsSync(join(ROOT, enBack[1])), enBack ? enBack[1] : '未找到回链')

console.log('\n=== 4) 发布必需项 ===')
const pkg = JSON.parse(read('package.json'))
check('files 覆盖两版 README', pkg.files.includes('README.md') && pkg.files.includes('README.en.md'), JSON.stringify(pkg.files))
for (const need of ['license', 'description', 'keywords']) {
  check('package.json 有 ' + need, Boolean(pkg[need]))
}

// 仓库元数据：缺失或仍是占位符都算"未就绪"，但**不算体检失败** ——
// 占位符是交给维护者替换的正常中间状态，把它判成失败会让 CI 无谓报红。
const repoFields = ['repository', 'homepage', 'bugs', 'author']
const missing = repoFields.filter((k) => !pkg[k])
const placeholder = repoFields.filter((k) => JSON.stringify(pkg[k] ?? '').includes('<your-github-username>'))
if (missing.length > 0) console.log('  ⚠️  缺少仓库元数据：' + missing.join(' / ') + '（发 GitHub 前请补上）')
if (placeholder.length > 0) {
  console.log('  ⚠️  仍是占位符：' + placeholder.join(' / '))
  console.log('      → 把 package.json 里的 <your-github-username> 换成你的 GitHub 用户名（共 3 处）')
}
if (missing.length === 0 && placeholder.length === 0) console.log('  ✅ 仓库元数据齐备（无占位符）')

// CI 必须只跑零依赖脚本：probe/* 需要本机 DSH 依赖层，在 runner 上必失败
const ciPath = join(ROOT, '.github', 'workflows', 'ci.yml')
if (existsSync(ciPath)) {
  const ci = readFileSync(ciPath, 'utf8')
  check('CI 不调用 probe/*（探针需要本机 DSH 依赖层）', !/npm run (contract|probe:)/.test(ci))
  check(
    'CI 覆盖语法检查 / 单测 / 文档体检 / 客户端体检',
    /npm run check\b/.test(ci) && /npm test/.test(ci) && /check:readme/.test(ci) && /check:client/.test(ci),
  )
} else {
  console.log('  ℹ️ 未发现 .github/workflows/ci.yml（可选）')
}

console.log('\n' + (failures.length === 0 ? '体检通过 ✅' : '失败 ' + failures.length + ' 项 ❌：' + failures.join(' | ')))
process.exitCode = failures.length === 0 ? 0 : 1
