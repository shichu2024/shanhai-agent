# A3 · Task 生命周期状态机（attempt 模型）

> **文档状态：** 已冻结（v1 经 WP-A 评审冻结 + TASK-40 F-1 修订；v1.1 增补经 TASK-43 三角色对抗式流程终审签字，2026-09-19）
> **作者角色：** 方案设计师
> **日期：** 2026-09-19
> **上位依据：** 定稿 §5.1（冻结）；03 号 §3.2（迁移表原文，本表为其规格化）；05 号 P1-1/P1-2/备注-3；01 号 §5.1/§5.3–5.4；**v1.1：《第二阶段设计文档》V0.3（`docs/phase2/01`）D-8/D-9/D-13/D-16/D-18 + 终审 R-1/R-4**
> **WP-B 映射：** `TaskManager`（状态驱动）、`StateManager`（持久化/崩溃恢复）、`TraceRecorder`（迁移即事件）
> **重建的基线残缺：** §7.2 生命周期、§7.3/7.4（标题吞噬区）、§6.9 输入校验时序
> **v1.1 修订注记（2026-09-19，TASK-43 终审）：** Paused 空壳激活（审批挂起，D-18 挂起即退出模型——**`Paused → Running` 迁移权归 `--resume` 进程，approve 只写 decision**，终审 R-1）；新增 abort 中止级与 PauseSnapshot 最小检查点（§5a）；恢复扫描补 Paused 语义（§6 v1.1 修订注记）。推导全文：`docs/phase2/01` §4.1/§4.3。

---

## 1. 状态集（7 状态）

`Created / Queued / Running / Paused / Succeeded / Failed / Cancelled`

| 状态 | 语义 | 备注 |
|---|---|---|
| `Created` | TaskRecord 已落库，尚未通过任务时校验 | 审计边界的关键态（§3） |
| `Queued` | 校验通过、已入队，等待调度 | |
| `Running` | 执行中；重试 = Running 内**新 attempt**（自环），不离开 Running | attemptCount 计入 TaskRecord |
| `Paused` | 审批挂起（v1 空壳 → **v1.1 激活**，D-18）：持久化的合法长驻状态，run 进程已退出，等审批裁决 + `--resume` 续跑 | 副作用即被冻结等待审批的那个调用，尚未发生——**不进恢复扫描**（§6） |
| `Succeeded` | 真终态，无出边 | |
| `Failed` | 真终态，无出边；归因由 A4 failureClass 承载 | |
| `Cancelled` | 真终态，无出边 | |

**不变式（冻结）：** ① Succeeded/Failed/Cancelled 为真终态，无出边；② 每条迁移**先持久化后继续**（写库成功才执行状态副作用）；③ 状态迁移即 Trace 事件（A6）；④ Timeout 非独立状态——任务级/调用级超时分别映射为 Failed 的 failureClass。

## 2. 完整迁移表（三列：触发事件 / 持久化点 / A4 映射；v1.1 增行加粗标注）

