/**
 * 发布审计：把「工作区源码」与「GitHub 上的实际内容」逐字节比对。
 *
 * 做法：GitHub 的 tree API 给每个文件一个 blob SHA（= `sha1("blob " + size + "\0" + 内容)`），
 * 所以我们**在本地用同一算法算出每个文件的 blob SHA**，再与远端报告的值对比。
 * 相同即证明内容逐字节一致 —— 比"看 size 差不多"强得多。
 *
 * 同时做隐私体检：本机绝对路径、用户名、邮箱、密钥形态、被忽略的运行痕迹。
 *
 * 用法：
 *   node probe/publish-audit.mjs <github-tree.json> [--repo <owner/repo>]
 * 其中 <github-tree.json> 是 `GET /repos/<owner>/<repo>/git/trees/<ref>?recursive=1` 的响应。
 * 退出码非 0 = 存在不一致或隐私问题。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const treeFile = process.argv[2]
if (!treeFile) {
  console.error('用法: node probe/publish-audit.mjs <github-tree.json>')
  process.exit(2)
}

/** Git blob 哈希：`sha1("blob " + <byte length> + "\0" + <bytes>)`。 */
function gitBlobSha(rel) {
  const buf = readFileSync(join(ROOT, rel))
  return createHash('sha1')
    .update(`blob ${buf.length}\0`, 'utf8')
    .update(buf)
    .digest('hex')
}

const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(name)
}

// 注意：GitHub API 的响应可能被中间环节存成带 BOM 的 UTF-8（PowerShell 的
// Set-Content -Encoding utf8 就会加 BOM），JSON.parse 会因为 `\uFEFF` 直接报错。
// 这里主动剥掉 BOM，让审计工具对输入更宽容。
const treeRaw = readFileSync(treeFile, 'utf8').replace(/^\uFEFF/, '')
const tree = JSON.parse(treeRaw)
const remote = new Map()
for (const e of tree.tree ?? []) {
  if (e.type === 'blob') remote.set(e.path, { sha: e.sha, size: e.size })
}

/** 本地应发布的内容：git 已跟踪的文件（= 提交即发布的内容）。 */
const { execFileSync } = await import('node:child_process')
const localList = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
const local = new Set(localList)

console.log('=== 1) 内容逐字节一致（Git blob SHA 比对）===')
console.log(`  远端 blob ${remote.size} 个 / 本地已跟踪 ${local.size} 个`)
const onlyRemote = [...remote.keys()].filter((p) => !local.has(p))
const onlyLocal = [...local].filter((p) => !remote.has(p))
check('没有"远端有、本地没有"的文件', onlyRemote.length === 0, onlyRemote.join(', '))
check('没有"本地有、远端没有"的文件（都已推送）', onlyLocal.length === 0, onlyLocal.join(', '))

let mismatch = 0
let compared = 0
for (const rel of [...local].sort()) {
  const r = remote.get(rel)
  if (!r) continue
  compared += 1
  const mine = gitBlobSha(rel)
  if (mine !== r.sha) {
    mismatch += 1
    console.log(`  ❌ ${rel}\n      远端 ${r.sha}\n      本地 ${mine}`)
  }
}
check(`全部 ${compared} 个文件内容一致`, mismatch === 0, mismatch + ' 个不一致')

console.log('\n=== 2) 隐私体检：本机绝对路径 / 身份信息 ===')
const TEXT_EXT = /\.(js|mjs|json|md|yml|yaml|txt)$/i

/**
 * 体检**不扫自己**：本文件里写着用于识别的正则与示例字符串（`C:\Users\<某人>\`、
 * `sk-xxxx` 之类），扫自己会把检测规则本身报成泄漏 —— 那是纯假警报。
 * 假警报多了就会被无视，所以这里显式跳过。
 */
const SELF = 'probe/publish-audit.mjs'

/**
 * 判据的分寸（否则体检会长期误报，最后被无视）：
 *
 * **只把"真正的隐私风险"判为失败**：
 *   · 操作系统**用户名目录**（`C:\Users\<某人>\`、`/Users/<某人>/`）—— 泄漏本机账户名
 *   · 邮箱地址 —— 个人信息
 *   · 密钥/私钥形态 —— 见第 3 节
 *
 * **以下只报告、不判失败**（它们不是隐私问题）：
 *   · `D:\AppData\.dsh\profiles\...` 这类**不含用户名的**应用数据路径；
 *     出现在文档里是"本机实测"的说明，出现在 `panel-list-test.mjs` 里是**测试夹具**
 *     （要复现"部署根被当成工作区"，任何值都能验证同一逻辑）
 *   · `E:\program\dsh\dsh-design-ledger` 这类**插件自身的安装路径**，只是说明性示例
 *   · `Uloboros` 这类**公开的 GitHub 账户名**，出现在 `package.json` 的
 *     repository / homepage / bugs / author 是**正确做法**，不是泄漏
 */
