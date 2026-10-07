/**
 * 发版 workflow 自检：把 `.github/workflows/release.yml` 里**真正会被执行**的部分
 * 在本地跑一遍（不联网、不建 Release），提前发现会卡住发布的错误。
 *
 * 为什么需要：失败的发版 workflow 只能在 GitHub 上试错，一轮几分钟且容易漏看日志；
 * 而这些步骤（版本解析、notes 抽取、tarball 内容自检）**全是纯本地的**，可以预先验证。
 *
 * 检查项：
 *   1. `package.json` 的 version 与将要发布的版本一致（workflow 里有一道同样的校验）
 *   2. CHANGELOG 里存在对应版本小节（否则 Release 正文会空）
 *   3. CHANGELOG 的引用式链接不再有 OWNER 之类的占位符
 *   4. `npm pack` 产物内容不含运行痕迹（与 workflow 里的 grep 自检同款）
 *   5. `release.yml` 的关键步骤齐全（零依赖校验 / 打 tag / 打包 / 建 Release）
 *
 * 用法：node probe/release-check.mjs
 * 退出码非 0 = 发布前必须先修。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(name)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const tag = 'v' + version
console.log(`=== 发布目标：${pkg.name}@${version} （tag ${tag}）===`)

console.log('\n=== 1) 版本与 CHANGELOG ===')
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
check(`CHANGELOG 有 ${version} 小节`, new RegExp('^## \\[' + version.replace(/\./g, '\\.') + '\\]', 'm').test(changelog))
const placeholder = /^\[[^\]]+\]:\s*https?:\/\/github\.com\/(OWNER|<[^>]+>)/m.exec(changelog)
check('CHANGELOG 引用式链接无占位符', placeholder === null, placeholder ? placeholder[0] : '')

// 模拟 workflow 的 notes 抽取（awk 等价实现），确认正文非空
function extractNotes(text, v) {
  const lines = text.split(/\r?\n/)
  const out = []
  let inside = false
  for (const line of lines) {
    if (new RegExp('^## \\[' + v.replace(/\./g, '\\.') + '\\]').test(line)) {
      inside = true
      continue
    }
    if (inside && /^## \[/.test(line)) break
    if (inside) out.push(line)
  }
  return out.filter((l) => !/^\[.*\]: http/.test(l)).join('\n').trim()
}
const notes = extractNotes(changelog, version)
check('发布正文抽取结果非空', notes.length > 0, notes.length + ' 字符')

console.log('\n=== 2) tarball 内容自检（与 workflow 同款 grep）===')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-relcheck-'))
try {
  // Windows 上 npm 是 .cmd，需要 shell 才能找到；但**不要把参数交给 shell**
  //（Node 会为此发 DEP0190 弃用警告，且参数不会被转义）。
  // 这里改用 `node <npm-cli.js> pack`，既跨平台又无需 shell。
  const npmCli = process.env.npm_execpath
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', tmp], { cwd: ROOT, stdio: 'ignore' })
  } else {
    execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: ROOT, stdio: 'ignore', shell: true })
  }
  const tgz = execFileSync('node', ['-e', `const fs=require('fs');console.log(fs.readdirSync(${JSON.stringify(tmp)}).find(f=>f.endsWith('.tgz')))`], { encoding: 'utf8' }).trim()
  const list = execFileSync('tar', ['-tzf', join(tmp, tgz)], { encoding: 'utf8' })
  // 用与 workflow **同一个**审计脚本（probe/pack-audit.mjs）判定，避免两处判据漂移：
  // 白名单 + 运行痕迹 + 必需文件，失败时它会打印完整清单。
  const tgzPath = join(tmp, tgz)
  let packOk = true
  let packOut = ''
  try {
    packOut = execFileSync(process.execPath, [join(ROOT, 'probe', 'pack-audit.mjs'), tgzPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    packOk = false
    packOut = String((e && (e.stdout || e.message)) || e)
  }
  check('tarball 通过内容审计（白名单 + 无运行痕迹 + 必需文件）', packOk, packOk ? '' : '见下')
  if (!packOk) console.log(packOut)
  const entries = execFileSync('tar', ['-tf', tgzPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  console.log('  ℹ️ 文件数 = ' + entries.trim().split('\n').length + '，产物 = ' + tgz)
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('\n=== 3) release.yml 关键步骤 ===')
const wfPath = join(ROOT, '.github', 'workflows', 'release.yml')
if (!existsSync(wfPath)) {
  check('release.yml 存在', false)
} else {
  const wf = readFileSync(wfPath, 'utf8')
  check('由 workflow_dispatch 手动触发（避开 GITHUB_TOKEN 的 tag 递归限制）', /workflow_dispatch:/.test(wf))
  check('权限含 contents: write', /contents:\s*write/.test(wf))
  check('发版前跑零依赖校验', /npm run check && npm test/.test(wf))
  check('打 tag 并推送', /git tag -a/.test(wf) && /git push origin/.test(wf))
  check('用 npm pack 构建 tarball', /npm pack/.test(wf))
  check('建 Release 并附上 .tgz', /gh release create/.test(wf) && /\$\{\{ steps\.pack\.outputs\.tgz \}\}/.test(wf))
  check('校验 package.json 与输入版本一致', /与 package\.json 的/.test(wf))
  check('用 pack-audit 做白名单审计（失败时打印完整清单）', /probe\/pack-audit\.mjs/.test(wf))
}

console.log('\n' + (failures.length === 0 ? '发版前自检通过 ✅' : '失败 ' + failures.length + ' 项 ❌：' + failures.join(' | ')))
process.exitCode = failures.length === 0 ? 0 : 1
