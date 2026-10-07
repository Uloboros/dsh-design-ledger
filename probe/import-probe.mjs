/**
 * 尝试 import 插件入口，打印真实错误（含堆栈）。
 * 目的：拿到 DSH "failed to import" 背后的确切原因。
 *
 * 路径**按本脚本位置解析**（不写死机器路径），这样在任何 clone 位置都能跑。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 插件根目录（本文件在 <plugin>/probe/ 下）。 */
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(PLUGIN, 'lib', 'index.js')

try {
  const mod = await import(pathToFileURL(entry).href)
  console.log('IMPORT OK')
  console.log('  name   =', mod.name)
  console.log('  inject =', Array.isArray(mod.inject) ? mod.inject.join(', ') : String(mod.inject))
  console.log('  apply  =', typeof mod.apply)
  console.log('  Config =', mod.Config ? 'present' : 'absent')
  console.log('  default=', typeof mod.default)
} catch (e) {
  console.log('IMPORT FAILED')
  console.log('  message:', e && e.message)
  console.log('  code   :', e && e.code)
  console.log('  stack  :')
  console.log(String((e && e.stack) || '').split('\n').slice(0, 14).join('\n'))
}

// 顺便看看 link 安装后插件目录里有没有 node_modules
try {
  const nm = readdirSync(PLUGIN)
  console.log('\n插件目录条目:', nm.join(', '))
} catch (e) {
  console.log('读取插件目录失败:', e.message)
}
