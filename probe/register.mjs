/**
 * 一次性诊断：模拟 DSH 的模块解析，尝试 import 本插件，打印真实错误。
 *
 * 用法（cwd 必须在插件目录）：
 *   node --import ./probe/register.mjs probe/import-probe.mjs
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./resolve-hook.mjs', pathToFileURL(import.meta.filename))
