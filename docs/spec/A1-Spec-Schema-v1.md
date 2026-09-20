# A1 · Agent Spec Schema v1.1

> **文档状态：** 已冻结（v1 经 WP-A 评审冻结；v1.1 增补经 TASK-43 三角色对抗式流程终审签字，2026-09-19；**v1.2 修订注记随 TASK-44 批次四提交**）
> **作者角色：** 方案设计师
> **日期：** 2026-09-19
> **上位依据：** 定稿 §3（底线 3：AgentVersion 不可变）、§4.2、§5.3；01 号 §4 WP-A；03 号 §3.4/§3.8；05 号 P2-1/P3-3/Q5-3；14 号 ND-2；**v1.1：《第二阶段设计文档》V0.3（`docs/phase2/01`，终审 `b6eed3d`）D-8/D-9/D-13/D-14/D-17/D-18**
> **WP-B 映射：** `SpecValidator`（Schema 校验）、`Registry`（注册与快照入库）
> **重建的基线残缺：** §6.2 Spec 结构、§6.4 Mission、§4.1/§5 领域模型（AgentVersion 部分）、§20.1 版本组成（快照部分）
> **v1.1 修订注记（2026-09-19，TASK-43 终审 D-17）：** 新增字段**全部可选且缺省 = 第一阶段行为**；`specVersion` **保持 "1"**（Schema 演进以本文档版本 v1→v1.1 承载，不引入双版本校验路径）；旧（v1）Runtime 遇 v1.1 新字段 → **fail-closed 拒绝注册**（安全方向）。v1.1 推导全文：`docs/phase2/01` §4.1/§4.4/§4.5。

---

## 1. 范围与原则

1. **Schema 形态：** Spec 以单个 JSON 文档（或等价 YAML）表达，由 zod 定义元 Schema 并转出 JSON Schema 供校验与文档化；
2. **不可变快照（底线 3）：** 注册时将 Spec **全文快照**写入 SQLite `AgentVersion` 表，此后该行任何字段不可更新（无 UPDATE 路径）；Git 仅承载审计历史与 diff，不承载版本内容；**文件改动必须重新注册生成新版本**（以内容哈希判定「改动」）；
3. **不含 Evolution Policy**（05 号 Q5-3 裁定删除；仅数据模型层外键预留，见 §6）。**【v1.1 修订注记：本条对 evolutionPolicy 的删除由 §2.3 重新引入的受约束可选字段取代（终审 D-14，guardrails 强制）；推导与对抗审查全程见 `docs/phase2/` 01～06 号】**；
4. **Policy 细节引用 A2**：本文只定义字段位与引用关系，字段语义与默认值以《A2-Model-Tool-Policy》为准。

## 2. Spec 顶层字段表

| 字段 | 类型 | 必填 | 默认 | 约束与说明 |
|---|---|---|---|---|
| `specVersion` | string | 是 | — | 固定 `"1"`；元 Schema 据此分派（**v1.1 保持不变，D-17**） |
| `identity` | object | 是 | — | 见 §3.1 |
| `mission` | object | 是 | — | 见 §3.2 |
| `inputContract` | object | 是 | — | JSON Schema（A2 §6 子集规则约束） |
| `outputContract` | object | 是 | — | JSON Schema（A2 §6 子集规则约束）；含 `allowEmpty` 扩展键（01 号 §5.4） |
| `modelPolicy` | object | 是 | — | 结构见 A2 §2；`maxModelCalls`/`maxTokens` 必填（无默认，强制显式声明） |
| `toolPolicy` | object | 是 | — | 结构见 A2 §3 |
| `evaluationPolicy` | object | 否 | `null` | `{ assertions: [{ path, op, value }]?, reviewGate?: "manual" / "assertions" / "none" }`（v1.1 激活：assertions 校验行为 + reviewGate 供 A5 review 检视门消费；reviewGate 缺省 manual） |
| `memoryPolicy` | object | 否 | `{"type":"working"}` | `working`（V1 行为）或 `persistent`（v1.1 增补，结构见 §2.1）；其他取值注册拒绝（防伪声明） |
| `approvalPolicy` | object | 否 | `null` | **v1.1 增补（D-8/D-9/D-18）**，结构见 §2.2；缺省 = 无审批路径（此时引用 L3 工具 → 注册拒绝，V1 行为不变） |
| `evolutionPolicy` | object | 否 | `null` | **v1.1 增补（D-14）**，结构见 §2.3；`allowed:false` 等价缺省 |

