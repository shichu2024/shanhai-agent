import type Database from 'better-sqlite3';
import { uuid, sha256Hex } from '../hash.js';
import { nowNs, type TraceRecorder } from './traceRecorder.js';
import { FailureRecorder, AuditRecorder } from './recorders.js';
import type { Registry } from './registry.js';
import type { StateManager } from './stateManager.js';
import type { ModelGateway, BudgetLedger, BudgetExceededError, TerminalModelFailure } from './modelGateway.js';
import { PolicyBlockedError, ToolTerminalFailure, type SpecToolDeclaration } from './toolExecutor.js';
import type { ApprovalManager } from './approval.js';
import type { MemoryManager } from './memory.js';
import { checkInputContract, validateDefensive } from './specValidator.js';
import { redactValue, type RedactionPolicy } from './redaction.js';
import { contentHash } from '../hash.js';
import {
  runAgentLoop, ExecutorSucceeded, CancelRequestedSignal, TaskTimeoutSignal, TaskAbortedSignal, AbortRaceMarker,
  ApprovalPauseSignal, DelegationPauseSignal, promptHashOf, type ExecSpec, type PauseContext,
} from '../runtime/executor.js';
import type { DelegatePrimitive } from './toolExecutor.js';
import type { FailureClass, FailureSubClass, TaskStatus, TraceEventType } from '../types.js';

// A3 状态机驱动 + 审计边界一行规则：
// TaskRecord 落库前的校验失败 → RejectedRequest 审计（不创建 Task）；
// 落库后的任何校验失败（含防御性重复校验）→ Created→Failed。
// v1.1（D-18 + 终审 R-1）：挂起即退出——approve 只写 decision，Paused→Running 迁移权归 --resume 进程；
// v1.1（A3 §2）：abort 两级取消 + 跨进程 abortRequested + graceful×Paused 立即迁移。

export interface TaskRow {
  taskId: string;
  agentId: string;
  agentVersionId: string;
  specContentHash: string;
  input: string;
  status: TaskStatus;
  attemptCount: number;
  modelCallCount: number;
  tokensUsed: number;
  consecutiveDenialCount: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  traceFile: string;
  terminalFailureClass: string | null;
  abortRequested: number;
  pausedDurationMs: number;
  cancelReason: string | null;
  assignmentSource: string | null;
  /** 第四阶段批次三（§4.4）：委托树治理元数据（补迁移落列见 db.ts 注记——A3 规格-实现漂移登记） */
  parentTaskId: string | null;
  delegationDepth: number;
}

export class TaskCreationRejected extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'TaskCreationRejected';
  }
}

/** --resume / cancel 的结构化结果提示 */
export interface CancelResult {
  taskId: string;
  mode: 'graceful' | 'abort';
  note: string;
}

class TaskLedger implements BudgetLedger {
  modelCallsIssued = 0;
  tokensUsed: number;
  estimatedTokens = 0;
  attemptsSucceeded = 0;
  attemptsFailedBySubClass: Record<string, number> = {};

  constructor(
    private readonly db: Database.Database,
    private readonly taskId: string,
    readonly maxModelCalls: number,
    readonly maxTokens: number,
  ) {
    const row = db.prepare('SELECT modelCallCount, tokensUsed FROM task_record WHERE taskId = ?').get(taskId) as { modelCallCount: number; tokensUsed: number };
    this.modelCallsIssued = row.modelCallCount;
    this.tokensUsed = row.tokensUsed;
  }

  account(usage: { inputTokens: number; outputTokens: number } | null, estimateTokens: number): void {
    this.modelCallsIssued += 1;
    if (usage) {
      this.tokensUsed += usage.inputTokens + usage.outputTokens;
    } else {
      this.tokensUsed += estimateTokens;
      this.estimatedTokens += estimateTokens;
    }
    this.db.prepare('UPDATE task_record SET modelCallCount = ?, tokensUsed = ? WHERE taskId = ?').run(this.modelCallsIssued, this.tokensUsed, this.taskId);
  }

  breakdown() {
    return {
      budget: { maxModelCalls: this.maxModelCalls, maxTokens: this.maxTokens },
      consumed: { modelCalls: this.modelCallsIssued, tokens: this.tokensUsed, estimatedTokens: this.estimatedTokens },
      attemptBreakdown: { succeeded: this.attemptsSucceeded, failedBySubClass: this.attemptsFailedBySubClass },
    };
  }
}

export interface TaskBase {
  taskId: string;
  agentId: string;
  agentVersionId: string;
  specContentHash: string;
}

export interface TaskManagerDeps {
  db: Database.Database;
  registry: Registry;
  trace: TraceRecorder;
  failures: FailureRecorder;
  state: StateManager;
  gateway: ModelGateway;
  toolImpls: Map<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;
  /** 第四阶段批次一（§4.2-3 调用桥）：external 工具分派（impls Miss 且 kind=external → MCP tools/call） */
  externalCall?: (toolId: string, args: Record<string, unknown>) => Promise<unknown>;
  audit: AuditRecorder;
  approvals: ApprovalManager;
  /** v1.1（D-13）：持久化记忆（终态计数钩子 + injection=context 注入构建） */
  memories: MemoryManager;
  /** v1.1（A5 §4a）：灰度分派随机源（0-99 整数；测试注入确定性，缺省 = 随机） */
  dispatchRoll?: () => number;
  /** 批次二（§4.2 DB 侧脱敏）：task_record.input / pause_snapshot.contextJson 入库前过同一 redaction 实例 */
  redaction: RedactionPolicy;
}

