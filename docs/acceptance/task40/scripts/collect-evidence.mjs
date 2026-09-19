// 汇集 C1 与 F-1 证据（从既有 data 目录只读提取）
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';

const out = {};

// F-1：CLI 两进程 create→run 被 startup 恢复扫描判死（c1 目录，真实发生序列）
{
  const dir = 'D:/code/shanhai-agent/data/acceptance-task40/c1';
  const db = new Database(dir + '/shanhai.db', { readonly: true });
  const row = db.prepare(`SELECT taskId, status, terminalFailureClass, createdAt, startedAt, endedAt FROM task_record WHERE terminalFailureClass='Runtime(CrashRecovery)'`).all();
  const specRegRejected = db.prepare(`SELECT kind, target, rejectReason FROM audit_events WHERE kind='spec_registration' ORDER BY whenAt`).all();
  db.close();
  const trace = readFileSync(dir + '/traces/' + row[0].taskId + '.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((e) => ({ t: e.timestamp, event: e.eventType, lastKnownStatus: e.lastKnownStatus ?? null, failure: e.subClass ? e.failureClass + '(' + e.subClass + ')' : null }));
  out.f1_cli_defect = { crashedQueuedTasks: row, traceSequence: trace, c3_1_rejectedRegistrations: specRegRejected };
}

// C1：单进程真实端到端（c1b 目录）
{
  const dir = 'D:/code/shanhai-agent/data/acceptance-task40/c1b';
  const db = new Database(dir + '/shanhai.db', { readonly: true });
  const tasks = db.prepare(`SELECT taskId, agentId, agentVersionId, status, modelCallCount, tokensUsed, attemptCount, terminalFailureClass FROM task_record`).all();
  db.close();
  const trace = readFileSync(dir + '/traces/' + tasks[0].taskId + '.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const succ = trace.find((e) => e.eventType === 'task_succeeded');
  const started = trace.find((e) => e.eventType === 'task_started');
  out.c1 = {
    taskRow: tasks[0],
    eventCount: trace.length,
    eventTypes: trace.map((e) => e.eventType),
    toolCalls: trace.filter((e) => e.eventType === 'tool_call_executed').map((e) => e.toolId),
    bindingSnapshot: started.bindingSnapshot,
    output: succ.output,
    outputContractVerdict: succ.outputContractVerdict,
  };
}
console.log(JSON.stringify(out, null, 2));
