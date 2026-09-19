// 增补 A 重启进程：触发 StateManager.recover()，输出恢复报告与全部断言结果
import { Runtime } from '../../dist/runtime.js';
import { queryT2 } from '../../dist/evidence.js';
import Database from 'better-sqlite3';

const [dataDir, taskId, versionId] = process.argv.slice(2);
const rt = new Runtime({
  dataDir, repoRoot: process.cwd(),
  provider: { name: 'never', chat: async () => { throw new Error('不应被调用'); } },
  whitelist: new Set(['mock-model']),
});
const report = rt.startup('restart-after-kill9');

const db = (rt) => (rt).db ?? ((rt) => { throw new Error('no db'); })(rt);
const fileLines = rt.trace.readEvents(taskId);
const idxCount = ((rt) => {
  const d = rt;
  return d;
})(rt);
// 取内部 db
const internalDb = (() => { const x = rt; return x; })();
void internalDb; void db; void idxCount;

const sqlite = new Database(dataDir + '/shanhai.db', { readonly: true });
const indexCount = sqlite.prepare('SELECT COUNT(*) c FROM trace_index WHERE taskId=?').get(taskId).c;
const crashEvents = fileLines.filter((e) => e.eventType === 'crash_recovery_marked' || (e.eventType === 'task_failed' && e.subClass === 'CrashRecovery'));
const preCrashCount = fileLines.findIndex((e) => e.eventType === 'crash_recovery_marked');
const crashEventIndexed = sqlite.prepare(`SELECT COUNT(*) c FROM trace_index WHERE taskId=? AND eventType='crash_recovery_marked'`).get(taskId).c;
const t2 = queryT2(rt, versionId);
const row = rt.tasks.getTask(taskId);
sqlite.close();

const out = {
  recovery: { reconciledTasks: report.reconciledTasks, crashMarkedTasks: report.crashMarkedTasks },
  a7_indexRebuild: {
    fileLineCount: fileLines.length, indexRowCount: indexCount,
    consistent: indexCount === fileLines.length,
    pass: report.reconciledTasks.includes(taskId) && indexCount === fileLines.length,
  },
  a8_t2_recheck: {
    policyDeniedEvents: t2.policyDeniedEvents.map((e) => ({ toolId: e.toolId, reasonCode: e.reasonCode, consecutiveDenialCount: e.consecutiveDenialCount })),
    pass: t2.policyDeniedEvents.length === 1 && t2.policyDeniedEvents[0].toolId === 'undeclared-evil',
  },
  a9_ordering: {
    taskStatus: row.status, terminalFailureClass: row.terminalFailureClass,
    crashMarkedAfterAllPreCrashEvents: preCrashCount > 0 && preCrashCount === fileLines.findIndex((e) => e.eventType === 'task_failed'),
    crashAppendedCount: crashEvents.length,
    crashEventsInIndex: crashEventIndexed,
    crashTraceOnFullIndex: indexCount === fileLines.length && crashEventIndexed === 1,
    pass: row.status === 'failed' && row.terminalFailureClass === 'Runtime(CrashRecovery)' && crashEventIndexed === 1 && indexCount === fileLines.length,
  },
};
console.log(JSON.stringify(out));
rt.close();