interface RunningCancelCtl {
  graceful(): void;
  abort(): void;
}

export interface RunOptions {
  /** v1.1（D-18）：--resume 续跑挂起任务（持有 Paused→Running 迁移权） */
  resume?: boolean;
  /** task_resumed 载荷（approve-spawn / manual-resume 双值均真实可达，终审 R-1） */
  resumedBy?: 'approve-spawn' | 'manual-resume';
}

export class TaskManager {
  private readonly runningCancels = new Map<string, RunningCancelCtl>();
  private readonly forceCancellers = new Map<string, string>();
  /** §4.4（批次三）：委托原语（组合根在构造后注入——Delegation 持有本实例引用，规避构造环） */
  private delegatePrimitive: DelegatePrimitive | null = null;

  constructor(private readonly deps: TaskManagerDeps) {}

  /** 组合根接线（Runtime）：委托原语注入 */
  useDelegate(primitive: DelegatePrimitive): void {
    this.delegatePrimitive = primitive;
  }

  /** 任务创建（A3 §3.1 双路径分工：落库前查请求合法性，落库后防世界漂移） */
  createTask(agentId: string, input: unknown, who: string, opts: { allowDraft?: boolean; allowReviewed?: boolean } = {}): string {
    const deps = this.deps;
    const { db, registry, trace } = deps;

    // ② 落库前：Spec 存在性与状态（指针指向 Released 版本；agentVersionId 不可解析时为 NULL——A6 §4）
    // v1.1（A5 §1）：Reviewed 可显式 --reviewed 测试运行（不进正式队列语义）；直发/Released 行为不变
    // v1.1（A5 §4a，D-12）：canaryWeight>0 时按概率分派 stable/canary 双指针 → agentVersionId 创建时一次性固化
    const stablePointer = registry.getPointer(agentId);
    const canary = registry.getCanary(agentId);
    const canaryActive = canary.canaryVersionId !== null && canary.canaryWeight > 0;
    const roll = deps.dispatchRoll ?? (() => Math.floor(Math.random() * 100));
    let pointer = stablePointer;
    let assignmentSource: 'stable' | 'canary' | 'explicit' = 'stable';
    if (canaryActive && stablePointer !== null && roll() < canary.canaryWeight) {
      pointer = canary.canaryVersionId;
      assignmentSource = 'canary';
    }
    if ((opts.allowDraft || opts.allowReviewed) && stablePointer !== null) {
      pointer = stablePointer; // 显式测试运行不参与灰度分派
      assignmentSource = 'explicit';
    }
    const version = pointer ? registry.getVersion(pointer) : null;
    const resolvable = version !== null && version.status === 'released';
    const draftable = opts.allowDraft === true && version !== null && version.status === 'draft';
    const reviewable = opts.allowReviewed === true && version !== null && version.status === 'reviewed';
    if (!resolvable && !draftable && !reviewable) {
      const reason = !version
        ? `agentId 不可解析或指针悬空：${agentId}`
        : `指针目标版本状态为 ${version.status}（任务仅可绑定 Released${opts.allowDraft || opts.allowReviewed ? ` 或 --draft Draft${opts.allowReviewed ? ' / --reviewed Reviewed' : ''}` : ''}）`;
      deps.audit.rejectedRequest({
        kind: 'task_creation', who, target: agentId, inputHash: sha256Hex(JSON.stringify(input ?? null)),
        rejectReason: JSON.stringify([{ path: '$', message: reason }]),
        agentVersionId: version?.versionId ?? null,
      });
      throw new TaskCreationRejected(reason, [{ path: '$', message: reason }]);
    }

    const spec = JSON.parse(version.specSnapshot) as ExecSpec & { inputContract: Record<string, unknown> };

    // ① 落库前：Input Contract 结构校验 → 拒绝即 RejectedRequest，无 Task、无 Trace
    const inputViolations = checkInputContract(input, spec.inputContract);
    if (inputViolations.length > 0) {
      const issues = inputViolations.map((v) => ({ path: v.path, message: `期望 ${v.expected}，实际 ${v.actual}` }));
      deps.audit.rejectedRequest({
        kind: 'task_creation', who, target: agentId, inputHash: sha256Hex(JSON.stringify(input ?? null)),
        rejectReason: JSON.stringify(issues), agentVersionId: version.versionId,
      });
      throw new TaskCreationRejected('输入不符 Input Contract（落库前拒绝，A3 §3.1-①）', issues);
    }

    // TaskRecord 落库（审计边界锚点；assignmentSource 固化——此后指针移动不影响已创建任务）
    // 批次二（§4.2）：input 入库前过管道（结构级 walk）——inputHash/契约校验仍按内存原文（§4.2 对账兜底），
    // 执行/续跑模型见 redacted 版 input（与 Trace/记忆 content 同口径，脱敏单向）。
    const taskId = uuid();
    const base = { taskId, agentId, agentVersionId: version.versionId, specContentHash: version.contentHash };
    db.prepare(
      `INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, createdAt, traceFile, assignmentSource)
       VALUES (?,?,?,?,?,'created',?,?,?)`,
    ).run(taskId, agentId, version.versionId, version.contentHash, JSON.stringify(redactValue(input ?? null, deps.redaction)), nowNs(), trace.traceFile(taskId), assignmentSource);
    trace.recordTaskEvent(base, 'task_created', {
      inputHash: sha256Hex(JSON.stringify(input ?? null)),
      input: input ?? null,
      inputContractHash: sha256Hex(JSON.stringify(spec.inputContract)),
      // A5 §4a：分派留痕——灰度期间任一任务可回溯「为什么进了金丝雀」
      assignmentSource,
      dispatchSnapshot: { stableVersionId: stablePointer, canaryVersionId: canary.canaryVersionId, canaryWeight: canary.canaryWeight },
    });

    // ③ 落库后防御性复验：Input Contract 同一校验器复跑（漂移窗口捕获，仅经此路径可达 Input(contract_mismatch)）
    const recheck = checkInputContract(input, spec.inputContract);
    if (recheck.length > 0) {
      trace.recordTaskEvent(base, 'contract_checked', { which: 'input', verdict: false, violations: recheck });
      this.failTask(taskId, base, 'Input', 'contract_mismatch', '创建时合法、复验时不合法（漂移窗口，A3 §3.1-③）',
        { expected: '符合 Input Contract', actual: '复验失败', violations: recheck });
      throw new TaskCreationRejected('防御性复验失败：Input(contract_mismatch)', recheck.map((v) => ({ path: v.path, message: `期望 ${v.expected}，实际 ${v.actual}` })));
    }
    trace.recordTaskEvent(base, 'contract_checked', { which: 'input', verdict: true, violations: [] });

    // ④ 落库后防御性复验：快照哈希比对 + 工具悬空引用 + 模型白名单漂移（P2-5）
    const actualHash = contentHash(spec);
    const defensive = validateDefensive(spec, version.contentHash, actualHash, {
      getTool: (toolId) => {
        const t = deps.registry.getTool(toolId);
        return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null;
      },
      modelWhitelist: deps.gateway.modelWhitelist,
    });
    if (!defensive.ok) {
      this.failTask(taskId, base, 'Spec', 'defensive_revalidation_failed', '防御性校验失败（快照/引用/白名单漂移）',
        { expected: '快照与运行时一致', actual: JSON.stringify(defensive.issues) });
      throw new TaskCreationRejected('防御性复验失败：Spec(defensive_revalidation_failed)', defensive.issues);
    }

    // Created → Queued（先持久化后继续）
    const queueDepth = (db.prepare(`SELECT COUNT(*) AS c FROM task_record WHERE status='queued'`).get() as { c: number }).c;
    deps.state.transition(taskId, 'queued');
    trace.recordTaskEvent(base, 'task_queued', { queueDepth });
    return taskId;
  }

