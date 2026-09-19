import type Database from 'better-sqlite3';
import { sha256Hex, uuid } from '../hash.js';
import { nowNs, type TraceRecorder } from './traceRecorder.js';
import type { StateManager } from './stateManager.js';
import type { FailureRecorder } from './recorders.js';

// A3 §5 / §5a v1.1（D-8/D-9/D-18 + 终审 R-1）：审批命令族语义。
// approve 只写 decision=approved（任务保持 Paused）——Paused→Running 迁移权归 --resume 进程；
// deny / 超时-deny = 任务级终局 Cancelled；超时判定惰性执行（无后台定时器进程）。

export interface ApprovalRow {
  requestId: string;
  taskId: string;
  agentVersionId: string;
  toolId: string;
  riskLevel: string;
  requestedAt: string;
  decision: 'pending' | 'approved' | 'denied' | 'superseded';
  decidedAt: string | null;
  timeoutAt: string;
  callRef: string;
}

/** 结构化拒绝（CLI 侧可区分展示，A3 §5 规则 2/3） */
export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'already_decided'
      | 'task_not_paused'
      | 'version_mismatch'
      | 'timeout_expired'
      | 'timeout_applied',
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface ApprovalDeps {
  db: Database.Database;
  trace: TraceRecorder;
  failures: FailureRecorder;
  state: StateManager;
}

interface TaskBaseRow {
  taskId: string;
  agentId: string;
  agentVersionId: string;
  specContentHash: string;
}

export class ApprovalManager {
  constructor(private readonly deps: ApprovalDeps) {}

  /** 挂起序列内调用：写 ApprovalRequest（decision=pending）。PauseSnapshot 已先行落库（D-18 次序）。 */
  createRequest(base: TaskBaseRow, toolId: string, callRef: string, timeoutMs: number): ApprovalRow {
    const requestedAt = nowNs();
    const timeoutAt = new Date(Date.parse(requestedAt) + timeoutMs).toISOString();
    const requestId = uuid();
    this.deps.db
      .prepare(
        `INSERT INTO approval_request (requestId, taskId, agentVersionId, toolId, riskLevel, requestedAt, decision, timeoutAt, callRef)
         VALUES (?,?,?,?,'L3',?,'pending',?,?)`,
      )
      .run(requestId, base.taskId, base.agentVersionId, toolId, requestedAt, timeoutAt, callRef);
    return this.getRequest(requestId)!;
  }

  getRequest(requestId: string): ApprovalRow | null {
    return (this.deps.db.prepare('SELECT * FROM approval_request WHERE requestId = ?').get(requestId) as ApprovalRow | undefined) ?? null;
  }

  pendingForTask(taskId: string): ApprovalRow | null {
    return (this.deps.db
      .prepare(`SELECT * FROM approval_request WHERE taskId = ? AND decision = 'pending' ORDER BY requestedAt DESC LIMIT 1`)
      .get(taskId) as ApprovalRow | undefined) ?? null;
  }

  /** P1-1 修复：当前挂起点（callRef = snapshot.nextCallRef）对应的请求——resume 放行的唯一合法锚点。
   * （P3 处置：approvedForTask「按 taskId 查任意历史 approved」已删——P1-1 后无合法消费方，保留即死代码；
   * 历史裁决统计由 report 直查 approval_request 表。） */
  requestForCallRef(taskId: string, callRef: string): ApprovalRow | null {
    return (this.deps.db
      .prepare(`SELECT * FROM approval_request WHERE taskId = ? AND callRef = ? ORDER BY requestedAt DESC LIMIT 1`)
      .get(taskId, callRef) as ApprovalRow | undefined) ?? null;
  }