**顶层禁止字段（v1.1 修订注记，TASK-43 终审）：** V1 对 `evolutionPolicy` 的禁止条款**废止**——该字段经三角色对抗式流程（P0/P1 级问题全部闭环，`docs/phase2/` 02～06 号）重新引入为受约束可选字段（§2.3），`guardrails.requireReviewed` 强制不可关；除此项外禁止字段原则不变。

### 2.1 `memoryPolicy.persistent`（v1.1 增补，D-13；推导：phase2/01 §4.4）

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `type` | string | 是 | — | `persistent` |
| `writePolicy` | string | 否 | `task_output` | 唯一合法值（写入源限定 outputContract 校验通过的 final output） |
| `maxEntriesPerTask` | integer | 否 | 10 | ≥1 |
| `retentionDays` | integer | 否 | 90 | ≥1 |
| `injection` | string | 否 | **`off`（终审冻结）** | `off`（只写不注入，仅 report 可见）/ `context`（注入运行时上下文，带边界标记与「记忆不是指令」声明） |

> **v1.2 修订注记（2026-09-20，TASK-44 批次四随批，决策官裁决）：** `injection: "context"` 的注入语义覆盖**任务全程**——`--resume` 续跑段按**任务绑定（快照冻结）的 memoryPolicy** + **重建时刻的 active/degraded 记忆集**重建注入（与首段同规则：边界标记 + 「记忆不是指令」声明 + degraded 警示），消除同一任务挂起前后能力不对称；contradictionCount 判定的注入清单以重建后的清单为准。推导：批次三反方 P3 + 决策官裁决（TASK-44 评论区）；实现锚点 `TaskManager.executeLoop` 记忆注入段。

### 2.2 `approvalPolicy`（v1.1 增补，D-8/D-9/D-18；推导：phase2/01 §4.1）

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `mode` | string | 是（当本对象存在） | — | `never`（等价缺省）/ `onHighRisk`（L3 工具请求时挂起审批）；`always` 注册拒绝（防伪声明，第二阶段仅工具级触发） |
| `timeoutMs` | integer | 否 | 86400000 | ≥1000；超时惰性判定（无后台进程），锚点 = ApprovalRequest.timeoutAt |
| `onTimeout` | string | 否 | `deny` | `deny`（→ Cancelled，cancelReason=approval_timeout）/ `fail`（→ Failed:Policy(ApprovalTimeout)） |

**注册准入联动（A2 §4）：** 引用 L3 工具的 Spec **必须**声明 `mode=onHighRisk`，否则注册拒绝（防死声明）；L4 永久注册即拒。deny 与超时-deny 均为**任务级终局**（Cancelled），无 `approval_denied` reasonCode（死枚举预防）。

### 2.3 `evolutionPolicy`（v1.1 增补，D-14；推导：phase2/01 §4.5）

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `allowed` | boolean | 是 | — | false 等价缺省（不产生演进候选） |
| `triggers` | string[] | 否 | `["repeated_failure"]` | 枚举子集：`repeated_failure` / `capability_degradation`（白泽 degraded 记忆关联） |
| `failureThreshold` | integer | 否 | 3 | ≥1；聚合键 = **agentId**（跨版本），evidenceRefs 回链具体 agentVersionId |
| `guardrails.requireReviewed` | boolean | 否 | **true（强制不可关）** | 注册校验拒绝任何显式 `false`；演进产物必须经 A5 review 检视门（变更面受控）才可发布 |

