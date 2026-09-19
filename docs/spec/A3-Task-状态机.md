# A3 · Task 生命周期状态机（attempt 模型）

> **文档状态：** WP-A 交付物 A3（待三角色评审）
> **作者角色：** 方案设计师
> **日期：** 2026-09-19
> **上位依据：** 定稿 §5.1（冻结）；03 号 §3.2（迁移表原文，本表为其规格化）；05 号 P1-1/P1-2/备注-3；01 号 §5.1/§5.3–5.4
> **WP-B 映射：** `TaskManager`（状态驱动）、`StateManager`（持久化/崩溃恢复）、`TraceRecorder`（迁移即事件）
> **重建的基线残缺：** §7.2 生命周期、§7.3/7.4（标题吞噬区）、§6.9 输入校验时序

---

## 1. 状态集（7 状态）

`Created / Queued / Running / Paused(空壳预留) / Succeeded / Failed / Cancelled`

| 状态 | 语义 | 备注 |
|---|---|---|
| `Created` | TaskRecord 已落库，尚未通过任务时校验 | 审计边界的关键态（§3） |
| `Queued` | 校验通过、已入队，等待调度 | |
| `Running` | 执行中；重试 = Running 内**新 attempt**（自环），不离开 Running | attemptCount 计入 TaskRecord |
| `Paused` | **空壳预留**：schema 级存在，第一阶段**无触发器、无迁移实现** | 第二阶段审批挂起点；引入无须结构性重构 |
| `Succeeded` | 真终态，无出边 | |
| `Failed` | 真终态，无出边；归因由 A4 failureClass 承载 | |
| `Cancelled` | 真终态，无出边 | |

**不变式（冻结）：** ① Succeeded/Failed/Cancelled 为真终态，无出边；② 每条迁移**先持久化后继续**（写库成功才执行状态副作用）；③ 状态迁移即 Trace 事件（A6）；④ Timeout 非独立状态——任务级/调用级超时分别映射为 Failed 的 failureClass。

## 2. 完整迁移表（三列：触发事件 / 持久化点 / A4 映射）

| 迁移 | 触发事件 | 持久化点（先写后行） | A4 失败分类映射 |
|---|---|---|---|
| `Created → Queued` | Spec 与 Input Contract 防御性校验通过，入队 | TaskRecord.status + Trace(TaskQueued) | — |
| `Created → Failed` | 落库后校验失败（Spec/防御性重复/Input Contract 不符） | TaskRecord + FailureRecord + Trace(TaskFailed) | Input / Spec |
| `Queued → Running` | 调度器取出执行 | TaskRecord + Trace(TaskStarted) | — |
| `Queued → Cancelled` | 用户取消（等待中，无副作用） | TaskRecord + Trace(TaskCancelled) | — |
| `Running → Running`（新 attempt） | 调用级失败/超时且**该逻辑调用的** `attemptNo(callNo, kind) < maxAttempts`（计数粒度见 A2 §2.1：调用键 = callNo × kind，判定用调用级计数器，不落 TaskRecord） | Trace(AttemptFailed，含 callNo/callKind/attemptNo) + TaskRecord.attemptCount 聚合展示更新 | Model / Tool（attempt 级，不计任务失败） |
| `Running → Paused` | 预留（第一阶段无触发器） | —（第二阶段定义） | — |
| `Paused → Running / Cancelled` | 预留 | — | — |
| `Running → Succeeded` | 输出契约校验通过 | TaskRecord + Trace(TaskSucceeded) | — |
| `Running → Failed` | ① attempt 耗尽；② 任务级超时；③ 预算超限；④ 连续拦截超限；⑤ 输出契约失败 | TaskRecord + FailureRecord + Trace(TaskFailed) | Model / Tool / Runtime(BudgetExceeded/TaskTimeout) / Policy(PolicyBlocked) / Output(ContractViolation) |
| `Running → Cancelled` | 用户取消：**等待当前原子调用完成后生效** | TaskRecord + Trace(TaskCancelled) | — |
| （恢复）`Queued/Running 遗留 → Failed` | 进程重启发现非终态遗留任务 | TaskRecord + FailureRecord + Trace | Runtime(CrashRecovery) |

## 3. 审计边界一行规则（05 号备注-3，逐字冻结）

> **TaskRecord 落库前的校验失败 → RejectedRequest 审计（不创建 Task、无状态迁移）；落库后的任何校验失败（含防御性重复校验）→ Created → Failed。**

判定锚点 = TaskRecord 是否已写入 SQLite。两条路径的记录形态：

| 路径 | 产物 |
|---|---|
| 落库前拒绝 | `RejectedRequest` 审计记录（A6 §4）；不创建 Task、不进队列、**无 Trace 事件**（taskId 尚不存在） |
| 落库后失败 | TaskRecord（终态 Failed）+ FailureRecord + Trace 事件（`contract_checked` 等） |

### 3.1 双路径校验分工表（P1-2 修订：钉死落库前查什么、落库后防什么）

| 时机 | 检查项 | 失败去向 | Trace | 对应 A4 分类 |
|---|---|---|---|---|
| **落库前（创建入口）** | ① Input Contract **结构校验**（输入是否符 Spec 声明的 inputContract） | `RejectedRequest(kind='task_creation')`，无 Task | 无（taskId 不存在） | —（审计流记录拒因） |
| | ② Spec 存在性与状态（agentId 可解析、指针指向 Released 版本） | 同上（`agentVersionId` 可解析时填入，不可解析时为 NULL——T2 兜底口径见 A6 §6） | 无 | — |
| **落库后（Created 态，入队前）** | ③ 防御性复验：Input Contract **同一校验器复跑**（防注册后契约语义漂移/实现被替换） | `Created → Failed` | `contract_checked(which=input)` | `Input(contract_mismatch)` |
| | ④ 防御性复验：Spec 快照哈希比对、工具悬空引用（Tool Registry 注销/等级变更）、**模型白名单漂移**（allowedModels ⊆ 当前白名单，P2-5） | `Created → Failed` | `task_failed` | `Spec(defensive_revalidation_failed)` |

