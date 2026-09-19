# A1 · Agent Spec Schema v1

> **文档状态：** WP-A 交付物 A1（待三角色评审）
> **作者角色：** 方案设计师
> **日期：** 2026-09-19
> **上位依据：** 定稿 §3（底线 3：AgentVersion 不可变）、§4.2、§5.3；01 号 §4 WP-A；03 号 §3.4/§3.8；05 号 P2-1/P3-3/Q5-3；14 号 ND-2
> **WP-B 映射：** `SpecValidator`（Schema 校验）、`Registry`（注册与快照入库）
> **重建的基线残缺：** §6.2 Spec 结构、§6.4 Mission、§4.1/§5 领域模型（AgentVersion 部分）、§20.1 版本组成（快照部分）

---

## 1. 范围与原则

1. **Schema 形态：** Spec 以单个 JSON 文档（或等价 YAML）表达，由 zod 定义元 Schema 并转出 JSON Schema 供校验与文档化；
2. **不可变快照（底线 3）：** 注册时将 Spec **全文快照**写入 SQLite `AgentVersion` 表，此后该行任何字段不可更新（无 UPDATE 路径）；Git 仅承载审计历史与 diff，不承载版本内容；**文件改动必须重新注册生成新版本**（以内容哈希判定「改动」）；
3. **不含 Evolution Policy**（05 号 Q5-3 裁定删除；仅数据模型层外键预留，见 §6）；
4. **Policy 细节引用 A2**：本文只定义字段位与引用关系，字段语义与默认值以《A2-Model-Tool-Policy》为准。

## 2. Spec 顶层字段表

| 字段 | 类型 | 必填 | 默认 | 约束与说明 |
|---|---|---|---|---|
| `specVersion` | string | 是 | — | 固定 `"1"`；元 Schema 据此分派 |
| `identity` | object | 是 | — | 见 §3.1 |
| `mission` | object | 是 | — | 见 §3.2 |
| `inputContract` | object | 是 | — | JSON Schema（A2 §6 子集规则约束） |
| `outputContract` | object | 是 | — | JSON Schema（A2 §6 子集规则约束）；含 `allowEmpty` 扩展键（01 号 §5.4） |
| `modelPolicy` | object | 是 | — | 结构见 A2 §2；`maxModelCalls`/`maxTokens` 必填（无默认，强制显式声明） |
| `toolPolicy` | object | 是 | — | 结构见 A2 §3 |
| `evaluationPolicy` | object | 否 | `null` | 最小形态：`{ assertions: [{ path, op, value }]? }`，仅输出契约断言；完整评估延后第二阶段 |
| `memoryPolicy` | object | 否 | `{"type":"working"}` | 第一阶段仅工作记忆；其他取值注册时拒绝（防止伪声明） |

**顶层禁止字段：** `evolutionPolicy`（已删除；出现即注册拒绝——防止「删除的字段又被悄悄加回来」）。

## 3. 子结构字段表

### 3.1 `identity`

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `agentId` | string | 是 | `^[a-z][a-z0-9-]{1,63}$`；同一 agentId 的多次注册形成版本链 |
| `name` | string | 是 | 1–64 字符，展示名 |
| `description` | string | 是 | 1–512 字符 |
| `author` | string | 否 | 展示用，不参与鉴权 |

### 3.2 `mission`

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `responsibilities` | string[] | 是 | ≥1 条，每条 1–200 字符（职责边界，23.1 原则的落地） |
| `nonResponsibilities` | string[] | 是 | ≥1 条（**必填非职责**——「Agent 必须有明确边界」） |

### 3.3 `inputContract` / `outputContract`

| 属性 | 规则 |
|---|---|
| 形态 | 合法 JSON Schema（draft 2020-12），`type: "object"` 顶层 |
| 关键字子集 | 受 A2 §6 交集规则约束（服务 Provider 原生结构化输出的可移植性） |
| `outputContract.allowEmpty` | boolean，默认 `false`；未声明而输出空 → Output(ContractViolation)（01 号 §5.4） |
| 校验时机 | 注册=准入（结构合法）；任务=防御性重复（见 §4） |

## 4. 两层校验职责（05 号 P3-3 冻结）

