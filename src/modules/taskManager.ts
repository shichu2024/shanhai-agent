import type Database from 'better-sqlite3';
import { uuid, sha256Hex } from '../hash.js';
import { nowNs, type TraceRecorder } from './traceRecorder.js';
import { FailureRecorder, AuditRecorder } from './recorders.js';
import type { Registry } from './registry.js';
import type { StateManager } from './stateManager.js';
import type { ModelGateway, BudgetLedger, BudgetExceededError, TerminalModelFailure } from './modelGateway.js';
import { PolicyBlockedError, ToolTerminalFailure, type SpecToolDeclaration } from './toolExecutor.js';
import { checkInputContract, validateDefensive } from './specValidator.js';
import { contentHash } from '../hash.js';
import { runAgentLoop, ExecutorSucceeded, CancelRequestedSignal, TaskTimeoutSignal, promptHashOf, type ExecSpec } from '../runtime/executor.js';
import type { FailureClass, FailureSubClass, TaskStatus, TraceEventType } from '../types.js';

// A3 状态机驱动 + 审计边界一行规则：
// TaskRecord 落库前的校验失败 → RejectedRequest 审计（不创建 Task）；
// 落库后的任何校验失败（含防御性重复校验）→ Created→Failed。

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
  audit: AuditRecorder;
}

export class TaskManager {
  private readonly runningCancels = new Map<string, () => void>();

  constructor(private readonly deps: TaskManagerDeps) {}

  /** 任务创建（A3 §3.1 双路径分工：落库前查请求合法性，落库后防世界漂移） */
  createTask(agentId: string, input: unknown, who: string, opts: { allowDraft?: boolean } = {}): string {
    const deps = this.deps;
    const { db, registry, trace } = deps;

    // ② 落库前：Spec 存在性与状态（指针指向 Released 版本；agentVersionId 不可解析时为 NULL——A6 §4）
    const pointer = registry.getPointer(agentId);
    const version = pointer ? registry.getVersion(pointer) : null;
    const resolvable = version !== null && version.status === 'released';
    const draftable = opts.allowDraft === true && version !== null && version.status === 'draft';
    if (!resolvable && !draftable) {
      const reason = !version
        ? `agentId 不可解析或指针悬空：${agentId}`
        : `指针目标版本状态为 ${version.status}（任务仅可绑定 Released${opts.allowDraft ? ' 或 --draft Draft' : ''}）`;
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

    // TaskRecord 落库（审计边界锚点）
    const taskId = uuid();
    const base = { taskId, agentId, agentVersionId: version.versionId, specContentHash: version.contentHash };
    db.prepare(
      `INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, createdAt, traceFile)
       VALUES (?,?,?,?,?,'created',?,?)`,
    ).run(taskId, agentId, version.versionId, version.contentHash, JSON.stringify(input ?? null), nowNs(), trace.traceFile(taskId));
    trace.recordTaskEvent(base, 'task_created', {
      inputHash: sha256Hex(JSON.stringify(input ?? null)),
      input: input ?? null,
      inputContractHash: sha256Hex(JSON.stringify(spec.inputContract)),
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
  async runTask(taskId: string, strategy: 'native' | 'prompt' | null = null): Promise<TaskRow> {
    const { deps } = this;
    const row = this.getTask(taskId);
    if (row.status !== 'queued') {
      throw new Error(`任务 ${taskId} 状态为 ${row.status}，仅 Queued 可执行`);
    }
    const spec = JSON.parse(this.deps.registry.getVersion(row.agentVersionId)!.specSnapshot) as ExecSpec;
    const base = { taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash };

    // Queued → Running
    deps.state.transition(taskId, 'running', { startedAt: nowNs() });
    const bindingSnapshot = {
      toolVersions: spec.toolPolicy.tools.map((t) => {
        const reg = deps.registry.getTool(t.toolId);
        return { toolId: t.toolId, implVersion: reg?.implVersion ?? 'unresolved' };
      }),
      modelId: spec.modelPolicy.allowedModels[0],
      promptHash: promptHashOf(row.specContentHash), // P2-8：specContentHash 派生 convenience 字段
    };
    trace_event(deps, base, 'task_started', { bindingSnapshot });

    const ledger = new TaskLedger(deps.db, taskId, spec.modelPolicy.maxModelCalls, spec.modelPolicy.maxTokens);
    let cancelRequested = false;
    this.runningCancels.set(taskId, () => {
      cancelRequested = true;
    });

    try {
      const result = await runAgentLoop({
        base, trace: deps.trace, gateway: deps.gateway, spec,
        input: JSON.parse(row.input),
        getTool: (toolId) => deps.registry.getTool(toolId),
        toolImpls: deps.toolImpls,
        ledger, strategy,
        isCancelRequested: () => cancelRequested,
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
      return this.getTask(taskId);
    } catch (err) {
      this.mapTerminalFailure(taskId, base, spec, ledger, err);
      return this.getTask(taskId);
    } finally {
      this.runningCancels.delete(taskId);
    }
  }

  private mapTerminalFailure(taskId: string, base: TaskBase, _spec: ExecSpec, ledger: TaskLedger, err: unknown): void {
    if (err instanceof ExecutorSucceeded) throw err; // 不可达防御
    if (err instanceof CancelRequestedSignal) {
      this.deps.state.transition(taskId, 'cancelled', { endedAt: nowNs() });
      trace_event(this.deps, base, 'task_cancelled', { cancelReason: '用户取消（等待当前原子调用完成后生效）', graceful: true });
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

  /** 取消：Queued → Cancelled（无副作用）；Running → 挂起取消标志，等待当前原子调用完成（A3 §2/§7） */
  cancel(taskId: string, who: string): void {
    const row = this.getTask(taskId);
    if (row.status === 'queued') {
      this.deps.state.transition(taskId, 'cancelled', { endedAt: nowNs() });
      trace_event(this.deps, { taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash }, 'task_cancelled', { cancelReason: `用户取消（等待中，无副作用）by ${who}`, graceful: true });
      return;
    }
    if (row.status === 'running') {
      this.runningCancels.get(taskId)?.();
      return;
    }
    throw new Error(`任务 ${taskId} 状态为 ${row.status}，不可取消`);
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
