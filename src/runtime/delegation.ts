import type Database from 'better-sqlite3';
import { uuid, sha256Hex } from '../hash.js';
import type { TraceRecorder } from '../modules/traceRecorder.js';
import { nowNs } from '../modules/traceRecorder.js';
import type { Registry } from '../modules/registry.js';
import type { StateManager } from '../modules/stateManager.js';
import type { AuditRecorder } from '../modules/recorders.js';
import type { RedactionPolicy } from '../modules/redaction.js';
import { redactValue } from '../modules/redaction.js';
import { checkInputContract } from '../modules/specValidator.js';
import { DelegationWaitSignal, type DelegatePrimitive, type DelegateTaskContext, type PolicyDeniedResult } from '../modules/toolExecutor.js';
import type { TaskManager, TaskRow } from '../modules/taskManager.js';
import { CancelRequestedSignal } from './executor.js';

// §4.4 鲲鹏·委托最小形态（批次三，D-30/D-31/D-32）：task-delegate 委托原语 impl。
//
// ── R-1 嵌套信号封闭分类表（终审硬化项，成文于 docs/phase4/03）───────────────────────
// 子任务退出态 → 父委托调用归因的映射（封闭集：子任务终态/挂起态全枚举，杜绝单点特判）：
//
// | 子任务态                                  | 父侧处置（委托调用边界）                              |
// |------------------------------------------|-----------------------------------------------------|
// | succeeded                                 | 返回终态摘要（tool_call_executed，父模型继续）          |
// | failed（含 Created→Failed：inputContract）| 返回失败摘要（同上——失败不自动传播，父模型自行决策）     |
// | cancelled（子被单独取消/审批拒绝/超时）      | 返回取消摘要（父不受影响，从摘要感知）                   |
// | cancelled(superseded)（因父取消传播）       | 重抛 CancelRequestedSignal/中止信号——父按取消语义终局   |
// | paused（子级 L3 审批 / 崩溃窗口③合法长驻）   | DelegationWaitSignal 上浮——父在委托边界 Paused（幂等） |
// | created/queued（乱序容错/防御分支）           | DelegationWaitSignal 上浮——同上（先处置子任务）        |
// | running（子独立 resume 进程在飞）            | 窗口②现场：子进程崩溃由恢复扫描终局（父保持 Paused），  |
// |                                            | resume 父幂等重入见子终局 → 返回失败摘要（可达：父 Paused |
// |                                            | 期间操作者 resume 子 = 独立进程跑子循环至终态，§4.4）    |
//
// ── R-2 双快照写序（终审硬化项，成文于 docs/phase4/03）─────────────────────────────
// 子级审批信号上浮为父级挂起时，两侧 PauseSnapshot 的落库步骤与先后写序（先持久化后迁移，A3 不变式②）：
//   第 1 步（子侧）  子 PauseSnapshot 落库 → 子 ApprovalRequest(pending) 落库 → 子 Running→Paused → Trace(task_paused)；
//   第 2 步（父侧）  父 PauseSnapshot 落库（载荷含 delegation.childTaskId 锚）→ 父 Running→Paused → Trace(task_paused)。
//   写序 = 先子后父（子任务必须已持久化处于 Paused 合法长驻，父快照的 childTaskId 锚才可信）；
//   父侧不创建新 ApprovalRequest——第二次人工介入挂子 taskId（子的 ApprovalRequest），委托本身已由第一次父级审批放行。
//
// ── 二次委托风暴封闭句（终审硬化项，成文于 docs/phase4/03）─────────────────────────
// 「父委托子、子再委托孙」的二次委托在本期被运行期调用点封闭拒绝：深度上限默认 1（DELEGATION_DEPTH_LIMIT），
// 任何 depth≥1 的任务再请求 task-delegate 即遭 policy_denied(risk_level_blocked, reason=delegation_depth)，
// 孙任务零创建；若未来放宽深度上限，环路（A→B→A 同 agent 重复）仍由 parentTaskId 上溯校验封闭（delegation_cycle）。