| 迁移 | 触发事件 | 持久化点（先写后行） | A4 失败分类映射 |
|---|---|---|---|
| `Created → Queued` | Spec 与 Input Contract 防御性校验通过，入队 | TaskRecord.status + Trace(TaskQueued) | — |
| `Created → Failed` | 落库后校验失败（Spec/防御性重复/Input Contract 不符） | TaskRecord + FailureRecord + Trace(TaskFailed) | Input / Spec |
| `Queued → Running` | 调度器取出执行 | TaskRecord + Trace(TaskStarted) | — |
| `Queued → Cancelled` | 用户取消（等待中，无副作用；**v1.1：abort 到达亦立即**） | TaskRecord + Trace(TaskCancelled) | — |
| `Running → Running`（新 attempt） | 调用级失败/超时且**该逻辑调用的** `attemptNo(callNo, kind) < maxAttempts`（计数粒度见 A2 §2.1：调用键 = callNo × kind，判定用调用级计数器，不落 TaskRecord） | Trace(AttemptFailed，含 callNo/callKind/attemptNo) + TaskRecord.attemptCount 聚合展示更新 | Model / Tool（attempt 级，不计任务失败） |
| **`Running → Paused`（v1.1）** | L3 工具请求且 approvalPolicy.mode=onHighRisk：写 PauseSnapshot（先持久化，§5a）→ 写 ApprovalRequest（§5）→ 迁移 → **run 进程正常退出**（exit code 提示待审批） | PauseSnapshot + ApprovalRequest + TaskRecord + Trace(TaskPaused/ApprovalRequested) | — |
| **`Paused → Running`（v1.1，迁移权归 resume 进程——终审 R-1）** | `task run --resume <taskId>` 进程内：校验 Paused ∧ 存在 decision=approved ∧ snapshot 完整 → **同进程完成迁移（先持久化）+ 反序列化 + 从 nextCallRef 继续执行**。approve 命令只写 decision=approved（任务保持 Paused），可选 spawn resume；spawn 失败/崩溃由 manual-resume 兜底 | TaskRecord + Trace(TaskResumed, resumedBy=approve-spawn/manual-resume) | — |
| **`Paused → Cancelled`（v1.1）** | ① deny（cancelReason=approval_denied）；② 超时-deny（approval_timeout）；③ graceful/abort cancel 到达挂起任务（立即——挂起态无在飞原子调用；cancelReason=user/abort）；④ 超时-fail 走 Paused→Failed。任一路径：关联 ApprovalRequest 置 `decision=superseded`（cancel 到达时）/ denied（拒绝时）+ **删 PauseSnapshot** | TaskRecord + ApprovalRequest + Trace(TaskCancelled) | deny/超时-deny → Cancelled（无 FailureRecord）；**超时-fail → Policy(ApprovalTimeout)** |
| **`Paused → Failed`（v1.1）** | 审批超时且 onTimeout=fail | TaskRecord + FailureRecord + Trace(TaskFailed) | Policy(ApprovalTimeout) |
| `Running → Succeeded` | 输出契约校验通过 | TaskRecord + Trace(TaskSucceeded) | — |
| `Running → Failed` | ① attempt 耗尽；② 任务级超时（**Paused 期间暂停计时**，v1.1：TaskRecord.pausedDurationMs 累计）；③ 预算超限；④ 连续拦截超限；⑤ 输出契约失败 | TaskRecord + FailureRecord + Trace(TaskFailed) | Model / Tool / Runtime(BudgetExceeded/TaskTimeout) / Policy(PolicyBlocked) / Output(ContractViolation) |
| `Running → Cancelled` | graceful 取消：**等待当前原子调用完成后生效**；**abort 取消（v1.1，`cancel --force`）**：不等待——放弃模型调用 Promise（AbortController）/ 尽力终止工具子进程（不可中断则等返回丢弃结果），立即迁移（cancelReason=abort，载荷 abortedDuring={callNo,callKind,phase}）；**跨进程（v1.1）**：另一进程 Running 中任务 → 写 abortRequested 标志，执行进程在下一原子调用边界执行 | TaskRecord + Trace(TaskCancelled) | — |
| （恢复）`Running 遗留 → Failed` | 进程重启发现 Running 遗留任务（§6；Queued/Paused 不迁移——TASK-40 F-1 + TASK-43 v1.1） | TaskRecord + FailureRecord + Trace + **顺带删该 taskId 的 PauseSnapshot（孤儿快照兜底，终审 R-4）** | Runtime(CrashRecovery) |

**cancelReason 封闭枚举（v1.1）：** `user / approval_denied / approval_timeout / abort / superseded`——互斥，落 TaskRecord 与 `task_cancelled` 事件。abort 语义边界：**Runtime 放弃等待，不是副作用回滚**——已发生的外部副作用不撤销，Trace 如实记录中止时点。

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
| `abortRequested` | INTEGER | **v1.1**：0/1；跨进程 abort 持久化标志（执行进程在原子调用边界检查） |
| `pausedDurationMs` | INTEGER | **v1.1**：Paused 累计时长；任务级超时在挂起期间暂停计时 |
| `assignmentSource` | TEXT | **v1.1**：`stable / canary / explicit`；灰度分派留痕（A5 v1.1 §4a） |
| `parentTaskId` | TEXT | **v1.1（D-16）**：委托数据模型唯一锚点（NULL = 根任务）；委托编排器与治理规则第三阶段规格化 |
| （预留）`evaluationId` / `evolutionCandidateId` | TEXT | v1 预留；**v1.1 激活写入**（A5 review 回填 / EvolutionCandidate 关联，A1 §2.3） |

## 5. ApprovalRequest（v1 结构预留 → v1.1 激活，D-4/D-8/D-9/D-18）

