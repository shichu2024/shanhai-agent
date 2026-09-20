import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { TraceRecorder, nowNs } from './traceRecorder.js';
import { FailureRecorder } from './recorders.js';

// A3 §6 崩溃恢复 + A6 §6.1 双写一致性与索引恢复程序。
// 次序约束（冻结）：索引对账先于崩溃标记——对账只读 TaskRecord/文件；先对账保证 CrashRecovery 的 Trace 追加在完整索引之上。

export interface RecoveryReport {
  reconciledTasks: string[]; // 触发了索引重建的 taskId
  crashMarkedTasks: string[]; // 迁移为 Failed:Runtime(CrashRecovery) 的 taskId
  staleQueuedTasks: string[]; // v1.1 只读警示：Queued 超宽限窗未被任何进程执行（不改状态，A3 §6）
  stalePausedTasks: string[]; // v1.1 只读警示：Paused 且审批已超时未被惰性判定（提示跑 approval list，A3 §6）
}

/** stale Queued 宽限窗（天级量级配置项，A3 §6；默认 7 天，WP-B 定） */
const STALE_QUEUED_GRACE_MS = 7 * 24 * 3600 * 1000;

export class StateManager {
  constructor(
    private readonly db: Database.Database,
    private readonly trace: TraceRecorder,
    private readonly failures: FailureRecorder,
  ) {}

  /** 进程重启钩子：① 逐 task 索引对账（O(1) 水位比对）→ ② Running 遗留 → Failed:Runtime(CrashRecovery)。幂等。
   * A3 §6（F-1 修订）：崩溃标记扫描范围仅 Running（有执行副作用的中间态）；Queued/Paused 不迁移。
   * v1.1（终审 R-4）：CrashRecovery 终局顺带删该 taskId 的 PauseSnapshot（孤儿快照兜底——任务从未进入 Paused）。 */
  recover(): RecoveryReport {
    const report: RecoveryReport = { reconciledTasks: [], crashMarkedTasks: [], staleQueuedTasks: [], stalePausedTasks: [] };

    // ① 对账：以 JSONL 文件为唯一真源，水位 = (行数, 末位 eventId)
    const tasks = this.db
      .prepare(`SELECT taskId, agentId, agentVersionId, specContentHash, traceFile FROM task_record`)
      .all() as { taskId: string; agentId: string; agentVersionId: string; specContentHash: string; traceFile: string }[];

    for (const t of tasks) {
      const file = this.trace.traceFile(t.taskId);
      let fileCount = 0;
      let lastFileEventId: string | null = null;
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
        fileCount = lines.length;
        if (fileCount > 0) lastFileEventId = (JSON.parse(lines[fileCount - 1]) as { eventId: string }).eventId;
      }
      const idx = this.db
        .prepare(`SELECT COUNT(*) AS c, (SELECT eventId FROM trace_index WHERE taskId = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1) AS lastId FROM trace_index WHERE taskId = ?`)
        .get(t.taskId, t.taskId) as { c: number; lastId: string | null };
      if (idx.c !== fileCount || idx.lastId !== lastFileEventId) {
        // 不一致 → 删除该 task 全部索引行，从 JSONL 全量重放重建（幂等）
        this.db.prepare('DELETE FROM trace_index WHERE taskId = ?').run(t.taskId);
        if (fileCount > 0) {
          const insert = this.db.prepare(
            'INSERT INTO trace_index (eventId, taskId, agentVersionId, eventType, timestamp) VALUES (?,?,?,?,?)',
          );
          const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
          for (const line of lines) {
            const ev = JSON.parse(line) as { eventId: string; agentVersionId: string; eventType: string; timestamp: string };
            insert.run(ev.eventId, t.taskId, ev.agentVersionId, ev.eventType, ev.timestamp);
          }
        }
        report.reconciledTasks.push(t.taskId);
      }
    }