  /** Queued → Running → 执行循环 → 终态（归因映射按 A4 §3，触发路径机械决定） */
  async runTask(taskId: string, strategy: 'native' | 'prompt' | null = null, opts: RunOptions = {}): Promise<TaskRow> {
    if (opts.resume) {
      return this.resumeTask(taskId, strategy, opts.resumedBy ?? 'manual-resume');
    }
    const { deps } = this;
    const row = this.getTask(taskId);
    if (row.status !== 'queued') {
      throw new Error(`任务 ${taskId} 状态为 ${row.status}，仅 Queued 可执行`);
    }
    const spec = JSON.parse(deps.registry.getVersion(row.agentVersionId)!.specSnapshot) as ExecSpec;
    const base = this.baseOf(row);

    // Queued → Running（CAS：先落库者生效——防双 run 进程重复执行）
    if (!deps.state.transition(taskId, 'running', { startedAt: nowNs() }, 'queued')) {
      throw new Error(`任务 ${taskId} 状态竞争：Queued→Running 迁移失败（另一进程已取出或状态已变更，当前 ${this.getTask(taskId).status}）`);
    }
    const bindingSnapshot = {
      toolVersions: spec.toolPolicy.tools.map((t) => {
        const reg = deps.registry.getTool(t.toolId);
        return { toolId: t.toolId, implVersion: reg?.implVersion ?? 'unresolved' };
      }),
      modelId: spec.modelPolicy.allowedModels[0],
      promptHash: promptHashOf(row.specContentHash), // P2-8：specContentHash 派生 convenience 字段
    };
    trace_event(deps, base, 'task_started', { bindingSnapshot });
    return this.executeLoop(taskId, row, spec, strategy);
  }