8 字段（03 号 §3.2 原 7 字段 + `agentVersionId`；**D-4 已裁决：`agentVersionId` 定为第 8 字段**——T1 类查询的版本锚定）+ v1.1 增补 2 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | TEXT PK | |
| `taskId` | TEXT | |
| `agentVersionId` | TEXT | 审批时生效版本（版本固定原则；approve 校验 == TaskRecord.agentVersionId，防跨任务误用） |
| `toolId` | TEXT | |
| `riskLevel` | TEXT | L0–L4（实际触发仅为 L3） |
| `requestedAt` | TEXT | |
| `decision` | TEXT | 枚举：`pending / approved / denied / superseded`（**superseded 为 v1.1 增**：任务先行终结时作废，不产生假裁决） |
| `decidedAt` | TEXT | |
| `timeoutAt` | TEXT | **v1.1**：= requestedAt + approvalPolicy.timeoutMs；惰性超时判定锚点 |
| `callRef` | TEXT | **v1.1**：挂起时调用键（与 PauseSnapshot.nextCallRef 一致） |

**v1.1 行为规则（D-18 挂起即退出 + 终审 R-1）：** ① 每次挂起前序 = 写 PauseSnapshot → 写 ApprovalRequest → `Running → Paused` → run 进程退出（先持久化后迁移）；② **approve 只写 decision=approved（任务保持 Paused）**，可选前台 spawn `task run --resume`（spawn 失败不回滚 decision、不影响任务状态）；③ **`Paused → Running` 迁移权归 resume 进程**：校验 → 迁移（先持久化）→ 同进程反序列化 → 继续执行——任意时刻崩溃，任务要么 Paused（合法长驻）要么已在执行进程手中，无「Running 且无执行进程」悬空窗口；④ deny 与超时-deny = 任务级终局 Cancelled；⑤ 超时判定惰性执行（approval list / approve / --resume 触碰时 + report 旁挂超时计数单列），无后台定时器进程。

## 5a. PauseSnapshot 表（v1.1 新增，审批挂起点专用最小检查点，D-18）

| 字段 | 类型 | 约束 |
|---|---|---|
| `taskId` | TEXT PK | 与 TaskRecord 一对一（挂起期间） |
| `contextJson` | TEXT | 模型对话消息数组（含系统提示、历史调用与结果）序列化 |
| `callCounters` | TEXT | 各调用键（callNo × callKind）的 attemptNo 计数器序列化（A2 §2.1 运行期计数器的持久化载体——仅审批挂起场景） |
| `nextCallRef` | TEXT | 挂起时点的调用键（恢复后执行的动作） |
| `savedAt` | TEXT | RFC3339 |

**生命周期：** 任务离开 Paused（resume 迁移后 / deny / timeout / abort）时**即删**；孤儿快照（snapshot 写后、Paused 迁移前进程被 kill → 任务留 Running → CrashRecovery）由**恢复扫描与 CrashRecovery 终局迁移兜底删除**（终审 R-4）。它是执行态暂存，不是审计对象（审计由 Trace 事件承载）；不随发布物分发。**范围声明：** 本表是审批挂起点专用检查点，**不是任意断点续跑**——Running 中途崩溃仍 CrashRecovery 终局（§6 语义不变）。

## 6. 崩溃恢复（StateManager 最小版）

> **TASK-40 F-1 修订（2026-09-19，决策官方向性裁定落稿）：** 恢复扫描范围由 `status ∈ {Queued, Running}` 收窄至**仅 Running**。原表述与文档化 CLI 分两进程工作流（`task create` 与 `task run` 各为一独立进程，README 快速开始）冲突：run 进程启动即扫描，会把尚未执行的 Queued 任务误迁移为 `Failed:Runtime(CrashRecovery)`，任务永不可经文档化工作流执行（单进程路径不暴露，故单测与实验均未发现）。

**扫描范围（收窄后）：** 重启时扫描 `status = 'Running'` 的遗留记录 → 逐条迁移 `→ Failed`，failureClass = `Runtime(CrashRecovery)`，补写 FailureRecord + Trace。**不做断点续跑**（Checkpoint 属第二阶段）；恢复本身幂等（二次重启不再改写已终态记录）。

**收窄判别准则：** 恢复迁移仅针对**有执行副作用的中间态**。Running 可能已有已发生的模型调用、工具执行与预算记账，不迁移会使副作用状态悬空（预算已扣、终态缺失）；Queued 尚无任何执行副作用，不存在需要恢复之物。

**Queued 语义（澄清）：** Queued = 持久化的待执行（durable pending）。重启扫描**不改写** Queued 记录；任何后续 `task run` 进程（或实验 runner）按常规迁移 `Queued → Running` 取出执行。队列的崩溃安全性由不变式②（先持久化后继续）提供——`task_queued` 事件与 `status='queued'` 均已落 SQLite，无内存态队列需要重建。分两进程 create→run 因此天然成立（run 进程的启动扫描不触碰待执行任务）；CLI 同进程 create+run 复合入口为**可选补充，非修复本体**，不改变本节语义。

