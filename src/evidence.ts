import type Database from 'better-sqlite3';
import type { Runtime } from './runtime.js';
import type { TraceEnvelope } from './modules/traceRecorder.js';

// T1/T2 单一查询口径（A6 §6）：库内单查询 / 单文件 grep-able，无跨系统步。
// T1 两级答案形态（P2-7）：有 task_started → 完整绑定；无（Created→Failed / CrashRecovery）→ 信封级版本。

export interface T1Answer {
  taskId: string;
  agentVersionId: string;
  specContentHash: string;
  specSnapshot: unknown;
  bindingSnapshot: { toolVersions: { toolId: string; implVersion: string }[]; modelId: string; promptHash: string } | null;
  hasTaskStarted: boolean;
}

export function queryT1(rt: Runtime, taskId: string): T1Answer {
  const events = rt.trace.readEvents(taskId); // 单文件（traces/<taskId>.jsonl）
  if (events.length === 0) throw new Error(`无 Trace 文件：${taskId}`);
  const envelope = events[0]; // 信封字段在每个事件上（版本固定原则）
  const version = rt.registry.getVersion(envelope.agentVersionId);
  if (!version) throw new Error(`版本不存在：${envelope.agentVersionId}（库或快照被篡改）`);
  const started = events.find((e) => e.eventType === 'task_started') as (TraceEnvelope & { bindingSnapshot: T1Answer['bindingSnapshot'] }) | undefined;
  return {
    taskId,
    agentVersionId: envelope.agentVersionId,
    specContentHash: envelope.specContentHash,
    specSnapshot: JSON.parse(version.specSnapshot),
    bindingSnapshot: started?.bindingSnapshot ?? null,
    hasTaskStarted: started !== undefined,
  };
}

export interface T2Answer {
  agentVersionId: string;
  agentId: string;
  rejectedRequests: {
    eventId: string; kind: string; who: string; whenAt: string; target: string | null; rejectReason: string | null;
  }[];
  policyDeniedEvents: {
    eventId: string; taskId: string; timestamp: string; callNo: number; toolId: string; reasonCode: string; consecutiveDenialCount: number;
  }[];
  /** NULL 兜底单列计数（A6 §4 P2-2）：指针解析失败的 task_creation 拒绝，按 agentId 可见而非静默消失 */
  unresolvableTaskCreations: number;
}

export function queryT2(rt: Runtime, agentVersionId: string): T2Answer {
  const db: Database.Database = (rt as unknown as { db: Database.Database }).db;
  const version = rt.registry.getVersion(agentVersionId);
  if (!version) throw new Error(`版本不存在：${agentVersionId}`);

  const rejected = db
    .prepare(
      `SELECT eventId, kind, who, whenAt, target, rejectReason FROM audit_events
       WHERE agentVersionId = ? AND kind IN ('task_creation','cli_operation')
       ORDER BY whenAt`,
    )
    .all(agentVersionId) as T2Answer['rejectedRequests'];

  const deniedIndex = db
    .prepare(`SELECT eventId, taskId, timestamp FROM trace_index WHERE agentVersionId = ? AND eventType = 'policy_denied' ORDER BY timestamp`)
    .all(agentVersionId) as { eventId: string; taskId: string; timestamp: string }[];

  const byTask = new Map<string, string[]>();
  for (const row of deniedIndex) {
    const list = byTask.get(row.taskId) ?? [];
    list.push(row.eventId);
    byTask.set(row.taskId, list);
  }
  const policyDeniedEvents: T2Answer['policyDeniedEvents'] = [];
  for (const [taskId, eventIds] of byTask) {
    const wanted = new Set(eventIds);
    for (const ev of rt.trace.readEvents(taskId)) {
      if (wanted.has(ev.eventId)) {
        policyDeniedEvents.push({
          eventId: ev.eventId, taskId, timestamp: ev.timestamp, callNo: ev.callNo,
          toolId: String(ev.toolId ?? ''), reasonCode: String(ev.reasonCode ?? ''),
          consecutiveDenialCount: Number(ev.consecutiveDenialCount ?? 0),
        });
      }
    }
  }

  const unresolvable = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE kind='task_creation' AND agentVersionId IS NULL AND target = ?`)
      .get(version.agentId) as { c: number }
  ).c;

  return { agentVersionId, agentId: version.agentId, rejectedRequests: rejected, policyDeniedEvents, unresolvableTaskCreations: unresolvable };
}