**分工语义：** 落库前查「这次请求本身合不合法」（输入结构、目标存在），落库后防「创建与执行之间世界变了」（快照被篡改、注册表被变更）。`Input(contract_mismatch)` 终局路径**仅**经 ③ 可达——正常请求在 ① 已被拒，③ 捕获的是「创建时合法、复验时不合法」的漂移窗口。C2 实验样本计数同理：①② 拒绝不产生尝试样本（无 Trace），③④ 失败计入（有 Trace）——分母口径见 A4 §4。

## 4. TaskRecord 字段表（SQLite）

| 字段 | 类型 | 约束 |
|---|---|---|
| `taskId` | TEXT PK | uuid v4 |
| `agentId` / `agentVersionId` / `specContentHash` | TEXT | **版本绑定快照**（创建时固化；T1 依赖） |
| `input` | TEXT | 任务输入 JSON（已过 Input Contract） |
| `status` | TEXT | §1 状态集 |
| `attemptCount` | INTEGER | 默认 0；Running 内递增；**仅展示聚合**（全任务累计尝试数），重试判定用调用级计数器（A2 §2.1，不落本表） |
| `modelCallCount` / `tokensUsed` | INTEGER | 预算记账（tokensUsed 含 estimated 部分，另见 A6 usage 事件） |
| `consecutiveDenialCount` | INTEGER | 连续拦截计数（A2 §5） |
| `createdAt` / `startedAt` / `endedAt` | TEXT | RFC3339 |
| `traceFile` | TEXT | per-task JSONL 路径（A6） |
| `terminalFailureClass` | TEXT | 终态为 Failed 时填 A4 分类 |
| （预留）`evaluationId` / `evolutionCandidateId` | TEXT | 第二阶段外键，只留列 |

## 5. ApprovalRequest 结构预留（只定义不写入）

8 字段（03 号 §3.2 原 7 字段 + `agentVersionId`；**D-4 已裁决：`agentVersionId` 定为第 8 字段**——T1 类查询的版本锚定，反方与决策官均支持，定稿 §2「8 字段结构预留」与之对齐）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | TEXT PK | |
| `taskId` | TEXT | |
| `agentVersionId` | TEXT | 审批时生效版本（版本固定原则） |
| `toolId` | TEXT | |
| `riskLevel` | TEXT | L0–L4 |
| `requestedAt` | TEXT | |
| `decision` | TEXT | 枚举：`approved / denied / pending` |
| `decidedAt` | TEXT | |

第一阶段：无写入路径、无触发器；DDL 建表可选（不建则仅以本文档为定义载体——WP-B 自行决定，不影响第二阶段引入）。

## 6. 崩溃恢复（StateManager 最小版）

重启时扫描 `status ∈ {Queued, Running}` 的遗留记录 → 逐条迁移 `→ Failed`，failureClass = `Runtime(CrashRecovery)`，补写 FailureRecord + Trace。**不做断点续跑**（Checkpoint 属第二阶段）；恢复本身幂等（二次重启不再改写已终态记录）。

## 7. 边界情况

| 情况 | 处置 |
|---|---|
| 输入不符 Input Contract（创建入口发现） | 落库前拒绝：`RejectedRequest`、无 Task、无 Trace（§3.1 分工表 ①） |
| 输入在落库后复验时不符（漂移窗口） | `Created → Failed: Input(contract_mismatch)`，有 Trace（§3.1 分工表 ③） |
| 取消请求到达时正在原子调用中 | 挂起取消标志，调用完成后迁移 Cancelled（「已 Cancelled 但副作用已发生」的状态错位不允许出现） |
| 同一 Agent 并发多任务 | 允许（版本不可变保证一致性；无共享可变状态） |
| 崩溃后重启又崩溃 | 幂等恢复，见 §6 |
| Paused 状态被外部写入 | 第一阶段无合法写入路径；出现即库被篡改，按防御性失败处置并显式记录 |

## 8. 关键假设 / 风险 / 待验证

| # | 内容 | 属性 |
|---|---|---|
| 1 | 「等待当前原子调用完成」的取消粒度 = 单次模型调用或单次工具执行 | 设计假设（取消延迟上限 = 最长原子调用时长） |
| 2 | SQLite 同步写保证「先持久化后继续」的崩溃一致性 | 已知事实（WAL 模式下单写者） |
| 3 | 崩溃恢复只标记不续跑 | 已知取舍（用户裁定范围；长任务第二阶段） |
| 4 | ApprovalRequest 8 字段（第 8 字段 = agentVersionId） | 已裁决落定（D-4），不再是开放点 |

## 9. WP-B 实现输入映射

| WP-B 模块 | 消费本文内容 |
|---|---|
| `TaskManager` | §1–§2 状态集与迁移表 → 状态机实现（含 attempt 自环）；§3 审计边界 |
| `StateManager` | §4 表结构；§6 崩溃恢复流程；不变式②（先持久化后继续） |
| `TraceRecorder` | 每条迁移的 Trace 事件触发（事件名见 A6） |
| `FailureRecorder` | `Created → Failed` / `Running → Failed` / 恢复路径的 FailureRecord 写入（分类按 A4） |
