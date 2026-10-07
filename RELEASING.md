# 发版说明（维护者）

> 这份文档**只给维护者看**。使用者只需要 [README.md](README.md)（中文）或 [README.en.md](README.en.md)（English）。
> 之所以从 README 里挪出来：发布流程与"怎么用这个插件"是两类完全不同的读者。

## 一条命令发版（推荐）

发版已经自动化，**不需要在本地打包、也不需要个人访问令牌**：

**GitHub 仓库 → `Actions` → 左侧 `Release` → `Run workflow`**（版本号留空即用 `package.json` 里的当前值）

workflow（[`.github/workflows/release.yml`](.github/workflows/release.yml)）会依次：

1. 跑零依赖校验：`npm run check` / `npm test` / `check:readme` / `check:client`
   —— **宁可发不出去，也不发出一个坏包**；
2. 校验 `package.json` 的 `version` 与本次输入的版本一致（不一致直接失败，避免版本号对不上的包流出去）；
3. `v<version>` tag 不存在则**补建**并推送；
4. `npm pack` 打包（严格受 `package.json` 的 `files` 白名单约束）；
5. **断言 tarball 内不含 `.design-ledger` / `DEVPLAN` / `node_modules` / `.git/`** ——
   运行痕迹混进发布包是最容易犯、也最难发现的错；
6. 从 `CHANGELOG.md` 抽取对应版本小节作为发布正文，并追加"安装方式 + 附件 SHA-256"；
7. `gh release create`，把 `.tgz` 作为附件发布。

### 为什么是手动触发而不是 push tag 触发

用 `GITHUB_TOKEN` 创建 Release 时，**该 Release 对应的 tag 不会再触发其它 workflow**（GitHub 防递归的限制）。
如果 workflow 由 tag push 触发、又去建同名 tag 的 Release，就会在同一个 tag 上打转。
改成手动触发后，脚本自己保证 tag 存在，语义清晰且没有循环。

## 手工发版（备用路径）

```bash
npm run verify                  # 必须全绿
npm run check:release           # 发版前自检：版本 / CHANGELOG / tarball 内容 / workflow 步骤
node probe/reorder-crashes.mjs  # README 的「崩溃 N」小节保持升序（改过文档就跑一次）
# 更新 CHANGELOG.md 与 package.json 的 version，然后：
git add -A && git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push && git push origin vX.Y.Z
npm pack                        # 手动打包，再把 .tgz 拖到 Release 附件里
```

`npm run check:release` 检查的东西与 workflow 里的步骤同款，只是提前在本地跑一遍，
省去"推上去等几分钟才发现版本号写错"的往返。

## 发版前检查清单

| 项 | 怎么做 |
|---|---|
| 校验全绿 | `npm run verify`（语法 / 13 单测 / 文档体检 / 客户端体检 / 契约自检） |
| 发版自检 | `npm run check:release` |
| 双语文档同步 | 改了任一版 README 就必须同步另一版；`check:readme` 会比对标题数与层级 |
| 仓库元数据齐全 | `npm run check:readme` 会提醒缺失或仍是占位符的字段 |
| CHANGELOG 有对应小节 | 否则 Release 正文会空 |
| 公开仓库一致性 | `npm run audit`（与 GitHub 逐文件 blob 哈希比对 + 隐私体检） |

## 关于 npm

`package.json` 里目前是 `"private": true`，这会**阻止 `npm publish`** —— 这是有意的防误发。
本项目当前通过 **GitHub Release 附件（tarball）** 分发，使用者解压后用
`plugin_manager install_bundle target = link:<解压路径>` 安装。

若将来要发 npm：

1. 去掉 `"private": true`；
2. 若要发到 **GitHub Packages**，包名必须改成 `@<owner>/<name>`（GitHub 的 npm registry 强制要求），
   并联动修改 `client/client.js` 里 `__ModuleLoader__.load({ id })` 的 id、`cordis.patch.yml` 的 `name:`
   与两份 README 的安装命令 —— **id 必须等于包名**，漏改会导致客户端插件加载失败；
3. 第三方 `@deepseek-ai/*` 包已发布到 npm，`peerDependencies` 会被正常解析。