  /** 审批队列（含绑定 agentVersionId 与 contentHash、超时剩余；顺带执行惰性超时判定） */
  list(opts: { pendingOnly?: boolean } = {}): Record<string, unknown>[] {
    this.applyLazyTimeouts();
    const rows = (
      this.deps.db
        .prepare(
          `SELECT a.requestId, a.taskId, a.toolId, a.decision, a.requestedAt, a.timeoutAt, a.callRef,
                  a.agentVersionId, v.contentHash, t.status AS taskStatus
           FROM approval_request a
           JOIN agent_version v ON v.versionId = a.agentVersionId
           JOIN task_record t ON t.taskId = a.taskId
           ${opts.pendingOnly ? 'WHERE a.decision = ' + "'pending'" : ''}
           ORDER BY a.requestedAt DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({ ...r, timeoutRemainingMs: Math.max(0, Date.parse(String(r.timeoutAt)) - Date.now()) }));
    return rows;
  }

  /** 详情：参数 digest + 绑定 Spec 快照摘要 */
  show(requestId: string): Record<string, unknown> {
    const row = this.getRequest(requestId);
    if (!row) throw new ApprovalError(`审批请求不存在：${requestId}`, 'not_found');
    const version = this.deps.db
      .prepare('SELECT contentHash, specSnapshot FROM agent_version WHERE versionId = ?')
      .get(row.agentVersionId) as { contentHash: string; specSnapshot: string } | undefined;
    const snapshot = this.deps.db.prepare('SELECT contextJson, savedAt FROM pause_snapshot WHERE taskId = ?').get(row.taskId) as { contextJson: string; savedAt: string } | undefined;
    let argsDigest: string | null = null;
    if (snapshot) {
      try {
        // 快照 contextJson 为执行循环的 PauseContext（含 pendingIndex）：digest 对挂起调用参数计算
        const ctx = JSON.parse(snapshot.contextJson) as { assistantToolCalls?: { args?: unknown }[]; pendingIndex?: number };
        const pending = ctx.assistantToolCalls?.[ctx.pendingIndex ?? -1];
        argsDigest = pending ? sha256Hex(JSON.stringify(pending.args ?? null)).slice(0, 16) : null;
      } catch {
        argsDigest = null;
      }
    }
    return {
      request: row,
      binding: version ? { agentVersionId: row.agentVersionId, contentHash: version.contentHash, snapshotBytes: version.specSnapshot.length } : null,
      snapshot: snapshot ? { savedAt: snapshot.savedAt, contextBytes: snapshot.contextJson.length } : null,
      argsDigest,
    };
  }

  /**
   * approve（A3 §5 规则 3 / 终审 R-1）：只写 decision=approved + Trace(approval_decided)——任务保持 Paused；
   * 迁移与续跑归 resume 进程（approve-spawn 或 manual-resume）。
   */
  approve(requestId: string, who: string): { taskId: string } {
    this.applyLazyTimeouts();
    const row = this.requirePending(requestId);
    const task = this.taskOf(row.taskId);
    if (task.status !== 'paused') {
      throw new ApprovalError(`任务 ${row.taskId} 状态为 ${task.status}（approve 仅适用于 Paused）`, 'task_not_paused', { status: task.status });
    }
    if (row.agentVersionId !== task.agentVersionId) {
      throw new ApprovalError('request.agentVersionId 与 TaskRecord 不一致（防跨任务误用）', 'version_mismatch');
    }
    if (Date.now() > Date.parse(row.timeoutAt)) {
      this.applyLazyTimeouts();
      throw new ApprovalError('审批请求已超时（惰性判定已执行）', 'timeout_applied');
    }
    // 先落库者生效（库层强制）：UPDATE 带 pending 守卫，changes=0 即已被并发裁决/惰性判定
    const claimed = this.deps.db
      .prepare(`UPDATE approval_request SET decision='approved', decidedAt=? WHERE requestId=? AND decision='pending'`)
      .run(nowNs(), requestId);
    if (claimed.changes === 0) {
      throw new ApprovalError(`请求已裁决（decision=${this.getRequest(requestId)?.decision ?? '?'}），先落库者生效`, 'already_decided');
    }
    const base = this.baseOf(task);
    this.deps.trace.recordTaskEvent(base, 'approval_decided', {
      requestId, decision: 'approved', decidedBy: who,
      elapsedMs: Date.now() - Date.parse(row.requestedAt), superseded: false,
    });
    return { taskId: row.taskId };
  }

  /** deny（T-A4）：任务级终局——decision=denied + Paused→Cancelled(approval_denied) + 删 snapshot */
  deny(requestId: string, who: string, reason?: string): { taskId: string } {
    this.applyLazyTimeouts();
    const row = this.requirePending(requestId);
    const task = this.taskOf(row.taskId);
    if (task.status !== 'paused') {
      throw new ApprovalError(`任务 ${row.taskId} 状态为 ${task.status}（deny 仅适用于 Paused）`, 'task_not_paused', { status: task.status });
    }
    // P2-1 修复：与 approve 同源的先落库者生效守卫——UPDATE 带 pending 条件且检查 changes，
    // 并发（惰性超时/approve）先落库则 deny 整体终止（不写 Trace、不迁移，避免表内裁决与审计漂移）
    const claimed = this.deps.db
      .prepare(`UPDATE approval_request SET decision='denied', decidedAt=? WHERE requestId=? AND decision='pending'`)
      .run(nowNs(), requestId);
    if (claimed.changes === 0) {
      throw new ApprovalError(`请求已裁决（decision=${this.getRequest(requestId)?.decision ?? '?'}），先落库者生效`, 'already_decided');
    }
    const base = this.baseOf(task);
    this.deps.trace.recordTaskEvent(base, 'approval_decided', {
      requestId, decision: 'denied', decidedBy: who, reason: reason ?? null,
      elapsedMs: Date.now() - Date.parse(row.requestedAt), superseded: false,
    });
    this.deleteSnapshot(row.taskId);
    if (!this.deps.state.transition(row.taskId, 'cancelled', { endedAt: nowNs(), cancelReason: 'approval_denied' }, 'paused')) {
      const current = this.deps.db.prepare('SELECT status FROM task_record WHERE taskId=?').get(row.taskId) as { status: string } | undefined;
      throw new ApprovalError(`任务 ${row.taskId} 状态竞争：deny 时任务已离开 Paused（当前 ${current?.status ?? '?'}）`, 'task_not_paused');
    }
    this.deps.trace.recordTaskEvent(base, 'task_cancelled', {
      cancelReason: 'approval_denied', mode: 'graceful', requestId,
      note: '审批拒绝（任务级终局，模型不再获得执行机会——D-9）',
    });
    return { taskId: row.taskId };
  }

  /** 挂起任务被取消/中止：pending 请求置 superseded（不产生 approved/denied 假裁决，A3 §2） */
  supersedePending(taskId: string, who: string): void {
    const rows = this.deps.db
      .prepare(`SELECT * FROM approval_request WHERE taskId = ? AND decision = 'pending'`)
      .all(taskId) as ApprovalRow[];
    for (const row of rows) {
      this.deps.db.prepare(`UPDATE approval_request SET decision='superseded', decidedAt=? WHERE requestId=?`).run(nowNs(), row.requestId);
      const task = this.taskOf(taskId);
      this.deps.trace.recordTaskEvent(this.baseOf(task), 'approval_decided', {
        requestId: row.requestId, decision: 'superseded', decidedBy: who,
        elapsedMs: Date.now() - Date.parse(row.requestedAt), superseded: true,
      });
    }
  }

  /**
   * 惰性超时判定（A3 §6 v1.1：任意进程触碰时执行，无后台定时器）：
   * 扫 Paused 且 pending 超时 → 按 Spec.onTimeout：deny（默认）→ Cancelled(approval_timeout)；fail → Failed:Policy(ApprovalTimeout)。
   * 单事务 + pending 守卫 + Paused CAS：与 approve/deny/resume 并发时先落库者生效（不覆写他人裁决、不重复终局）。
   */
  applyLazyTimeouts(): string[] {
    const touched: string[] = [];
    const sweep = this.deps.db.transaction((): void => {
      const expired = this.deps.db
        .prepare(
          `SELECT a.* FROM approval_request a JOIN task_record t ON t.taskId = a.taskId
           WHERE a.decision = 'pending' AND t.status = 'paused' AND a.timeoutAt < ?`,
        )
        .all(nowNs()) as ApprovalRow[];
      for (const row of expired) {
        const task = this.taskOf(row.taskId);
        const base = this.baseOf(task);
        const spec = JSON.parse(
          (this.deps.db.prepare('SELECT specSnapshot FROM agent_version WHERE versionId = ?').get(task.agentVersionId) as { specSnapshot: string }).specSnapshot,
        ) as { approvalPolicy?: { onTimeout?: 'deny' | 'fail' } };
        const onTimeout = spec.approvalPolicy?.onTimeout ?? 'deny';
        // 先落库者生效：pending 守卫认领该行；已被并发裁决（approve/deny）则整行跳过
        const claimed = this.deps.db
          .prepare(`UPDATE approval_request SET decision='denied', decidedAt=? WHERE requestId=? AND decision='pending'`)
          .run(nowNs(), row.requestId);
        if (claimed.changes === 0) continue;
        // 任务级终局 CAS 'paused'：已被 resume/cancel 取走则不再终局
        const claimTask = this.deps.state.transition(task.taskId, onTimeout === 'fail' ? 'failed' : 'cancelled', {}, 'paused');
        if (!claimTask) continue;
        this.deps.trace.recordTaskEvent(base, 'approval_decided', {
          requestId: row.requestId, decision: 'denied', decidedBy: 'lazy-timeout', timeout: true,
          elapsedMs: Date.now() - Date.parse(row.requestedAt), superseded: false,
        });
        this.deleteSnapshot(row.taskId);
        if (onTimeout === 'fail') {
          const recordId = this.deps.failures.record({
            taskId: task.taskId, agentId: task.agentId, agentVersionId: task.agentVersionId,
            attemptNo: 0, failureClass: 'Policy', subClass: 'ApprovalTimeout',
            message: `审批超时且 onTimeout=fail（requestId=${row.requestId}，timeoutAt=${row.timeoutAt}）`,
            expectedVsActual: { expected: `now <= ${row.timeoutAt}`, actual: nowNs() },
          });
          this.deps.state.transition(task.taskId, 'failed', { endedAt: nowNs(), terminalFailureClass: 'Policy(ApprovalTimeout)' });
          this.deps.trace.recordTaskEvent(base, 'task_failed', { failureClass: 'Policy', subClass: 'ApprovalTimeout', failureRecordId: recordId });
        } else {
          this.deps.state.transition(task.taskId, 'cancelled', { endedAt: nowNs(), cancelReason: 'approval_timeout' });
          this.deps.trace.recordTaskEvent(base, 'task_cancelled', { cancelReason: 'approval_timeout', mode: 'graceful', requestId: row.requestId, note: '审批超时（onTimeout=deny 默认）' });
        }
        touched.push(task.taskId);
      }
    });
    sweep();
    return touched;
  }

  deleteSnapshot(taskId: string): void {
    this.deps.db.prepare('DELETE FROM pause_snapshot WHERE taskId = ?').run(taskId);
  }

  getSnapshot(taskId: string): { taskId: string; contextJson: string; callCounters: string; nextCallRef: string; savedAt: string } | null {
    return (this.deps.db.prepare('SELECT * FROM pause_snapshot WHERE taskId = ?').get(taskId) as
      | { taskId: string; contextJson: string; callCounters: string; nextCallRef: string; savedAt: string }
      | undefined) ?? null;
  }

  /** 快照落库（挂起序列第一步：先持久化后迁移，A3 不变式②） */
  saveSnapshot(taskId: string, contextJson: string, callCounters: string, nextCallRef: string): void {
    this.deps.db
      .prepare(
        `INSERT INTO pause_snapshot (taskId, contextJson, callCounters, nextCallRef, savedAt) VALUES (?,?,?,?,?)
         ON CONFLICT(taskId) DO UPDATE SET contextJson=excluded.contextJson, callCounters=excluded.callCounters, nextCallRef=excluded.nextCallRef, savedAt=excluded.savedAt`,
      )
      .run(taskId, contextJson, callCounters, nextCallRef, nowNs());
  }

  private requirePending(requestId: string): ApprovalRow {
    const row = this.getRequest(requestId);
    if (!row) throw new ApprovalError(`审批请求不存在：${requestId}`, 'not_found');
    if (row.decision !== 'pending') {
      throw new ApprovalError(`请求已裁决（decision=${row.decision}${row.decidedAt ? ` @${row.decidedAt}` : ''}），先落库者生效`, 'already_decided', { decision: row.decision });
    }
    return row;
  }

  private taskOf(taskId: string): TaskBaseRow & { status: string } {
    const task = this.deps.db
      .prepare('SELECT taskId, agentId, agentVersionId, specContentHash, status FROM task_record WHERE taskId = ?')
      .get(taskId) as (TaskBaseRow & { status: string }) | undefined;
    if (!task) throw new ApprovalError(`任务不存在：${taskId}`, 'not_found');
    return task;
  }

  private baseOf(task: TaskBaseRow): TaskBaseRow {
    return { taskId: task.taskId, agentId: task.agentId, agentVersionId: task.agentVersionId, specContentHash: task.specContentHash };
  }
}