/** 深度上限默认 1（§4.4 治理规则表：仅一层委托，Supervisor 单层串行，D-32） */
export const DELEGATION_DEPTH_LIMIT = 1;

export interface DelegationDeps {
  db: Database.Database;
  registry: Registry;
  trace: TraceRecorder;
  state: StateManager;
  audit: AuditRecorder;
  redaction: RedactionPolicy;
  /** v1.1（A5 §4a）：灰度分派随机源（canary 分派同款，assignmentSource 留痕） */
  dispatchRoll?: () => number;
  tasks: TaskManager;
}

/** 治理预检（纯查询，供 Delegation 与测试直用）：环路（先查）→ 深度（后查） */
export function governDelegationStatic(
  db: Database.Database,
  args: Record<string, unknown>,
  task: { parentTaskId: string; delegationDepth: number },
): PolicyDeniedResult | null {
  const agentId = String(args.agentId ?? '');
  // 环路禁止：沿 parentTaskId 上溯，委托树内禁止重复 agentId 形成环（A→B→A）
  const chain: string[] = [];
  let cursor: string | null = task.parentTaskId;
  while (cursor !== null) {
    const row = db.prepare('SELECT taskId, agentId, parentTaskId FROM task_record WHERE taskId = ?').get(cursor) as
      | { taskId: string; agentId: string; parentTaskId: string | null }
      | undefined;
    if (!row) break;
    chain.push(row.agentId);
    cursor = row.parentTaskId;
  }
  if (chain.includes(agentId)) {
    return {
      result: 'policy_denied', toolId: 'task-delegate', reasonCode: 'risk_level_blocked',
      message: `委托被拒（reason=delegation_cycle）：agentId ${agentId} 已在委托树内（链 ${chain.join(' ← ')}——环路禁止，A→B→A 类委托封闭）`,
    };
  }
  // 深度上限：默认 1（子任务 Spec 可声明 task-delegate——注册放行，运行期调用点拦截）
  if (task.delegationDepth + 1 > DELEGATION_DEPTH_LIMIT) {
    return {
      result: 'policy_denied', toolId: 'task-delegate', reasonCode: 'risk_level_blocked',
      message: `委托被拒（reason=delegation_depth）：发起任务 delegationDepth=${task.delegationDepth}，再委托将达 ${task.delegationDepth + 1} > 上限 ${DELEGATION_DEPTH_LIMIT}（二次委托风暴封闭，§4.4）`,
    };
  }
  return null;
}

/** 委托原语 impl（§4.4 执行模型：阻塞式嵌套 + 幂等重入） */
export class Delegation implements DelegatePrimitive {
  constructor(private readonly deps: DelegationDeps) {}

  govern(args: Record<string, unknown>, task: DelegateTaskContext): PolicyDeniedResult | null {
    return governDelegationStatic(this.deps.db, args, task);
  }

