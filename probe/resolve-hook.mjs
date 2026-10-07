/**
 * 解析钩子：把 `@deepseek-ai/*` 指向 profile 共享层的安装版，复现 DSH 的
 * linked-package runtime resolution（只路由插件在 peerDependencies 里声明过的名字）。
 *
 * 依赖层位置**不写死**：探针要在别人的机器上也能跑，所以按下面的顺序解析 DSH 的
 * "profile 共享依赖层"目录，并在解析不出来时**明确报错**（而不是静默退化成普通解析 ——
 * 那样探针会看起来在跑、其实少测了整条解析链路）。
 *
 *   1. `DSH_SHARED_NODE_MODULES`  —— 直接给出共享层目录（最精确）
 *   2. `DSH_HOME`（或 `~/.dsh`）+ `DSH_PROFILE`  —— 拼出 `<home>/profiles/<profile>/node_modules`，
 *      再退到 `<home>/profiles/node_modules`（本机实测共享层在后者）
 *   3. 都没有 → 抛错并打印设置方法
 *
 * 例（Windows PowerShell）：
 *   $env:DSH_SHARED_NODE_MODULES = 'D:\AppData\.dsh\profiles\node_modules'
 *   node --import ./probe/register.mjs probe/contract-test.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本插件目录（本文件在 <plugin>/probe/ 下）。 */
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析 profile 共享依赖层目录。
 *
 * ⚠️ 不能"存在即采用"：本机 `profiles/desktop/node_modules` 与 `profiles/node_modules`
 * **都存在**，但 harness 包（`@deepseek-ai/dsh-tools` 等）只装在**共享层**
 * `profiles/node_modules` 里。所以判定标准是"这个目录里真的有 harness 包"，
 * 而不是"这个目录存在"—— 否则会在第一个候选上就失败（本机实测踩过）。
 *
 * @returns {string} 含 harness 包的目录
 * @throws 找不到时抛错，附带设置方法（绝不静默退化成普通解析）
 */
function resolveSharedLayer() {
  const tried = []
  const env = process.env

  /** 该目录是否真的有 harness 包。 */
  const hasHarness = (dir) => existsSync(join(dir, '@deepseek-ai', 'dsh-tools'))
  const consider = (dir) => {
    if (!dir) return null
    tried.push(dir)
    return hasHarness(dir) ? dir : null
  }

  // 1) 显式指定（最精确）。⚠️ 显式指定是**权威**的：指错了要立刻报错，
  //    绝不能悄悄回退到自动探测 —— 否则用户以为在用自己指的那个目录，实际不是。
  if (env.DSH_SHARED_NODE_MODULES) {
    const dir = env.DSH_SHARED_NODE_MODULES
    if (hasHarness(dir)) return dir
    throw new Error(
      '[resolve-hook] DSH_SHARED_NODE_MODULES 指向的目录里没有 @deepseek-ai/dsh-tools：\n' +
        '    ' + dir + '\n' +
        '  请确认它指向 DSH 的依赖目录（内含 @deepseek-ai/），或清掉该环境变量改用自动探测。',
    )
  }

  // 2) 从 DSH_HOME / DSH_PROFILE 推导：共享层优先于 profile 自己的 node_modules
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const profile = env.DSH_PROFILE
  const shared = consider(join(home, 'profiles', 'node_modules'))
  if (shared) return shared
  if (profile) {
    const own = consider(join(home, 'profiles', profile, 'node_modules'))
    if (own) return own
  }
  const desktop = consider(join(home, 'profiles', 'desktop', 'node_modules'))
  if (desktop) return desktop

  throw new Error(
    '[resolve-hook] 找不到装了 @deepseek-ai/* 的 DSH 依赖目录。\n' +
      '  试过（只采纳其中真正含 @deepseek-ai/dsh-tools 的）：\n' +
      tried.map((t) => '    · ' + t).join('\n') +
      '\n  请显式指定，例如：\n' +
      "    PowerShell: $env:DSH_SHARED_NODE_MODULES = '<你的 DSH 依赖目录>'\n" +
      "    bash:       export DSH_SHARED_NODE_MODULES='<your DSH deps dir>'\n" +
      '  通常位于 <DSH_HOME>/profiles/node_modules（共享层）或 <DSH_HOME>/profiles/<profile>/node_modules。',
  )
}

const SHARED = resolveSharedLayer()

/** 本插件在 package.json 里声明过的 harness 依赖（只路由这些名字）。 */
let declared = new Set()
try {
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  declared = new Set([...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.dependencies ?? {})])
} catch {
  /* ignore */
}

/** 依据包 package.json 推断入口候选。 */
function entryCandidates(pkgDir) {
  const out = []
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const exp = pkg.exports
    if (typeof exp === 'string') out.push(exp)
    else if (exp && typeof exp === 'object') {
      const root = exp['.'] ?? exp
      const d = typeof root === 'string' ? root : root && (root.default ?? root.import ?? root.require)
      if (typeof d === 'string') out.push(d)
      else if (d && typeof d === 'object' && typeof d.default === 'string') out.push(d.default)
    }
    if (typeof pkg.module === 'string') out.push(pkg.module)
    if (typeof pkg.main === 'string') out.push(pkg.main)
  } catch {
    /* ignore */
  }
  // 注意：必须读各包自己的 package.json 找真实入口，不能硬编码 lib/index.js
  //（schemastery 这类包的入口不是 lib/index.js —— 硬编码会制造假错误）
  out.push('lib/index.js', 'index.js', 'dist/index.js', 'lib/index.mjs', 'index.mjs')
  return [...new Set(out)]
}

/**
 * 模块解析钩子入口。
 *
 * ⚠️ 函数名不能叫 `resolve`：本文件从 `node:path` 导入了 `resolve`，同名会直接
 * `SyntaxError: Identifier 'resolve' has already been declared`。Node 的钩子只看
 * **导出名**必须叫 `resolve`，所以这里用别名导出。
 */
async function resolveHook(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/') && declared.has(specifier)) {
    const pkgDir = join(SHARED, ...specifier.split('/'))
    for (const rel of entryCandidates(pkgDir)) {
      const file = join(pkgDir, ...rel.split('/'))
      try {
        return await nextResolve(pathToFileURL(file).href, context)
      } catch {
        /* 试下一个候选 */
      }
    }
    console.error('[resolve-hook] 全部候选失败: ' + specifier + ' @ ' + pkgDir)
  }
  return nextResolve(specifier, context)
}

export { resolveHook as resolve }