    // ② 崩溃标记：仅 Running 遗留 → Failed:Runtime(CrashRecovery)（A3 §6 F-1 修订：Queued 为持久化待执行、
    //    无执行副作用，不迁移——保持可被后续 task run 进程取出执行）；二次重启不再改写（幂等）
    const leftovers = this.db
      .prepare(`SELECT taskId, agentId, agentVersionId, specContentHash, status FROM task_record WHERE status = 'running'`)
      .all() as { taskId: string; agentId: string; agentVersionId: string; specContentHash: string; status: string }[];
    for (const t of leftovers) {
      const base = { taskId: t.taskId, agentId: t.agentId, agentVersionId: t.agentVersionId, specContentHash: t.specContentHash };
      const marked = this.trace.recordTaskEvent(base, 'crash_recovery_marked', {
        detectedBy: 'startup_scan', lastKnownStatus: t.status,
      });
      const recordId = this.failures.record({
        taskId: t.taskId, agentId: t.agentId, agentVersionId: t.agentVersionId,
        attemptNo: 0, failureClass: 'Runtime', subClass: 'CrashRecovery',
        message: `重启发现 Running 遗留（lastKnownStatus=${t.status}），不做断点续跑（A3 §6，Queued 不迁移）`,
        expectedVsActual: { expected: '终态或无记录', actual: t.status }, traceRef: marked.eventId,
      });
      this.db
        // §4.7-4（批次四）：终局顺带清 abortRequested 残留——跨进程中止意图不外溢到终态行（无害残留清理 + 断言钉死）
        .prepare(`UPDATE task_record SET status='failed', endedAt=?, terminalFailureClass='Runtime(CrashRecovery)', abortRequested=0 WHERE taskId=?`)
        .run(nowNs(), t.taskId);
      this.trace.recordTaskEvent(base, 'task_failed', {
        failureClass: 'Runtime', subClass: 'CrashRecovery', failureRecordId: recordId,
      });
      // R-4：孤儿 PauseSnapshot 兜底清理——kill 落在 snapshot 写后、Paused 迁移前 → 任务从未进入 Paused；
      // 同窗口内已写入的 pending ApprovalRequest 一并作废（superseded）——否则 approve/deny 永远 task_not_paused、list 永远挂脏行
      this.db.prepare('DELETE FROM pause_snapshot WHERE taskId = ?').run(t.taskId);
      this.db
        .prepare(`UPDATE approval_request SET decision='superseded', decidedAt=? WHERE taskId = ? AND decision='pending'`)
        .run(nowNs(), t.taskId);
      report.crashMarkedTasks.push(t.taskId);
    }

    // v1.1 只读警示（A3 §6）：不改状态、不写 FailureRecord、不写 Trace——可见性交还操作者
    // P3-②（批次二反方遗留）：比较锚点统一用 nowNs()（与 createdAt/timeoutAt 同为 RFC3339 亚秒精度）——
    // toISOString() 固定 3 位毫秒，与 6+ 位小数做字符串比较存在亚秒级漏判（同毫秒内 '.500Z' > '.499999Z' 假不成立）
    report.staleQueuedTasks = (
      this.db
        .prepare(`SELECT taskId FROM task_record WHERE status = 'queued' AND createdAt < ?`)
        .all(new Date(Date.now() - STALE_QUEUED_GRACE_MS - 1).toISOString().replace(/\.\d{3}Z$/, '.999999999Z')) as { taskId: string }[]
    ).map((r) => r.taskId);
    report.stalePausedTasks = (
      this.db
        .prepare(
          `SELECT t.taskId FROM task_record t JOIN approval_request a ON a.taskId = t.taskId
           WHERE t.status = 'paused' AND a.decision = 'pending' AND a.timeoutAt < ?`,
        )
        .all(nowNs()) as { taskId: string }[]
    ).map((r) => r.taskId);
    return report;
  }

  // ---------- 先持久化后继续的 TaskRecord 状态写入（A3 不变式②） ----------
  // expectFrom（可选）：比较并交换（CAS）——UPDATE 带 AND status=expectFrom，changes=0 即竞争失败（先落库者生效，库层强制）。

  transition(taskId: string, status: string, extra: Partial<Record<string, unknown>> = {}, expectFrom?: string): boolean {
    const sets = ['status = ?'];
    const values: unknown[] = [status];
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      values.push(v);
    }
    let where = 'taskId = ?';
    values.push(taskId);
    if (expectFrom !== undefined) {
      where += ' AND status = ?';
      values.push(expectFrom);
    }
    const result = this.db.prepare(`UPDATE task_record SET ${sets.join(', ')} WHERE ${where}`).run(...values);
    return result.changes === 1;
  }
}
