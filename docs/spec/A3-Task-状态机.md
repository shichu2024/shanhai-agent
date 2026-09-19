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
| `Running → Running`（新 attempt） | 调用级失败/超时且 `attemptCount < maxAttempts` | attemptCount 更新 + Trace(AttemptFailed) | Model / Tool（attempt 级，不计任务失败） |
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
| 落库前拒绝 | `RejectedRequest` 审计记录（A6 §4）；不创建 Task、不进队列 |
| 落库后失败 | TaskRecord（终态 Failed）+ FailureRecord + Trace 事件 |

## 4. TaskRecord 字段表（SQLite）

| 字段 | 类型 | 约束 |
|---|---|---|
| `taskId` | TEXT PK | uuid v4 |
| `agentId` / `agentVersionId` / `specContentHash` | TEXT | **版本绑定快照**（创建时固化；T1 依赖） |
| `input` | TEXT | 任务输入 JSON（已过 Input Contract） |
| `status` | TEXT | §1 状态集 |
| `attemptCount` | INTEGER | 默认 0；Running 内递增 |
| `modelCallCount` / `tokensUsed` | INTEGER | 预算记账（tokensUsed 含 estimated 部分，另见 A6 usage 事件） |
| `consecutiveDenialCount` | INTEGER | 连续拦截计数（A2 §5） |
| `createdAt` / `startedAt` / `endedAt` | TEXT | RFC3339 |
| `traceFile` | TEXT | per-task JSONL 路径（A6） |
| `terminalFailureClass` | TEXT | 终态为 Failed 时填 A4 分类 |
| （预留）`evaluationId` / `evolutionCandidateId` | TEXT | 第二阶段外键，只留列 |

## 5. ApprovalRequest 结构预留（只定义不写入）

8 字段（03 号 §3.2 原 7 字段 + `agentVersionId`，补版本锚定以满足 T1 类查询模式；**此增补为本次设计变更点，提请评审确认**）：

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
| 输入不符 Input Contract | 落库前拒绝（RejectedRequest；§3 边界） |
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
| 4 | ApprovalRequest 8 字段（较 03 号 +1） | 设计变更点，待三角色确认 |

## 9. WP-B 实现输入映射

| WP-B 模块 | 消费本文内容 |
|---|---|
| `TaskManager` | §1–§2 状态集与迁移表 → 状态机实现（含 attempt 自环）；§3 审计边界 |
| `StateManager` | §4 表结构；§6 崩溃恢复流程；不变式②（先持久化后继续） |
| `TraceRecorder` | 每条迁移的 Trace 事件触发（事件名见 A6） |
| `FailureRecorder` | `Created → Failed` / `Running → Failed` / 恢复路径的 FailureRecord 写入（分类按 A4） |