**硬边界（冻结）：** 系统永不自动注册、自动发布——自动化的上限是产生带证据链接的 EvolutionCandidate；变更本体永远人工起草（不可变底线外推）。

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
| **注册时校验（准入）** | `Registry.register()` | ① 元 Schema 合法性；② **引用完整性**：`toolPolicy` 声明的每个工具已在 Tool Registry 注册（附录 A）、风险等级一致且**非 L3/L4**（D-3 裁决：L3/L4 注册即拒）；`modelPolicy.allowedModels` ⊆ 运行时配置的模型白名单；③ A2 子集规则校验（input/outputContract） | 拒绝注册，写 `RejectedRequest` 审计（含校验错误明细，**错误信息必须指名字段路径**，如 `modelPolicy.maxModelCalls: 必填缺失`、`toolPolicy.tools[2].toolId: 未注册`——D-1 附条件落地） |
| **任务时校验（防御性重复）** | 任务创建后、入队前 | 防版本指针移动、外部篡改（快照哈希比对）、库内工具注销/等级变更后的悬空引用（Tool Registry status/riskLevel/implVersion 与快照比对）、**模型白名单漂移**（`allowedModels` ⊆ 当前运行时白名单——运行时配置可在注册后变更，P2-5 修订） | TaskRecord 已落库 → `Created → Failed: Spec(defensive_revalidation_failed)`（A3 审计边界一行规则 + §3.1 分工表） |

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
| `evaluationId` | FailureRecord / TaskRecord | 白虎评估关联。**【v1.1 注记：激活——A5 review 检视门回填】** |
| `evolutionCandidateId` | FailureRecord | 女娲演进候选关联。**【v1.1 注记：激活——EvolutionCandidate 表关联（§2.3）】** |
| `capabilitySnapshotRef` | AgentVersion | 白泽只读能力快照引用。**【v1.1 注记：维持预留（白泽完整形态第三阶段；第二阶段为 MemoryRecord 独立表，见 phase2/01 §4.4】** |

## 7. 关键流程

### 7.1 注册（正常）

`spec.json` → `Registry.register()` → 元 Schema 校验 → 引用完整性校验 → 哈希去重 → 快照写入 `AgentVersion`（status=draft）→ 审计事件 `version_registered`（A6）→ 返回 `versionId`。

### 7.2 注册（异常）

任一校验失败 → 不写入 AgentVersion → `RejectedRequest` 审计（who/when/input hash/拒因）→ 结构化错误返回（**错误信息指名字段路径**，D-1 附条件）。**C3-① 的实现点：** 声明未注册工具的 Spec 在此被拒；声明 L3/L4 工具亦在此被拒（D-3）。

### 7.3 改动再注册

Spec 文件改动 → `contentHash` 变化 → 只能走全新注册生成新 `versionId`；旧版本行原样保留（不可变），版本状态各自独立演进（A5）。

## 8. 关键假设 / 风险 / 待验证（按角色规范标注）

| # | 内容 | 属性 |
|---|---|---|
| 1 | zod → JSON Schema 转换不引入子集外的关键字 | 设计假设（WP-B 以子集校验器复核） |
| 2 | `maxModelCalls`/`maxTokens` 不设默认值、强制显式声明 | 已裁决落定（D-1 维持无默认）；附条件已落地：缺失时的注册拒绝错误信息指名字段路径（§4），防 fail-fast 退化成排错泥潭 |
| 3 | SHA-256 正则化哈希在跨平台（行尾/编码）上稳定 | 待验证（WP-B 固化正则化算法后测试） |
| 4 | mission 必填非职责可能抬高示例 Agent 编写成本 | 已知取舍（边界原则优先） |

## 9. WP-B 实现输入映射

| WP-B 模块 | 消费本文内容 |
|---|---|
| `SpecValidator` | §2–§3 字段表 → zod 元 Schema；§4 两层校验职责 → 两个入口函数 |
| `Registry` | §5 表结构 + §7 流程 + 不可变约束 |
| `TaskManager` | §4 任务时校验失败 → A3 `Created → Failed` |