**Queued 真丢失防护（入队进程死亡且无人执行）——最小手段边界：** 允许且仅允许**只读警示**：恢复扫描可在 RecoveryReport 单列 `staleQueuedTasks`（判定 = `createdAt` 距今超过宽限窗；宽限窗为天级量级配置项，具体默认值 WP-B 定，不进规格）。不改状态、不写 FailureRecord、不写 Trace。**禁止**引入持久租约、所有权标记、心跳/续约字段等重机制（第二阶段亦不默认引入）。理由：若将 stale Queued 迁移为终态，宽限窗判定与「即将被 `task run` 取出」存在竞争，会重新制造 F-1 类误判；第一阶段 CLI 模型下 Queued 任务的 liveness 由操作者显式负责（`task run <taskId>`），规格只保证其**可执行性**不被恢复扫描破坏。

**与 A6 §6.1 的关系：** 索引对账遍历**全部** task（含 Queued 与终态），不受本次收窄影响；次序约束（索引对账先于崩溃标记）维持不变。

**v1.1 修订注记（2026-09-19，TASK-43 终审 D-18 + R-4）：** 恢复扫描范围 = **仅 Running**（维持 F-1 收窄，Queued/Paused 均不迁移）。**Paused 是持久化的合法长驻状态**——副作用即被冻结等待审批的那个调用，尚未发生，无「副作用悬空」需要恢复；恢复扫描将其误迁移会处决已获批准的任务（F-1 同型缺陷，显式排除）。增补三件事：① **stalePausedTasks 只读警示单列**（Paused 且已超时未被惰性判定——提示操作者跑 `approval list`，不改状态）；② **孤儿 PauseSnapshot 兜底清理**——恢复扫描与 CrashRecovery 终局迁移顺带删除该 taskId 的 snapshot（该任务从未进入 Paused，不触发常规清理）；③ **审批超时惰性判定**——任意进程触碰 Paused 任务且 now > timeoutAt 时按 onTimeout 迁移（deny→Cancelled / fail→Failed:Policy(ApprovalTimeout)），无后台定时器进程。

## 7. 边界情况

| 情况 | 处置 |
|---|---|
| 输入不符 Input Contract（创建入口发现） | 落库前拒绝：`RejectedRequest`、无 Task、无 Trace（§3.1 分工表 ①） |
| 输入在落库后复验时不符（漂移窗口） | `Created → Failed: Input(contract_mismatch)`，有 Trace（§3.1 分工表 ③） |
| 取消请求到达时正在原子调用中 | 挂起取消标志，调用完成后迁移 Cancelled（「已 Cancelled 但副作用已发生」的状态错位不允许出现） |
| 同一 Agent 并发多任务 | 允许（版本不可变保证一致性；无共享可变状态） |
| 崩溃后重启又崩溃 | 幂等恢复，见 §6 |
| CLI 分两进程 create→run（run 进程启动触发恢复扫描） | Queued 不在扫描范围（§6 收窄），任务正常执行；仅 Running 遗留被标记（TASK-40 F-1） |
| Paused 状态被外部写入 | 第一阶段无合法写入路径；出现即库被篡改，按防御性失败处置并显式记录 |

## 8. 关键假设 / 风险 / 待验证

| # | 内容 | 属性 |
|---|---|---|
| 1 | 「等待当前原子调用完成」的取消粒度 = 单次模型调用或单次工具执行 | 设计假设（取消延迟上限 = 最长原子调用时长） |
| 2 | SQLite 同步写保证「先持久化后继续」的崩溃一致性 | 已知事实（WAL 模式下单写者） |
| 3 | 崩溃恢复只标记不续跑；扫描范围 = 仅 Running 遗留 | 已知取舍（用户裁定范围；长任务第二阶段）+ 已裁决落定（TASK-40 F-1，2026-09-19） |
| 4 | ApprovalRequest 8 字段（第 8 字段 = agentVersionId） | 已裁决落定（D-4），不再是开放点 |

## 9. WP-B 实现输入映射

| WP-B 模块 | 消费本文内容 |
|---|---|
| `TaskManager` | §1–§2 状态集与迁移表 → 状态机实现（含 attempt 自环）；§3 审计边界 |
| `StateManager` | §4 表结构；§6 崩溃恢复流程；不变式②（先持久化后继续） |
| `TraceRecorder` | 每条迁移的 Trace 事件触发（事件名见 A6） |
| `FailureRecorder` | `Created → Failed` / `Running → Failed` / 恢复路径的 FailureRecord 写入（分类按 A4） |
