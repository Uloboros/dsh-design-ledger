/**
 * 客户端半区体检：字典完整性 + 语言切换解析。
 *
 * 为什么需要（这两个问题都是用户实测报出来的）：
 *   1. **按钮 hover 白底白字** —— CSS 用了 `--dsw-alias-bg-layer-2` 当 hover 底色，
 *      而它在浅色主题下就是纯白（官方 token 实测：浅色 `#fff`）。主按钮底色/文字又是
 *      硬编码的，两者特异性相同，hover 一旦覆盖底色就变成白底白字。
 *   2. **界面不跟随 DSH 语言** —— 槽位没声明 `locale` 命名空间，渲染器就不会注入
 *      响应式的 `t` 席位（`standardKit()` 里 `if (entry.locale !== undefined)`）。
 *
 * 本探针把两件事都变成可断言的：
 *   · 两套字典键集完全一致、且**代码里用到的每个 key 都有翻译**（漏一个就会出现原始 key）
 *   · 解析出的文案在 en / zh 下都非空、且 en 下确实是英文（不是回退成中文）
 *   · CSS 里不再出现浅色主题下为纯白的 `--dsw-alias-bg-layer-2` 作为交互底色
 *   · 主按钮的 hover 有独立规则（不被通用 hover 覆盖）
 *
 * 用法：node --import ./probe/register.mjs probe/client-ui-test.mjs
 * 退出码非 0 = 体检不通过。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures.push(name)
}

/** 抓取客户端文件里 factory 作用域的源码（含 zh / en 两套字典与 CSS）。 */
const src = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')

/**
 * 去掉注释后的代码。
 *
 * 为什么必须去注释再断言：本文件的注释里**大量引用**了这些模式本身
 * （例如"因此不能再自己 `inject: () => ({ t })`"），直接对原文匹配会把
 * **说明文字**当成**真实代码**，产生假警报（本探针第一版就误报过一次）。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

const code = stripComments(src)

/** 用 Function 把两套字典与 CSS 求值出来（它们都是纯字面量，无外部依赖）。 */
function extractConst(name) {
  const re = new RegExp('const ' + name + ' = (\\{[\\s\\S]*?\\n    \\}|\\[[\\s\\S]*?\\]\\.join\\(\'\'\\))', 'm')
  const m = re.exec(src)
  if (!m) return null
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[1] + ')')()
}

const zh = extractConst('zh')
const en = extractConst('en')
const CSS = extractConst('CSS')

console.log('=== 1) 两套字典与 CSS 能否解析 ===')
check('解析出 zh 字典', !!zh && typeof zh === 'object', zh ? Object.keys(zh).length + ' 个 key' : 'null')
check('解析出 en 字典', !!en && typeof en === 'object', en ? Object.keys(en).length + ' 个 key' : 'null')
check('解析出 CSS', typeof CSS === 'string' && CSS.length > 0, typeof CSS === 'string' ? CSS.length + ' 字符' : typeof CSS)

if (zh && en) {
  console.log('\n=== 2) 字典完整性 ===')
  const zk = Object.keys(zh).sort()
  const ek = Object.keys(en).sort()
  const onlyZh = zk.filter((k) => !ek.includes(k))
  const onlyEn = ek.filter((k) => !zk.includes(k))
  check('zh / en 键集一致', onlyZh.length === 0 && onlyEn.length === 0, '仅 zh: ' + onlyZh.join(',') + ' | 仅 en: ' + onlyEn.join(','))

  // 代码里用到的 key：t('xxx') / t("xxx")
  const used = new Set()
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) used.add(m[1])
  const missing = [...used].filter((k) => !(k in zh) || !(k in en))
  check('代码用到的每个 key 都有 zh/en 翻译', missing.length === 0, '缺失: ' + missing.join(', '))
  console.log(`  ℹ️ 代码里用到 ${used.size} 个 key；字典共 ${zk.length} 个`)

  // 英文版必须真的是英文（不能与中文相同，否则等于没翻译）
  const sameAsZh = zk.filter((k) => en[k] === zh[k])
  check('en 字典没有"照抄中文"的条目', sameAsZh.length === 0, '可疑: ' + sameAsZh.join(', '))

  console.log('\n=== 3) 语言解析（模拟框架 t 席位的行为）===')
  /** 框架的 t 在查不到时返回 key；我们的兜底只在"查不到"时生效。 */
  const resolve = (dict, k) => {
    const fromSeat = dict[k]
    const text = typeof fromSeat === 'string' ? fromSeat : ''
    return text.length > 0 && text !== k ? text : zh[k] ?? k
  }
  const keys = zk
  const enAllEnglish = keys.every((k) => {
    const v = resolve(en, k)
    return v.length > 0 && v !== k
  })
  check('en 下所有 key 都能解析出非空文案', enAllEnglish)
  check('en 下 nav 显示为英文', resolve(en, 'nav') === en.nav, resolve(en, 'nav'))
  check('zh 下 nav 显示为中文', resolve(zh, 'nav') === zh.nav, resolve(zh, 'nav'))
  // 未注册字典的极端情况：必须回退到 zh 而不是显示 key
  check('字典缺失时回退到中文而非显示 key', resolve({}, 'bindOk') === zh.bindOk, resolve({}, 'bindOk'))
}

if (typeof CSS === 'string') {
  console.log('\n=== 4) 按钮配色（用户报的 hover 白底白字）===')
  check('交互底色不再使用 bg-layer-2（浅色主题下 = 纯白 #fff）', !/:(?:hover|active)[^{]*\{[^}]*--dsw-alias-bg-layer-2/.test(CSS))
  check('列表行 hover 用官方 interactive-bg-hover', /\.dlg-row:hover\{background:var\(--dsw-alias-interactive-bg-hover/.test(CSS))
  check('普通按钮 hover 用官方 interactive-bg-hover', /\.dlg-btn:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover/.test(CSS))
  check('主按钮底色用官方 button-primary-fill', /\.dlg-primary\{[^}]*--dsw-alias-button-primary-fill/.test(CSS))
  check('主按钮文字用官方 label-primary-foreground', /\.dlg-primary\{[^}]*--dsw-alias-label-primary-foreground/.test(CSS))
  check('主按钮 hover 有独立规则（不被通用 hover 覆盖）', /\.dlg-primary:hover:not\(:disabled\)\{background:var\(--dsw-alias-button-primary-hover/.test(CSS))
  check('主按钮文字不再是硬编码 #fff', !/\.dlg-primary\{[^}]*color:#fff/.test(CSS))
  check('禁用态不会触发 hover 变色', /:hover:not\(:disabled\)/.test(CSS))
}

console.log('\n=== 5) 槽位 locale 接线 ===')
// 一律对**去注释后的代码**断言，避免把注释里的举例当成真实代码。
check('sidebar.panellist 声明了 locale 命名空间', /name: 'sidebar\.panellist'[\s\S]{0,400}?locale: LOCALE_NS/.test(code))
check('main 槽位声明了 locale 命名空间', /name: 'main'[\s\S]{0,200}?locale: LOCALE_NS/.test(code))
check('不再自注入 t（会与框架席位重复 prop 而抛错）', !/inject:\s*\(\)\s*=>\s*\(\{\s*t\s*\}\)/.test(code))
check('注册了两套字典', /ctx\.locale\.register\(LOCALE_NS,\s*\{\s*zh,\s*en\s*\}\)/.test(code))

console.log('\n' + (failures.length === 0 ? '客户端体检通过 ✅' : '失败 ' + failures.length + ' 项 ❌：' + failures.join(' | ')))
process.exitCode = failures.length === 0 ? 0 : 1