| 层 | 时机 | 职责 | 失败处置 |
|---|---|---|---|
| **注册时校验（准入）** | `Registry.register()` | ① 元 Schema 合法性；② **引用完整性**：`toolPolicy` 声明的每个工具已在 Tool Registry 注册、风险等级一致；`modelPolicy.allowedModels` ⊆ 运行时配置的模型白名单；③ A2 子集规则校验（input/outputContract） | 拒绝注册，写 `RejectedRequest` 审计（含校验错误明细） |
| **任务时校验（防御性重复）** | 任务创建后、入队前 | 防版本指针移动、外部篡改（快照哈希比对）、库内工具注销后的悬空引用 | TaskRecord 已落库 → `Created → Failed`（A3 审计边界一行规则） |

**不变式：** 注册校验通过的 Spec 快照在任务时**必须**再次通过同一校验器；两次结果不一致即视为库或快照被篡改，按防御性失败处置并显式记录。

## 5. `AgentVersion` 表（SQLite）字段表

| 字段 | 类型 | 约束 |
|---|---|---|
| `versionId` | TEXT PK | `uuid v4` |
| `agentId` | TEXT | 与 `createdAt` 联合索引 |
| `version` | INTEGER | 同 agentId 内单调递增（1, 2, …） |
| `specSnapshot` | TEXT | **Spec 全文 JSON，不可变** |
| `contentHash` | TEXT | 快照正则化（键排序）后的 SHA-256；同 agentId 同 hash 的重复注册拒绝（防无改动刷版本） |
| `status` | TEXT | A5 状态机：`draft / released / deprecated` |
| `registeredAt` | TEXT | RFC3339 |
| `registeredBy` | TEXT | 注册主体标识 |

**不可变实施：** 代码层不提供 UPDATE 该表任何业务字段的路径（`status` 列除外——仅允许 A5 状态机合法迁移写入，且迁移本身追加审计事件）；SQLite 层可加触发器拒绝 UPDATE 作为双保险。

## 6. 外键预留（第二阶段，只留列不实现行为）

| 预留 | 位置 | 说明 |
|---|---|---|
| `evaluationId` | FailureRecord / TaskRecord | 白虎评估关联 |
| `evolutionCandidateId` | FailureRecord | 女娲演进候选关联（Evolution Policy 已从 Spec v1 删除，仅此预留） |
| `capabilitySnapshotRef` | AgentVersion | 白泽只读能力快照引用 |

## 7. 关键流程

### 7.1 注册（正常）

`spec.json` → `Registry.register()` → 元 Schema 校验 → 引用完整性校验 → 哈希去重 → 快照写入 `AgentVersion`（status=draft）→ 审计事件 `version_registered`（A6）→ 返回 `versionId`。

### 7.2 注册（异常）

任一校验失败 → 不写入 AgentVersion → `RejectedRequest` 审计（who/when/input hash/拒因）→ 结构化错误返回。**C3-① 的实现点：** 声明未注册工具的 Spec 在此被拒。

### 7.3 改动再注册

Spec 文件改动 → `contentHash` 变化 → 只能走全新注册生成新 `versionId`；旧版本行原样保留（不可变），版本状态各自独立演进（A5）。

## 8. 关键假设 / 风险 / 待验证（按角色规范标注）

| # | 内容 | 属性 |
|---|---|---|
| 1 | zod → JSON Schema 转换不引入子集外的关键字 | 设计假设（WP-B 以子集校验器复核） |
| 2 | `maxModelCalls`/`maxTokens` 不设默认值、强制显式声明 | 设计假设（防止「忘记声明 = 无限预算」；欢迎反方挑战是否应给保守默认） |
| 3 | SHA-256 正则化哈希在跨平台（行尾/编码）上稳定 | 待验证（WP-B 固化正则化算法后测试） |
| 4 | mission 必填非职责可能抬高示例 Agent 编写成本 | 已知取舍（边界原则优先） |

## 9. WP-B 实现输入映射

| WP-B 模块 | 消费本文内容 |
|---|---|
| `SpecValidator` | §2–§3 字段表 → zod 元 Schema；§4 两层校验职责 → 两个入口函数 |
| `Registry` | §5 表结构 + §7 流程 + 不可变约束 |
| `TaskManager` | §4 任务时校验失败 → A3 `Created → Failed` |
