---
name: design-ledger
description: 用 dsh-design-ledger 插件把设计文档变成一棵可实时更新的开发进度树，并在长周期项目里让新会话接上进度。用于：从设计文档建立进度台账、按设计文档的"系统/子系统/功能/子功能"层级推进开发、实时记录完成度与 bug、记录代码索引（只记文件+符号名）、以及与 AGENTS.md 联动。凡是在有设计文档的项目里做多轮开发、或需要跨会话续接进度时，必须先加载本技能。
whenToUse: 任务涉及按设计文档开发/迭代一个项目（游戏或软件），尤其是项目较大、单个会话上下文会耗尽、需要跨会话续接进度；或需要建立/更新开发进度台账、记录 bug 与代码位置时。仅需 Godot 引擎或 DSH 插件开发知识、与本台账无关时不要加载。
---

# 设计文档进度台账（dsh-design-ledger）

**本技能管什么**：把设计文档变成可持续维护的进度树，并在开发过程中实时更新它。
**核心约束**：设计文档**不会被整体注入上下文**（实测一份真实文档 ≈13 万 tokens）。注入的只有「索引 + 当前聚焦子树」。

## 0. 工具一览

| 工具 | 用途 |
|---|---|
| `design_ledger_status` | 看有没有台账、接上没有、完成度、未修复 bug。**每次接手任务先跑它。** |
| `design_ledger_init` | 绑定设计文档 + 生成初始进度树（可传 `task_prompt` 记录"开启任务时用户说的话"） |
| `design_ledger_read` | 按需读：`index` / `tree` / `system` / `node` / `bugs` |
| `design_ledger_update` | 更新节点：`status` / `mark` / `code_refs` / `interfaces` / `bugs` / `notes` |
| `design_doc_list` | 列出设计文档树与各文件体量（token 估算） |
| `design_doc_read` | 按需读设计文档原文（按层级/文件，可限体量） |

## 1. 接手一个任务时的标准动作

```
design_ledger_status                     # ① 有台账吗？
```

- **没有** → `design_ledger_init`（`design_path` 传候选里的路径；把用户这段需求原话作为 `task_prompt` 传入）
- **有** → 读它返回的完成度与聚焦节点，然后：

```
design_ledger_read {scope:"tree"}        # ② 看整体骨架（系统 → 子系统 → 功能）
design_ledger_read {scope:"bugs"}        # ③ 先看有没有未修的 bug
design_doc_read {rel:"<相关层级>"}        # ④ 需要细节时按需读设计文档，**不要**整体读
```

> 注入已经给了你索引与聚焦子树。**不要**为了"看全"去整体读设计文档——那正是要避免的上下文浪费。

## 2. 开发过程中的更新纪律（本技能的核心）

**每完成一个功能/子功能，立刻更新台账**，不要攒到最后：

```
design_ledger_update {
  node_id: "<节点 id>",
  status: "done",
  code_refs: [{ file: "src/systems/combat/CombatSystem.ts", symbol: "CombatSystem" }],
  interfaces: ["resolveAttack(attacker, target): DamageResult"]
}
```

### 2.1 台账记的是**实际开发**的功能，不是设计文档的清单

自动生成只负责给出**骨架 + 可选的候选条目**（例如设计文档里带 `XXX_001` ID 的表格行）。
但"要不要为某个功能建节点"应当由**实际开发**决定：

> **动手做了、或马上要动手做的功能，才建节点。**设计文档里写了但这一轮不做的，
> 不必先建一个空节点占位 —— 那会让进度树变成"设计文档的镜像"，而不是开发进度。

按需建节点（这是**常用操作**，不是兜底手段）：

```
design_ledger_update {
  parent_id: "03_systems/S02_base_building",   # 挂到它所属的系统/子系统下
  node_name: "废土地雷触发判定",                 # 命名优先用设计文档里的叫法
  status: "doing",
  code_refs: [{ file: "src/buildings/Landmine.ts", symbol: "onEnemyEnter" }]
}
```

这样做的两个好处：
- **进度树始终等于"已经动过的部分"**，一眼能看出真实进度，不会被设计清单里的空条目稀释；
- **泛用**：换一个项目、换一种文档风格（正文型/表格型/目录型）都不影响 —— 自动生成的多少只是起点，
  agent 始终可以按实际情况补节点。

判断标准：
| 情况 | 做法 |
|---|---|
| 这一轮要做的功能，设计文档里有条目但还没节点 | `parent_id + node_name` **新建** |
| 已经在推进 | `mark:true` + `status:"doing"` |
| 做完了 | `status:"done"` + 补 `code_refs` / `interfaces` |
| 设计文档里有、但这轮不做 | **先不建**，等真要做时再建 |

规则：

1. **开工时先 mark**：`design_ledger_update {node_id, mark:true, status:"doing"}`
   —— 标记的节点会让它的子树在下次注入中优先出现，新会话就能接上。
2. **完成时置 done**，并补 `code_refs` 与 `interfaces`。
3. **代码索引只记 `file` + `symbol`**（如 `{file:"src/a/b.ts", symbol:"parseConfig"}`）。
   **绝不要记行号** —— 行号随编辑漂移，符号名稳定。需要行范围时用编辑器/IDE 现场查。
