/**
 * 探针共用工具：临时工作区与可靠清理。
 *
 * 为什么单独抽出来：Windows 上 `rm(dir, {recursive:true})` 偶发 `EPERM` /
 * `ENOTEMPTY`（杀软扫描、文件句柄尚未释放），一次失败就会在 `%TEMP%` 留下残留。
 * 实测：只做"失败不报错"的话，**89 次运行留下了 89 个目录**（约 3 MB）——
 * 错误被吞掉不等于问题解决。所以这里做三件事：
 *
 *   1. **重试**（默认 3 次，间隔递增）：绝大多数 EPERM 是瞬时的，重试即可成功；
 *   2. 仍失败时**打印残留路径**（而不是静默），让人知道该删什么；
 *   3. 失败**不影响退出码** —— 清理失败不该伪装成测试失败。
 *
 * 另外提供 `--keep-temp`：失败排查时保留临时目录，方便事后翻看现场。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 是否保留临时目录（排查用）：命令行带 `--keep-temp` 时保留。 */
export const KEEP_TEMP = process.argv.includes('--keep-temp')

/** 新建一个探针临时工作区。 */
export function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

/** `sleep` 的 Promise 版本。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 可靠清理一个临时目录。
 *
 * @param {string} dir 目标目录
 * @param {{ attempts?: number, label?: string }} [opts]
 * @returns {Promise<boolean>} 是否成功删除（保留模式下视为成功，不打印警告）
 */
export async function cleanupTemp(dir, opts = {}) {
  if (!dir) return true
  if (KEEP_TEMP) {
    console.log('  ℹ️ --keep-temp：保留临时目录 ' + dir)
    return true
  }
  const attempts = Number.isInteger(opts.attempts) ? opts.attempts : 3
  const label = opts.label ? opts.label + ' ' : ''
  let lastError = null
  for (let i = 1; i <= attempts; i++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
      return true
    } catch (e) {
      lastError = e
      // 退避后重试：EPERM/ENOTEMPTY 通常是瞬时占用
      if (i < attempts) await sleep(150 * i)
    }
  }
  console.log(
    `  ⚠️ ${label}临时目录清理失败（已重试 ${attempts} 次，不影响测试结论）: ${String((lastError && lastError.message) || lastError)}`,
  )
  console.log('      残留路径：' + dir + '（可手动删除）')
  return false
}