const HARD_PRIVACY = [
  { re: /[A-Z]:\\{1,2}Users\\{1,2}[^\\\s"'`]+/i, what: '操作系统用户名目录' },
  { re: /\/Users\/[^/\s"'`]+/, what: '操作系统用户名目录' },
  { re: /[\w.+-]+@(?:qq|gmail|163|outlook|hotmail|foxmail)\.com/i, what: '邮箱地址' },
]
/** 报告项（不算失败）：示例性质的机器路径 / 公开账户名。 */
const SOFT_HINT = [
  { re: /[A-Z]:\\{1,2}(AppData|program)\\[^\s"'`]+/i, what: '机器路径（示例/夹具）' },
  { re: /Uloboros/, what: '公开的 GitHub 账户名' },
]

let hard = 0
let soft = 0
const seenSoft = new Set()
for (const rel of [...local].sort()) {
  if (!TEXT_EXT.test(rel) || rel === SELF) continue
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of HARD_PRIVACY) {
      if (!rule.re.test(line)) continue
      hard += 1
      console.log(`  ❌ [${rule.what}] ${rel}:${i + 1}`)
      console.log(`        ${line.trim().slice(0, 120)}`)
    }
    for (const rule of SOFT_HINT) {
      const m = rule.re.exec(line)
      if (!m) continue
      soft += 1
      const key = rule.what + '|' + rel
      if (!seenSoft.has(key)) {
        seenSoft.add(key)
        console.log(`  ℹ️  [${rule.what}] ${rel} —— 仅报告，不计失败`)
      }
    }
  }
}
check('无操作系统用户名 / 邮箱等真正隐私信息', hard === 0, hard + ' 处')
console.log(`  ℹ️ 另有 ${soft} 处示例性机器路径 / 公开账户名（按设计保留，详见脚本注释）`)

console.log('\n=== 2b) 私有语料残留 ===')
/**
 * 分两层判据，避免"一律禁"导致长期误报（误报多了就会被无视）：
 *
 * **硬性（判失败）**：`test/` 与 `probe/` 里的夹具与示例**必须完全合成化**。
 *   测试只验证"解析机制"（ID 列识别 / 名称提取 / 体量归属），绑定某个私有语料的
 *   真实目录名与条目 id 既不必要，也让仓库带着私人项目的痕迹。
 *
 * **允许（仅报告）**：`README.*` / `skills/` / `lib/` 的注释与工具描述里，
 *   为解释"目录推断规则""表格行 → 功能节点"而引用的具体例子。
 *   没有具体例子用户根本看不懂规则，所以这类引用是必要的；它们引用的是
 *   **结构命名约定**（`S0N_名称`）与**条目标题**，不含任何设计内容。
 *
 * 另外：私有**项目名**（"肉鸽"）在任何位置都不允许 —— 它标识的是哪个私有项目。
 */
const CORPUS_HARD = [
  { re: /肉鸽/, what: '私有项目名' },
  { re: /S0[1-9]_(?:core_gameplay|base_building|progression_economy|engineer_horde)/, what: '私有系统目录名' },
  { re: /\b(?:BFT|TOW|TEC|DEV|ENG)_\d{3}\b/, what: '私有条目 ID' },
  { re: /工业复兴计划|后勤保障·|卫星侦测|增强相控阵雷达|废土组装大师|加速装填机/, what: '私有设计条目名' },
]
/** 允许出现规则举例的文件（文档 / 技能 / 库注释与工具描述）。 */
const EXAMPLE_OK = /^(?:README(?:\.en)?\.md|skills\/|lib\/)/
let corpus = 0
let corpusReported = 0
for (const rel of [...local].sort()) {
  if (!TEXT_EXT.test(rel) || rel === SELF) continue
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const rule of CORPUS_HARD) {
      if (!rule.re.test(lines[i])) continue
      if (EXAMPLE_OK.test(rel)) {
        corpusReported += 1
        continue
      }
      corpus += 1
      console.log(`  ❌ [${rule.what}] ${rel}:${i + 1}`)
      console.log(`        ${lines[i].trim().slice(0, 120)}`)
    }
  }
}
check(
  'test/ 与 probe/ 中无私有语料标识（夹具均已合成化）',
  corpus === 0,
  corpus + ' 处',
)
console.log(`  ℹ️ 文档/技能/工具描述中另有 ${corpusReported} 处规则举例（按设计保留：没有例子讲不清规则）`)
// ⚠️ 必须排除本文件自身：它的检测规则里就写着这些标识，扫自己必然命中。
// （这个坑踩过两次：第一次是隐私循环，第二次是这行漏了排除。）
check('全仓库不含私有项目名', ![...local].filter((r) => r !== SELF).some((r) => /肉鸽/.test(readFileSync(join(ROOT, r), 'utf8'))))

console.log('\n=== 2c) 意料之外的上传 ===')
/** 只允许这些顶层条目出现（与 package.json 的 files / 发布意图一致）。 */
const ALLOWED_TOP = new Set([
  '.gitattributes',
  '.gitignore',
  '.github',
  'CHANGELOG.md',
  'LICENSE',
  'README.en.md',
  'README.md',
  'RELEASING.md',
  'client',
  'cordis.patch.yml',
  'lib',
  'package.json',
  'probe',
  'skills',
  'test',
])
const top = [...new Set([...local].map((p) => p.split('/')[0]))].sort()
const unexpected = top.filter((t) => !ALLOWED_TOP.has(t))
console.log('  顶层条目：' + top.join(', '))
check('没有意料之外的文件/目录被上传', unexpected.length === 0, unexpected.join(', '))

// 运行痕迹与本地状态绝不能入库（哪怕 .gitignore 写错了也要拦住）
const FORBIDDEN = ['.design-ledger/', 'DEVPLAN/', 'node_modules/', '.git/', 'state.json', 'diag.log', 'AGENTS.md']
const leakedPaths = [...local].filter((p) => FORBIDDEN.some((f) => p === f.replace(/\/$/, '') || p.startsWith(f) || p.endsWith('/' + f)))
check('无运行痕迹/台账/本地状态文件入库', leakedPaths.length === 0, leakedPaths.join(', '))

console.log('\n=== 3) 隐私体检：密钥形态 ===')
const SECRET_RE = /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/
let secrets = 0
for (const rel of [...local].sort()) {
  // 同样跳过自身：本文件里就有用于识别的密钥正则字面量。
  if (!TEXT_EXT.test(rel) || rel === SELF) continue
  if (SECRET_RE.test(readFileSync(join(ROOT, rel), 'utf8'))) {
    secrets += 1
    console.log('  ⚠️  ' + rel)
  }
}
check('无密钥/私钥形态内容', secrets === 0, secrets + ' 个文件命中')

console.log('\n=== 4) 运行痕迹不应入库 ===')
const { execFileSync: ex2 } = await import('node:child_process')
const ignored = ex2('git', ['status', '--ignored', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((l) => l.startsWith('!!'))
  .map((l) => l.slice(3).trim())
console.log('  被忽略的路径：' + (ignored.join(', ') || '(无)'))
check('本机运行痕迹（.design-ledger / DEVPLAN / node_modules）未入库', !localList.some((p) => p.startsWith('.design-ledger/') || p.startsWith('DEVPLAN/') || p.startsWith('node_modules/')))
check('被忽略的路径都不在已跟踪列表里', ignored.every((p) => !local.has(p)))

console.log('\n=== 5) 发布元数据 ===')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check('repository 指向正确仓库', /Uloboros\/dsh-design-ledger/.test(JSON.stringify(pkg.repository)), JSON.stringify(pkg.repository))
check('无 <your-github-username> 占位符残留', !JSON.stringify(pkg).includes('<your-github-username>'))
check('LICENSE 存在且被跟踪', existsSync(join(ROOT, 'LICENSE')) && local.has('LICENSE'))
check('CI workflow 已入库', local.has('.github/workflows/ci.yml'))

console.log('\n' + (failures.length === 0 ? '发布审计通过 ✅' : '审计发现 ' + failures.length + ' 项问题 ❌：' + failures.join(' | ')))
process.exitCode = failures.length === 0 ? 0 : 1