  /**
   * v1.1（A3 §2 / 终审 R-1）：`task run --resume` 持有 Paused→Running 迁移权——
   * 校验 Paused ∧ approved ∧ snapshot 完整 → 迁移（先持久化）+ Trace(task_resumed) → 同进程反序列化 → 从 nextCallRef 继续执行。
   */
  private async resumeTask(taskId: string, strategy: 'native' | 'prompt' | null, resumedBy: 'approve-spawn' | 'manual-resume'): Promise<TaskRow> {
    const { deps } = this;
    deps.approvals.applyLazyTimeouts(); // resume 触碰 Paused 任务即执行惰性超时判定（A3 §6 v1.1）
    const row = this.getTask(taskId);
    if (row.status !== 'paused') {
      if (deps.approvals.pendingForTask(taskId)) {
        throw new Error(`任务 ${taskId} 状态为 ${row.status}（审批仍 pending——先 approval approve/deny）`);
      }
      throw new Error(`任务 ${taskId} 状态为 ${row.status}（--resume 仅适用于 Paused）`);
    }
    // P1-1 修复（反方复现）：放行条件绑定当前挂起点——快照 nextCallRef 对应的那条请求必须
    // decision='approved' 且无 pending 在先。「按 taskId 查任意历史 approved」会旁路第二轮独立审批。
    const pending = deps.approvals.pendingForTask(taskId);
    if (pending) {
      throw new Error(`任务 ${taskId} 当前挂起点（callRef=${pending.callRef}）的审批请求仍 pending——先 approval approve/deny ${pending.requestId}`);
    }
    const snapshot = deps.approvals.getSnapshot(taskId);
    if (!snapshot) {
      throw new Error(`任务 ${taskId} 的 PauseSnapshot 缺失或损坏（任务留 Paused；操作者可 deny 或人工处置）`);
    }
    let resumeState: PauseContext;
    try {
      const parsed = JSON.parse(snapshot.contextJson) as Omit<PauseContext, 'toolCallNo'>;
      if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.assistantToolCalls)) throw new Error('结构不完整');
      const counters = JSON.parse(snapshot.callCounters) as { modelCallNo: number; toolCallNo: number };
      resumeState = { ...parsed, modelCallNo: parsed.modelCallNo ?? counters.modelCallNo, toolCallNo: counters.toolCallNo };
    } catch (err) {
      throw new Error(`任务 ${taskId} 的 PauseSnapshot 损坏（${(err as Error).message}；任务留 Paused，人工处置）`);
    }

    // pausedDurationMs 累计（A3 §4：任务级超时挂起期间暂停计时，挂钟 ≠ 执行时钟）
    const pausedDurationMs = (row.pausedDurationMs ?? 0) + (Date.now() - Date.parse(snapshot.savedAt));
    // 放行锚点 = 当前挂起点的请求（callRef = snapshot.nextCallRef）必须已 approved——每次 L3 调用独立审批
    const approved = deps.approvals.requestForCallRef(taskId, snapshot.nextCallRef);
    if (!approved || approved.decision !== 'approved') {
      throw new Error(
        `任务 ${taskId} 当前挂起点（callRef=${snapshot.nextCallRef}）无 decision=approved 的审批请求（先 approval approve；历史 approved 不放行新一轮挂起——每次 L3 调用独立审批）`,
      );
    }
    // Paused → Running 迁移（先持久化，R-1）——CAS 'paused'：迁移权在库层裁决（approve-spawn 与 manual-resume 并发时先落库者生效）
    if (!deps.state.transition(taskId, 'running', { pausedDurationMs }, 'paused')) {
      throw new Error(`任务 ${taskId} 迁移权竞争失败：Paused→Running 已由其他进程完成或状态已变更（当前 ${this.getTask(taskId).status}）`);
    }
    trace_event(deps, this.baseOf(row), 'task_resumed', { requestId: approved.requestId, resumedBy });
    deps.approvals.deleteSnapshot(taskId); // 离开 Paused 即删（A3 §5a 生命周期）

    const spec = JSON.parse(deps.registry.getVersion(row.agentVersionId)!.specSnapshot) as ExecSpec;
    return this.executeLoop(taskId, this.getTask(taskId), spec, strategy, { resumeState, timeoutCreditMs: pausedDurationMs });
  }

  /** 执行循环 + 终态归因（正常与 resume 共用；挂起信号在此落库并返回 Paused 行）。
   *  批次三（§4.4）：loopOpts.parentCancel = 嵌套子循环的父取消检查注入（P2-2 线程化）。 */
  private async executeLoop(
    taskId: string,
    row: TaskRow,
    spec: ExecSpec,
    strategy: 'native' | 'prompt' | null,
    loopOpts: { resumeState?: PauseContext; timeoutCreditMs?: number; parentCancel?: { requested(): boolean } } = {},
  ): Promise<TaskRow> {
    const { deps } = this;
    const base = this.baseOf(row);
    const ledger = new TaskLedger(deps.db, taskId, spec.modelPolicy.maxModelCalls, spec.modelPolicy.maxTokens);
    let cancelRequested = false;
    let abortReject: ((e: AbortRaceMarker) => void) | null = null;
    // P2-2 修复：resume 段同样持有 abort 竞速——本进程 --force 立即生效语义对续跑段一致；
    // no-op catch 防竞速挂接前被 reject 的 unhandledRejection（不影响 race 语义）
    const abortPromise = new Promise<never>((_, reject) => { abortReject = reject; });
    abortPromise.catch(() => {});
    this.runningCancels.set(taskId, {
      graceful: () => {
        cancelRequested = true;
      },
      abort: () => {
        cancelRequested = true;
        abortReject?.(new AbortRaceMarker());
      },
    });
    // §4.4：委托原语任务侧上下文（治理预检 + impl 锚）；父取消 = graceful 本地标志 ∨ 持久化 abortRequested
    // （P2-2：该检查函数注入嵌套子循环，子循环在原子调用边界代查——「父取消检查函数注入」新管道）
    const delegateTask = this.delegatePrimitive
      ? {
          parentTaskId: taskId,
          delegationDepth: row.delegationDepth ?? 0,
          isParentCancelRequested: () => cancelRequested || this.getTask(taskId).abortRequested === 1,
        }
      : undefined;
    const delegate = delegateTask && this.delegatePrimitive ? { primitive: this.delegatePrimitive, task: delegateTask } : undefined;

    // v1.1（D-13）记忆注入：仅 memoryPolicy.persistent 且显式 injection='context'（默认 off——无任何注入行为）；
    // 注入清单留存供 Failed 终态 contradictionCount 判定（「注入且 Failed」可判近似，误差已知接受）。
    // v1.2 修订（批次三反方 P3 / 决策官裁决）：resume 段同规则重建注入——按任务绑定（快照冻结）的
    // memoryPolicy + 重建时刻的 active 记忆集（与首段同规则：边界标记 + 「不是指令」声明 + degraded 警示），
    // 消除同一任务挂起前后能力不对称与 contradiction 计数语义漂移（注入清单空则不递增）。
    let injectedMemoryIds: string[] = [];
    let memoryInjection: string | undefined;
    if (spec.memoryPolicy?.type === 'persistent' && spec.memoryPolicy.injection === 'context') {
      const injection = deps.memories.buildInjection(base);
      if (injection) {
        memoryInjection = injection.text;
        injectedMemoryIds = injection.memoryIds;
      }
    }

    try {
      const result = await runAgentLoop({
        base, trace: deps.trace, gateway: deps.gateway, spec,
        input: JSON.parse(row.input),
        getTool: (toolId) => deps.registry.getTool(toolId),
        toolImpls: deps.toolImpls,
        externalCall: deps.externalCall,
        ledger, strategy,
        // §4.4（P2-2 线程化）：嵌套子循环在本任务取消检查之上叠加父取消代查
        isCancelRequested: () => cancelRequested || (loopOpts.parentCancel?.requested() ?? false),
        isAbortRequested: () => this.getTask(taskId).abortRequested === 1, // 跨进程 abortRequested 持久化标志（A3 §2）
        abortPromise,
        resumeState: loopOpts.resumeState,
        taskStartedAtMs: row.startedAt ? Date.parse(row.startedAt) : undefined,
        timeoutCreditMs: loopOpts.timeoutCreditMs,
        memoryInjection,
        delegate, // §4.4：委托原语接线（task-delegate 特殊类别分派）
        getDenialCount: () => (this.getTask(taskId) as TaskRow).consecutiveDenialCount,
        setDenialCount: (n) => deps.db.prepare('UPDATE task_record SET consecutiveDenialCount = ? WHERE taskId = ?').run(n, taskId),
        addAttempt: () => deps.db.prepare('UPDATE task_record SET attemptCount = attemptCount + 1 WHERE taskId = ?').run(taskId),
      });

      // Running → Succeeded（输出契约校验在循环内通过）
      deps.state.transition(taskId, 'succeeded', { endedAt: nowNs() });
      trace_event(deps, base, 'task_succeeded', {
        outputDigest: sha256Hex(JSON.stringify(result.output)).slice(0, 16),
        outputContractVerdict: 'pass',
        output: result.output,
      });
      // v1.1（D-13 / F-7）：Succeeded 终态同步写入记忆（content 过同一脱敏管道；独立印证计数）
      const memPolicy = spec.memoryPolicy;
      if (memPolicy?.type === 'persistent') {
        deps.memories.onSucceeded(base, result.output, { ...memPolicy, type: 'persistent' });
      }
      return this.getTask(taskId);
    } catch (err) {
      if (err instanceof ApprovalPauseSignal) {
        // 取消优先于挂起（MEDIUM-3）：cancel 已置位时不落 Paused——取消意图不被审批挂起吞掉
        if (cancelRequested) {
          this.mapTerminalFailure(taskId, base, spec, ledger, new CancelRequestedSignal());
          return this.getTask(taskId);
        }
        if (this.getTask(taskId).abortRequested === 1) {
          this.mapTerminalFailure(taskId, base, spec, ledger, new TaskAbortedSignal({ callNo: 0, callKind: 'model', phase: 'boundary' }));
          return this.getTask(taskId);
        }
        return this.persistPause(taskId, base, spec, err.pause);
      }
      if (err instanceof DelegationPauseSignal) {
        // §4.4 委托等待挂起（R-2 写序：子 PauseSnapshot 已先行落库）：取消/中止优先，同 MEDIUM-3；
        // 复审 HIGH-1 修复：父在委托边界因取消/中止终局时，取消传播同样覆盖非终态子任务（与 cancel() paused 分支同不变式）
        if (cancelRequested) {
          this.cancelDescendants(taskId, this.forceCancellers.get(taskId) ?? 'runtime');
          this.mapTerminalFailure(taskId, base, spec, ledger, new CancelRequestedSignal());
          return this.getTask(taskId);
        }
        if (this.getTask(taskId).abortRequested === 1) {
          this.cancelDescendants(taskId, this.forceCancellers.get(taskId) ?? 'runtime');
          this.mapTerminalFailure(taskId, base, spec, ledger, new TaskAbortedSignal({ callNo: 0, callKind: 'model', phase: 'boundary' }));
          return this.getTask(taskId);
        }
        return this.persistDelegationWait(taskId, base, err.pause);
      }
      // §4.4（P2-2 线程化）：嵌套子循环因父取消在原子调用边界中止 → 子 Cancelled(superseded)
      if (err instanceof CancelRequestedSignal && (loopOpts.parentCancel?.requested() ?? false)) {
        this.deps.state.transition(taskId, 'cancelled', { endedAt: nowNs(), cancelReason: 'superseded' });
        trace_event(this.deps, base, 'task_cancelled', {
          cancelReason: 'superseded', mode: 'graceful',
          note: '父任务取消传播（P2-2 线程化：子循环原子调用边界代查父取消标志）',
        });
        return this.getTask(taskId);
      }
      // §4.4：委托原语重抛的父取消信号伴随持久化 abortRequested → 按 abort 语义终局（跨进程 force 中止）
      if (err instanceof CancelRequestedSignal && this.getTask(taskId).abortRequested === 1) {
        this.mapTerminalFailure(taskId, base, spec, ledger, new TaskAbortedSignal({ callNo: 0, callKind: 'model', phase: 'boundary' }));
        return this.getTask(taskId);
      }
      this.mapTerminalFailure(taskId, base, spec, ledger, err);
      // v1.1（D-13 / F-7）：Failed 终态同步——注入列表逐条 contradictionCount+1（注入清单在 memory_loaded 已留痕）
      if (spec.memoryPolicy?.type === 'persistent' && injectedMemoryIds.length > 0) {
        deps.memories.onFailed(base, injectedMemoryIds);
      }
      return this.getTask(taskId);
    } finally {
      this.runningCancels.delete(taskId);
      this.forceCancellers.delete(taskId);
    }
  }

  /** 挂起序列（A3 §2 v1.1，次序冻结）：写 PauseSnapshot → 写 ApprovalRequest → Running→Paused → Trace → run 进程退出 */
  private persistPause(taskId: string, base: TaskBase, spec: ExecSpec, pause: PauseContext & { toolId: string }): TaskRow {
    const { deps } = this;
    const { toolId, toolCallNo, ...contextOnly } = pause; // contextJson = 对话消息数组（含挂起批次与已执行结果）
    void toolCallNo;
    const timeoutMs = spec.approvalPolicy?.timeoutMs ?? 86400000; // A1 §2.2 默认 24h
    // 批次二（§4.2，D-20 冻结口径）：快照落库前对解析后结构过管道（messages/assistantToolCalls/resultsSoFar
    // 全部自由文本递归改写；*Digest/*Hash 排除表零改写）——禁止对序列化字符串做正则替换。
    // 结构完整性由 walk 保形：脱敏后可解析、消息数不变（resume 语义：续跑模型见 redacted 上下文，§7-#2）。
    deps.approvals.saveSnapshot(
      taskId,
      JSON.stringify(redactValue(contextOnly, deps.redaction)),
      JSON.stringify({ modelCallNo: pause.modelCallNo, toolCallNo: pause.toolCallNo }), // A2 §2.1 计数器持久化载体
      String(pause.toolCallNo), // nextCallRef
    );
    const request = deps.approvals.createRequest(base, toolId, String(pause.toolCallNo), timeoutMs);
    deps.state.transition(taskId, 'paused');
    trace_event(deps, base, 'task_paused', { reason: 'high_risk_tool', requestId: request.requestId, callRef: request.callRef });
    trace_event(deps, base, 'approval_requested', {
      requestId: request.requestId, toolId, riskLevel: 'L3', timeoutAt: request.timeoutAt, callRef: request.callRef,
    });
    return this.getTask(taskId);
  }

  /**
   * §4.4（批次三）：委托等待挂起落库（R-2 写序第 2 步——子 PauseSnapshot 已在第 1 步先行落库）：
   * 父 PauseSnapshot（载荷含 delegation.childTaskId 锚）→ Running→Paused → Trace(task_paused)。
   * 不创建新 ApprovalRequest——第二次人工介入挂子 taskId（子的 ApprovalRequest），委托本身已由
   * 第一次父级审批放行（resume 放行锚点 requestForCallRef(nextCallRef) 复用该 approved 请求，幂等可重复 resume）。
   */
  private persistDelegationWait(taskId: string, base: TaskBase, pause: PauseContext & { toolId: string; childTaskId: string; note: string }): TaskRow {
    const { deps } = this;
    const { toolId, toolCallNo, childTaskId, note, ...contextOnly } = pause;
    void toolId;
    // 快照载荷：PauseContext + delegation 锚（同 persistPause 过同一脱敏管道——结构级 walk 保形）
    const contextWithAnchor = { ...contextOnly, delegation: { childTaskId, note } };
    deps.approvals.saveSnapshot(
      taskId,
      JSON.stringify(redactValue(contextWithAnchor, deps.redaction)),
      JSON.stringify({ modelCallNo: pause.modelCallNo, toolCallNo: pause.toolCallNo }),
      String(pause.toolCallNo), // nextCallRef（与首次审批挂起同锚点——approved 请求复用）
    );
    deps.state.transition(taskId, 'paused');
    trace_event(deps, base, 'task_paused', {
      reason: 'delegation_child_wait', childTaskId, callRef: String(pause.toolCallNo),
      note: `${note}（resume 时序规范：先子后父；父幂等保持 Paused）`,
    });
    return this.getTask(taskId);
  }

  /**
   * §4.4（批次三）：委托原语驱动的嵌套子执行（阻塞式，runAgentLoop 递归经此入 TaskManager 全链）。
   * 父取消检查注入（P2-2）：子循环在原子调用边界代查 graceful/abort。
   */
  async runDelegatedChild(taskId: string, parentCancel: { requested(): boolean }): Promise<TaskRow> {
    const { deps } = this;
    const row = this.getTask(taskId);
    if (row.status !== 'queued') {
      throw new Error(`委托子任务 ${taskId} 状态为 ${row.status}，仅 Queued 可嵌套执行`);
    }
    const spec = JSON.parse(deps.registry.getVersion(row.agentVersionId)!.specSnapshot) as ExecSpec;
    const base = this.baseOf(row);
    if (!deps.state.transition(taskId, 'running', { startedAt: nowNs() }, 'queued')) {
      throw new Error(`委托子任务 ${taskId} 状态竞争：Queued→Running 迁移失败（当前 ${this.getTask(taskId).status}）`);
    }
    const bindingSnapshot = {
      toolVersions: spec.toolPolicy.tools.map((t) => {
        const reg = deps.registry.getTool(t.toolId);
        return { toolId: t.toolId, implVersion: reg?.implVersion ?? 'unresolved' };
      }),
      modelId: spec.modelPolicy.allowedModels[0],
      promptHash: promptHashOf(row.specContentHash),
    };
    trace_event(deps, base, 'task_started', { bindingSnapshot, delegatedFrom: row.parentTaskId });
    return this.executeLoop(taskId, this.getTask(taskId), spec, null, { parentCancel });
  }

  /** §4.4 孤儿处置：父终局（取消）时取消传播覆盖已创建的非终态子任务（superseded）。 */
  private cancelDescendants(parentTaskId: string, who: string): void {
    const { deps } = this;
    const children = deps.db.prepare('SELECT taskId, status FROM task_record WHERE parentTaskId = ?').all(parentTaskId) as { taskId: string; status: string }[];
    for (const c of children) {
      if (c.status === 'succeeded' || c.status === 'failed' || c.status === 'cancelled') continue;
      // 子 Paused/Queued/Created：立即迁移 superseded + pending 审批作废 + 删快照；
      // 子 Running 不可达（嵌套中父必在执行，§4.4 崩溃窗口矩阵），到达即按 superseded 终局兜底
      if (!deps.state.transition(c.taskId, 'cancelled', { endedAt: nowNs(), cancelReason: 'superseded' })) continue;
      deps.approvals.supersedePending(c.taskId, who);
      deps.approvals.deleteSnapshot(c.taskId);
      const childRow = this.getTask(c.taskId);
      trace_event(deps, this.baseOf(childRow), 'task_cancelled', {
        cancelReason: 'superseded', mode: 'graceful',
        note: '父任务取消传播（孤儿处置：取消传播覆盖，§4.4）',
      });
    }
  }

  private mapTerminalFailure(taskId: string, base: TaskBase, _spec: ExecSpec, ledger: TaskLedger, err: unknown): void {
    if (err instanceof ExecutorSucceeded) throw err; // 不可达防御
    if (err instanceof CancelRequestedSignal) {
      this.deps.state.transition(taskId, 'cancelled', { endedAt: nowNs(), cancelReason: 'user' });
      trace_event(this.deps, base, 'task_cancelled', {
        cancelReason: 'user', mode: 'graceful',
        note: '用户取消（等待当前原子调用完成后生效）',
      });
      return;
    }
    if (err instanceof TaskAbortedSignal) {
      // abort 边界（A3 §2 v1.1）：Runtime 放弃等待，不回滚已发生的外部副作用；Trace 如实记录中止时点
      this.deps.state.transition(taskId, 'cancelled', { endedAt: nowNs(), cancelReason: 'abort', abortRequested: 0 });
      trace_event(this.deps, base, 'task_cancelled', {
        cancelReason: 'abort', mode: 'abort',
        abortedDuring: err.abortedDuring,
        abortRequestedBy: this.forceCancellers.get(taskId) ?? null,
      });
      return;
    }
    if (err instanceof TaskTimeoutSignal) {
      this.failTask(taskId, base, 'Runtime', 'TaskTimeout', err.message, { expected: `<=${err.limitMs}ms`, actual: `${err.elapsedMs}ms` });
      return;
    }
    if (isBudgetError(err)) {
      const recordId = this.deps.failures.recordBudgetExceeded({ ...base }, err.detail.budget, err.detail.consumed, err.detail.attemptBreakdown);
      this.finalizeFailed(taskId, base, 'Runtime', 'BudgetExceeded', recordId);
      return;
    }
    if (err instanceof PolicyBlockedError) {
      this.failTask(taskId, base, 'Policy', 'PolicyBlocked', err.message, { expected: `连续被拒 < maxConsecutiveDenials`, actual: String(err.consecutiveDenialCount) }, err.traceRef);
      return;
    }
    if (isTerminalModelFailure(err)) {
      const f = err as TerminalModelFailure;
      this.failTask(taskId, base, 'Model', f.subClass, f.message, { expected: '符合 outputContract', actual: f.violations.slice(0, 5) }, f.traceRef);
      return;
    }
    if (err instanceof ToolTerminalFailure) {
      this.failTask(taskId, base, 'Tool', err.subClass, err.message, { expected: '工具执行成功', actual: err.message });
      return;
    }
    this.failTask(taskId, base, 'Runtime', 'internal_error', `未分类异常：${(err as Error).message ?? String(err)}`, { expected: '不可达', actual: String(err) });
  }

  private failTask(
    taskId: string,
    base: TaskBase,
    failureClass: FailureClass,
    subClass: FailureSubClass,
    message: string,
    expectedVsActual: Record<string, unknown>,
    traceRef?: string | null,
  ): void {
    const recordId = this.deps.failures.record({
      taskId, agentId: base.agentId, agentVersionId: base.agentVersionId,
      attemptNo: 0, failureClass, subClass, message,
      expectedVsActual: expectedVsActual as { expected: unknown; actual: unknown }, traceRef: traceRef ?? null,
    });
    this.finalizeFailed(taskId, base, failureClass, subClass, recordId);
  }

  private finalizeFailed(taskId: string, base: TaskBase, failureClass: string, subClass: string, recordId: string): void {
    // 先持久化后继续：TaskRecord 终态 → Trace(task_failed)
    this.deps.state.transition(taskId, 'failed', { endedAt: nowNs(), terminalFailureClass: `${failureClass}(${subClass})` });
    trace_event(this.deps, base, 'task_failed', { failureClass, subClass, failureRecordId: recordId });
  }

  getTask(taskId: string): TaskRow {
    const row = this.deps.db.prepare('SELECT * FROM task_record WHERE taskId = ?').get(taskId) as TaskRow | undefined;
    if (!row) throw new Error(`任务不存在：${taskId}`);
    return row;
  }

  /**
   * 第六阶段批次一（§4.2 / D-48）：门户读面增量只读方法——冻结守卫：
   * 只读 SELECT（无写副作用、零 Trace/Audit 事件）、不改任何既有方法签名。
   * 分页语义：createdAt 倒序（同秒并列按 rowid 倒序），total 恒为过滤后全量计数（不随分页缩放）。
   */
  listTasks(opts: { status?: TaskStatus; agentId?: string; limit?: number; offset?: number } = {}): { tasks: TaskRow[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status !== undefined) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.agentId !== undefined) {
      where.push('agentId = ?');
      params.push(opts.agentId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.deps.db.prepare(`SELECT COUNT(*) AS c FROM task_record ${whereSql}`).get(...params) as { c: number }
    ).c;
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const tasks = this.deps.db
      .prepare(`SELECT * FROM task_record ${whereSql} ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as TaskRow[];
    return { tasks, total };
  }

  /**
   * 取消（A3 §2 两级语义）：
   * graceful——Queued 立即；Running 挂起标志等原子调用完成；Paused 立即（无在飞原子调用，P2-6）；
   * abort（--force）——本进程：立即放弃在飞原子调用；跨进程：写 abortRequested 持久化标志（执行进程下一原子调用边界生效）。
   * Paused 被取消：关联 ApprovalRequest 置 superseded + 删 PauseSnapshot。
   */
  cancel(taskId: string, who: string, opts: { force?: boolean } = {}): CancelResult {
    const { deps } = this;
    const row = this.getTask(taskId);
    const base = this.baseOf(row);
    const mode: 'graceful' | 'abort' = opts.force ? 'abort' : 'graceful';
    const cancelReason = opts.force ? 'abort' : 'user';

    if (row.status === 'queued') {
      if (!deps.state.transition(taskId, 'cancelled', { endedAt: nowNs(), cancelReason }, 'queued')) {
        throw new Error(`任务 ${taskId} 状态竞争：取消时任务已离开 Queued（当前 ${this.getTask(taskId).status}）——请按当前状态重试`);
      }
      trace_event(deps, base, 'task_cancelled', { cancelReason, mode, note: '等待中，无副作用（立即）' });
      return { taskId, mode, note: 'Queued→Cancelled 立即生效' };
    }

    if (row.status === 'paused') {
      // 挂起态无在飞原子调用 → 立即迁移（P2-6）；CAS 'paused'：与 resume 进程并发时先落库者生效
      if (!deps.state.transition(taskId, 'cancelled', { endedAt: nowNs(), cancelReason }, 'paused')) {
        throw new Error(`任务 ${taskId} 状态竞争：取消时任务已离开 Paused（当前 ${this.getTask(taskId).status}；若已被 resume 取出请用 --force）`);
      }
      deps.approvals.supersedePending(taskId, who);
      deps.approvals.deleteSnapshot(taskId);
      // §4.4 孤儿处置：委托等待挂起的父被取消 → 非终态子任务取消传播覆盖（superseded）
      this.cancelDescendants(taskId, who);
      trace_event(deps, base, 'task_cancelled', {
        cancelReason, mode, abortRequestedBy: opts.force ? who : null,
        note: '挂起态无在飞原子调用（立即迁移；pending 审批置 superseded，快照已删）',
      });
      return { taskId, mode, note: 'Paused→Cancelled 立即生效（superseded + 删快照）' };
    }

    if (row.status === 'running') {
      const ctl = this.runningCancels.get(taskId);
      if (opts.force) {
        // 持久化标志先行（跨进程可见；本进程由 abort 竞速立即生效）
        deps.db.prepare('UPDATE task_record SET abortRequested = 1 WHERE taskId = ?').run(taskId);
        this.forceCancellers.set(taskId, who);
        if (ctl) {
          ctl.abort();
          return { taskId, mode, note: '本进程中止：已放弃在飞原子调用的等待' };
        }
        return { taskId, mode, note: '已登记 abortRequested（生效依赖执行进程；跨进程中止延迟上限 = 最长原子调用时长）' };
      }
      if (ctl) {
        ctl.graceful();
        return { taskId, mode, note: '已挂起取消标志（等待当前原子调用完成后生效）' };
      }
      throw new Error(`任务 ${taskId} 由其他进程执行中（跨进程中止请使用 --force；graceful 仅本进程可见）`);
    }

    throw new Error(`任务 ${taskId} 状态为 ${row.status}，不可取消`);
  }

  private baseOf(row: Pick<TaskRow, 'taskId' | 'agentId' | 'agentVersionId' | 'specContentHash'>): TaskBase {
    return { taskId: row.taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash };
  }
}

function trace_event(deps: TaskManagerDeps, base: TaskBase, eventType: TraceEventType, payload: Record<string, unknown>): void {
  deps.trace.recordTaskEvent(base, eventType, payload);
}

function isBudgetError(err: unknown): err is BudgetExceededError {
  return err instanceof Error && err.name === 'BudgetExceededError';
}

function isTerminalModelFailure(err: unknown): err is TerminalModelFailure {
  return err instanceof Error && err.name === 'TerminalModelFailure';
}
