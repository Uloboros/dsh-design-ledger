# 更新日志 / Changelog

本文件记录对外可见的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-06

首个可用版本。**这一版的重点不是功能堆积，而是把三个会静默毁掉功能的契约钉死** ——
它们都是在本机真机运行中暴露出来的，且症状与根因相距很远（详见 README 的「崩溃 N」各节）。

### 新增 Added

- **6 个工具**：`design_ledger_status` / `design_ledger_init` / `design_ledger_read` /
  `design_ledger_update` / `design_doc_read` / `design_doc_list`。
- **分层注入**：经 `system-prompt/assemble` 注入「任务开启提示词 + 索引 + 当前聚焦子树」，
  其余内容按需读取，避免把整份设计文档塞进上下文。
- **设计文档解析**：目录结构推断层级（`S0N_` → 系统，`SNN_` → 子系统 …）；
  `design.md` 取一级标题作节点名；`analysis.md` 只记 `designRef` 与 `analysisTokens`。
- **功能表行 → 功能节点**（方案 A）：识别"首列即 ID 列且每行形如 `PREFIX_001`"的表格，
  每行生成一个 `feature` 节点，并把表格的「当前状态」列带入节点备注。
  策略可配：`expandTableRows: 'all' | 'multi-row' | false`。
- **图形面板**：侧栏「设计文档包含」入口 + 设计文档选择器（面包屑浏览、`.md` 计数、一键绑定）。
- **AGENTS.md 联动**：幂等托管块，重复写入逐字节一致，绝不覆盖块外用户内容。
- **台账存储**：`DEVPLAN/index.json` + 每系统一个分片 + `state.json`（易变进度），
  全部原子写入（先写临时文件再 rename）。
- **回归护栏**：`probe/contract-test.mjs`（28 项断言）、`probe/panel-list-test.mjs`、
  `probe/table-tree.mjs`、`probe/readme-check.mjs`，以及 13 个单元测试。
- **双语文档**：`README.md`（中文）与 `README.en.md`（英文）逐节对照。

### 修复 Fixed

- **`text.indexOf is not a function` 导致对话整体不可用**：`PromptSection.text` 必须**同步**
  返回字符串；改为"后台预计算 + 内存缓存 + 出口 `typeof` 兜底"，注入渲染失败最多丢失注入内容。
- **面板 `Failed to execute 'json' on 'Response': Unexpected end of JSON input`**：
  路由改走 `ctx.inject(['webServer'], …)` 注入作用域注册，并保留"只认可用实例"的重试兜底。
- **6 个工具全部静默失效**：`defineTool` 的 `parameters` 要的是**隐式属性映射**，
  不是手工预编译的根 schema；同时把构造期被吞掉的错误改为落盘诊断 + 告警。
- **面板把部署默认根当成工作区**（弹窗空白、且「工作区根」切不回去）：
  引入会话工作区旁路记录 + `agents.list()` 主动发现 + 部署根一律拒绝 + 面板显式回传工作区。
- **进度统计歧义**：`doing` 曾把"系统节点的向上汇总"也计入，标记 1 个功能会显示成 2；
  改为按叶子（功能）统计，并单独显示"进行中"数量。
- **台账文件噪声**：取消聚焦不再写入 `"marked": false`，改为删除字段（旧残留会在任意一次
  更新时一并清理）。
- **体量口径不一致**：`analysis.md` 不再混进节点 `docTokens`，单独记入 `analysisTokens`。

### 说明 Notes

- 与 DSH `0.2.0-rc.2` 实测通过；`peerDependencies` 全部 optional，不引入 schemastery。
- **改完插件代码必须整应用重启**：宿主会缓存 ESM 模块，HMR 只更新一部分，不能据此判断结果。
- 台账记录的是**实际开发**的功能，不是设计文档的清单：要动手做的功能才建节点。

[0.1.0]: https://github.com/OWNER/dsh-design-ledger/releases/tag/v0.1.0