4. **发现 bug 立刻记**，并挂到"最可能出问题"的那个节点上：
   ```
   design_ledger_update {
     node_id: "<最相关节点>",
     add_bug: {
       summary: "存档写入后立刻读回会拿到旧值",
       severity: "high",
       code_ref: { file: "src/save/Store.ts", symbol: "flush" },
       repro: "连续两次 save→load"
     }
   }
   ```
   修好后用 `update_bug {id, status:"fixed"}` 关闭（id 由工具返回）。
5. **被阻塞**就置 `blocked` —— 它会向上冒泡到系统级，避免"看起来在推进"。

## 3. 节点命名规则

**节点名 = 设计文档里的名称**。生成时会优先取该层级 `design.md` 的一级标题（`# 标题`）；没有标题时回退到目录名。
你自己新建节点（`parent_id` + `node_name`）时，**同样优先用设计文档里的叫法**；文档没有明确名称时，按其功能/用处命名。

层级由目录结构推断（规范项目结构下最可靠）：

| 目录形态 | 推断 |
|---|---|
| `00_concept/` `01_top_design/`（纯数字前缀、只有直属文档） | **文档分组（section）**，不是系统，不建分片 |
| `03_systems/` | 容器（容器本身不建节点） |
| `S01_core_gameplay/` | **系统** |
| `S02_01_inventory/` | **子系统** |
| `design.md` | 该层级的正文 → 建 `designRefs` |
| `analysis.md` | 该层级的分析 → 一并记入 `designRefs`（不单独建节点） |

## 4. 注入策略（了解它，才能正确依赖它）

| 层 | 内容 | 是否自动注入 |
|---|---|---|
| L0 | 任务开启提示词（`task_prompt`，完整） | ✅ |
| L1 | 索引：系统清单 + 完成度 + 设计文档体量 | ✅（受体量预算截断） |
| L2 | 当前聚焦子树（含祖先链、代码索引、接口、未修 bug） | ✅（受预算截断） |
| L3 | 其余子树 / 设计文档原文 | ❌ 用工具按需读 |

推论：
- **想让某部分出现在下次会话**→ 把它所在节点 `mark:true`。
- 索引显示"因体量预算被截断"时，用 `design_ledger_read {scope:"index"}` 拿完整索引。
- 聚焦子树被截断时，用 `scope:"system"` 或 `scope:"node"` 精确取。

## 5. 与 AGENTS.md 的联动

分工（**不要重复内容**）：

| 文件 | 谁读 | 内容 |
|---|---|---|
| `AGENTS.md`（工作区根，DSH 原生注入） | 给人看的摘要 | 项目一句话简介、**指向 `DEVPLAN/` 的一行**、当前里程碑 |
| `DEVPLAN/index.json` + `DEVPLAN/systems/*.json` | 给机器/注入 | 完整进度树、代码索引、接口、bug |

`AGENTS.md` 有**字节预算**（超限会被截断），所以**只放指针与摘要**，明细留在台账。

首次建立台账后，建议在 `AGENTS.md` 里加一行：

```markdown
## 开发进度
进度台账在 `DEVPLAN/`（dsh-design-ledger 管理）。接手任务前先跑 `design_ledger_status`，
按设计文档的层级推进，完成一个功能就用 `design_ledger_update` 更新状态与代码索引。
```

## 6. 常见错误（都是真实会犯的）

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 整体读取设计文档 | 一次吃掉几万 token，加速触发压缩 | 先看索引，再 `design_doc_read` 只读相关层级 |
| 代码索引里记行号 | 编辑后立刻失真 | 只记 `file` + `symbol` |
| 一个功能做完却不更新台账 | 台账与实际脱节，新会话被误导 | 完成即 `status:"done"` + `code_refs` |
| 忘记 `mark` | 新会话不知道你在做哪块 | 开工时 `mark:true` |
| 把设计文档内容抄进台账 `notes` | 台账膨胀、双重维护 | `notes` 只写"结论与原因"，正文用 `designRefs` 指向文档 |
| bug 记到不相干的节点 | 查不到 | 挂到**最可能出现该 bug** 的节点上 |
| 在 `AGENTS.md` 里贴完整进度树 | 超字节预算被截断 | `AGENTS.md` 只留指针 |

## 7. 台账文件位置

```
<工作区>/DEVPLAN/
├── index.json        索统索引 + 设计文档绑定 + 注入配置（可提交 git）
├── systems/<id>.json 每个系统的完整节点表（可提交 git）
└── state.json        聚焦节点与任务提示词（易变，建议 gitignore）
```

`state.json` 是易变状态，建议在 `.gitignore` 里加 `DEVPLAN/state.json`。

## 8. 环境基线（本机实测）

- DSH **0.2.0-rc.2**（桌面端 `desktop` profile）
- 插件版本与 peer 兼容性：本插件 `peerDependencies` 声明了 `dsh-tools` / `schemastery` / `dsh-system-prompt`（`>=0.2.0-rc.1 <0.3.0-0`）。**升级插件时必须钉版本**（`link:` 或带 ref 的 `git+…`），裸 `github:` 会被 pnpm 解析到过期 commit 而静默回退。
- 实测数据点：19 个 .md / 588 KB / 226,885 字符 ≈ 133k tokens → 全量注入不可行，本技能的分层策略是必需而非优化。