  async execute(args: Record<string, unknown>, task: DelegateTaskContext, call: { callNo: number; anchorChildTaskId?: string }): Promise<unknown> {
    const agentId = String(args.agentId ?? '');
    const input = args.input ?? null;

    // ── 幂等重入（类别属性③，P0-1）：以快照锚 childTaskId 判定——不重建、续接子状态 ──
    if (call.anchorChildTaskId) {
      const anchored = this.getTaskRow(call.anchorChildTaskId);
      if (anchored !== null && isTerminal(anchored.status)) {
        return this.summarize(task, anchored); // 子已终态（含崩溃窗口②被扫描终局）→ 直接返回终态摘要
      }
      throw new DelegationWaitSignal(
        call.anchorChildTaskId,
        `子任务 ${call.anchorChildTaskId} 未终态（${anchored?.status ?? '缺失'}）——先处置子任务（resume 时序规范：先子后父；父幂等保持 Paused）`,
      );
    }

    // ── ① 子任务创建（先持久化；F-12-①：agentId 无 Released 指针 → 结构化拒绝，零子任务） ──
    const resolved = this.resolveAgent(agentId);
    if (!resolved.ok) {
      throw new Error(resolved.message); // 工具失败归因（Tool(execution_failed)），委托原语 attempt=1 不重试
    }
    const { version, assignmentSource } = resolved;
    const spec = JSON.parse(version.specSnapshot) as { inputContract: Record<string, unknown> } & Record<string, unknown>;
    const childTaskId = uuid();
    const childBase = { taskId: childTaskId, agentId, agentVersionId: version.versionId, specContentHash: version.contentHash };
    const { deps } = this;
    deps.db
      .prepare(
        `INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, createdAt, traceFile, assignmentSource, parentTaskId, delegationDepth)
         VALUES (?,?,?,?,?,'created',?,?,?,?,?)`,
      )
      .run(
        childTaskId, agentId, version.versionId, version.contentHash,
        JSON.stringify(redactValue(input, deps.redaction)), nowNs(), deps.trace.traceFile(childTaskId), assignmentSource,
        task.parentTaskId, task.delegationDepth + 1,
      );
    deps.trace.recordTaskEvent(childBase, 'task_created', {
      inputHash: sha256Hex(JSON.stringify(input ?? null)),
      input: input ?? null,
      inputContractHash: sha256Hex(JSON.stringify(spec.inputContract)),
      assignmentSource,
      delegatedFrom: task.parentTaskId, // 委托来源留痕（跨 Agent 审计 = 单查询沿 parentTaskId 树回放）
    });
    // 父 Trace 交接事件：task_delegated（子创建时）
    const parentBase = this.baseOf(task.parentTaskId);
    deps.trace.recordTaskEvent(parentBase, 'task_delegated', {
      childTaskId, agentId, agentVersionId: version.versionId, inputDigest: sha256Hex(JSON.stringify(input ?? null)).slice(0, 16),
      delegationDepth: task.delegationDepth + 1, note: typeof args.note === 'string' ? args.note : null,
    });

    // 子 inputContract 校验（落库后审计边界，F-12-②：不合 → 子 Created→Failed，父收失败摘要）
    const violations = checkInputContract(input, spec.inputContract);
    if (violations.length > 0) {
      deps.trace.recordTaskEvent(childBase, 'contract_checked', { which: 'input', verdict: false, violations });
      this.failChild(childBase, 'Input', 'contract_mismatch', '委托输入不符子任务 Input Contract（落库后审计边界，F-12-②）', violations);
      const failedRow = this.getTaskRow(childTaskId)!;
      return this.summarize(task, failedRow);
    }
    deps.trace.recordTaskEvent(childBase, 'contract_checked', { which: 'input', verdict: true, violations: [] });
    const queueDepth = (deps.db.prepare(`SELECT COUNT(*) AS c FROM task_record WHERE status='queued'`).get() as { c: number }).c;
    deps.state.transition(childTaskId, 'queued');
    deps.trace.recordTaskEvent(childBase, 'task_queued', { queueDepth });

    // ── ② 同进程阻塞式嵌套执行子任务循环（runAgentLoop 递归经 TaskManager） ──
    const childFinal = await deps.tasks.runDelegatedChild(childTaskId, {
      // P2-2 取消线程化：父取消检查函数注入子循环，子循环在原子调用边界代查 graceful/abort
      requested: () => task.isParentCancelRequested(),
    });

    // ── R-1 封闭分类表（见文件头）：子退出态 → 父委托调用归因 ──
    if (childFinal.status === 'cancelled' && task.isParentCancelRequested()) {
      // 子因父取消传播 superseded → 重抛取消信号：父随后按 cancel 语义终局（graceful→user / abort→abort）
      throw new CancelRequestedSignal();
    }
    if (!isTerminal(childFinal.status)) {
      // 子 Paused（子级 L3 审批信号上浮，R-2 写序已保证子先持久化）/ created/queued → 父保持 Paused
      throw new DelegationWaitSignal(childTaskId, `子任务 ${childTaskId} 未终态（${childFinal.status}）——先处置子任务（resume 时序规范：先子后父；父幂等保持 Paused）`);
    }
    return this.summarize(task, childFinal);
  }

