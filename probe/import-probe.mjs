/**
 * 尝试 import 插件入口，打印真实错误（含堆栈）。
 * 目的：拿到 DSH "failed to import" 背后的确切原因。
 */
import { pathToFileURL } from 'node:url'
import { readdirSync } from 'node:fs'

const entry = 'E:\\program\\dsh\\dsh-design-ledger\\lib\\index.js'

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
  const nm = readdirSync('E:\\program\\dsh\\dsh-design-ledger')
  console.log('\n插件目录条目:', nm.join(', '))
} catch (e) {
  console.log('读取插件目录失败:', e.message)
}