  /** ③ 子终态摘要返回父模型：{taskId,status,outputDigest,output}（output 已过子 outputContract 校验 + 脱敏管道） */
  private summarize(task: DelegateTaskContext, child: TaskRow): Record<string, unknown> {
    let output: unknown = null;
    if (child.status === 'succeeded') {
      // 子终态输出存于子 Trace task_succeeded 载荷（已过脱敏管道）——沿子 trace 文件读取
      const events = this.deps.trace.readEvents(child.taskId);
      const succeeded = events.find((e) => e.eventType === 'task_succeeded') as unknown as { output?: unknown } | undefined;
      output = succeeded?.output ?? null;
    }
    const outputDigest = output === null ? null : sha256Hex(JSON.stringify(output)).slice(0, 16);
    const parentBase = this.baseOf(task.parentTaskId);
    this.deps.trace.recordTaskEvent(parentBase, 'task_delegation_completed', {
      childTaskId: child.taskId, status: child.status, outputDigest,
    });
    return {
      taskId: child.taskId,
      status: child.status,
      outputDigest,
      output,
      failure: child.terminalFailureClass ?? child.cancelReason ?? null,
    };
  }

  /** agentId 指针解析（canary 分派同款，A5 §4a）：无 Released 指针 → 结构化拒绝（F-12-①） */
  private resolveAgent(agentId: string): { ok: true; version: { versionId: string; contentHash: string; specSnapshot: string; status: string }; assignmentSource: 'stable' | 'canary' } | { ok: false; message: string } {
    const { registry } = this.deps;
    const stablePointer = registry.getPointer(agentId);
    const canary = registry.getCanary(agentId);
    const canaryActive = canary.canaryVersionId !== null && canary.canaryWeight > 0;
    const roll = this.deps.dispatchRoll ?? (() => Math.floor(Math.random() * 100));
    let pointer = stablePointer;
    let assignmentSource: 'stable' | 'canary' = 'stable';
    if (canaryActive && stablePointer !== null && roll() < canary.canaryWeight) {
      pointer = canary.canaryVersionId;
      assignmentSource = 'canary';
    }
    const version = pointer ? registry.getVersion(pointer) : null;
    if (!version || version.status !== 'released') {
      return { ok: false, message: `委托被拒：agentId ${agentId} 无 Released 指针（不可解析=${!version ? '是' : '否'}${version ? `，状态=${version.status}` : ''}；F-12-①，零子任务创建）` };
    }
    return { ok: true, version: version as unknown as { versionId: string; contentHash: string; specSnapshot: string; status: string }, assignmentSource };
  }

  private failChild(childBase: { taskId: string; agentId: string; agentVersionId: string; specContentHash: string }, failureClass: string, subClass: string, message: string, violations: unknown[]): void {
    const { deps } = this;
    // 子终局：先持久化后继续（TaskRecord 终态 → Trace(task_failed)——落库后审计边界，A3 一行规则）
    deps.state.transition(childBase.taskId, 'failed', { endedAt: nowNs(), terminalFailureClass: `${failureClass}(${subClass})` });
    deps.trace.recordTaskEvent(childBase, 'task_failed', {
      failureClass, subClass, message, violations: violations.slice(0, 5), failureRecordId: null,
    });
  }

  private getTaskRow(taskId: string): TaskRow | null {
    return (this.deps.db.prepare('SELECT * FROM task_record WHERE taskId = ?').get(taskId) as TaskRow | undefined) ?? null;
  }

  private baseOf(taskId: string): { taskId: string; agentId: string; agentVersionId: string; specContentHash: string } {
    const row = this.getTaskRow(taskId);
    if (!row) throw new Error(`委托父任务不存在：${taskId}`);
    return { taskId: row.taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash };
  }
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
