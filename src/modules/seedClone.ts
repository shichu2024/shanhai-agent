import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { uuid } from '../hash.js';
import type { TraceEnvelope } from './traceRecorder.js';

// TASK-109（每日优化第一批·第二项）：走查/开发种子克隆——taskId 与 eventId 全量唯一化重铺。
//
// 背景（第七阶段终验收走查备案）：直接复制 trace JSONL 构造种子会保留原 eventId；
// boot 时 recover() 以 JSONL 为唯一真源重放 trace_index（stateManager §6.1 对账重建），
// 撞 eventId PRIMARY KEY → SqliteError(UNIQUE) → 进程拒启。走查当时靠手工改写 eventId 规避。
//
// 本模块把该路径产品化：克隆一个任务的完整足迹（task_record + trace JSONL + failure_record +
// trace_index 索引行），每次克隆生成全新 taskId，并逐事件生成全新 eventId（taskId/traceId 同步重写；
// timestamp 原样保留——趋势/报表/走查页面的时间分布语义不变；failure_record.traceRef 按映射重指）。
// 同一源任务重复克隆任意次数，eventId 空间互不相交 → boot 对账重放零冲突。
//
// 刻意不克隆（边界，成文防误用）：
//   - approval_request / pause_snapshot：在途审批与挂起快照是执行态，种子只需终态足迹；
//   - memory_record：去重键 (agentId, contentDigest) 会撞唯一索引，且记忆为 Agent 级资产非任务级；
//   - audit_events：登记面审计与任务足迹解耦，复制会造成重复审计。
//
// 落盘次序遵循 D-6 同款约束：先 JSONL 文件，后索引/库行。

export interface SeedCloneResult {
  taskId: string;
  eventCount: number;
  failureCount: number;
}

export class SeedCloneError extends Error {
  constructor(
    message: string,
    readonly code: 'task_not_found' | 'trace_file_missing',
    readonly taskId: string,
  ) {
    super(message);
    this.name = 'SeedCloneError';
  }
}

/** 动态列插入（列名取自 SELECT * 的行键——对 addColumn 增列迁移免疫，不硬编码列清单） */
function insertRowClone(db: Database.Database, table: string, row: Record<string, unknown>, overrides: Record<string, unknown>): void {
  const cols = Object.keys(row);
  const values = cols.map((c) => (c in overrides ? overrides[c] : row[c]));
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
}

/** 克隆一个任务足迹作为种子（eventId/taskId 唯一化；重复克隆可正常启动——测试钉死，见 tests/wp109-2-seed-clone.test.ts） */
export function cloneTaskForSeed(deps: { db: Database.Database; tracesDir: string }, sourceTaskId: string): SeedCloneResult {
  const { db, tracesDir } = deps;
  const src = db.prepare('SELECT * FROM task_record WHERE taskId = ?').get(sourceTaskId) as
    | (Record<string, unknown> & { agentId: string; agentVersionId: string })
    | undefined;
  if (!src) throw new SeedCloneError(`种子任务不存在（task_record 零命中）：${sourceTaskId}`, 'task_not_found', sourceTaskId);
  const srcFile = path.join(tracesDir, `${sourceTaskId}.jsonl`);
  if (!existsSync(srcFile)) {
    throw new SeedCloneError(`种子 trace 文件缺失（JSONL 与 task_record 分叉）：${srcFile}`, 'trace_file_missing', sourceTaskId);
  }

  const newTaskId = uuid();
  const newTraceFile = path.join(tracesDir, `${newTaskId}.jsonl`);
  const events = readFileSync(srcFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceEnvelope);
  const idMap = new Map<string, string>();
  const newEvents = events.map((ev) => {
    const eventId = uuid();
    idMap.set(ev.eventId, eventId);
    return { ...ev, eventId, taskId: newTaskId, traceId: newTaskId };
  });

  // D-6 同序：先 JSONL 落盘成功，后库行（task_record + trace_index + failure_record 同事务）。
  // TASK-110（P3-2 收口）：事务失败时回删已落盘 JSONL——不留无 task_record 的孤儿 trace 行
  // （新 eventId 唯一不至于拒启，但 boot 对账会产生无主 JSONL；fail 后目录与库面恢复原状）。
  writeFileSync(newTraceFile, newEvents.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');

  const failures = db.prepare('SELECT * FROM failure_record WHERE taskId = ?').all(sourceTaskId) as Record<string, unknown>[];
  try {
    db.transaction(() => {
      insertRowClone(db, 'task_record', src, { taskId: newTaskId, traceFile: newTraceFile });
      const insTrace = db.prepare('INSERT INTO trace_index (eventId, taskId, agentVersionId, eventType, timestamp) VALUES (?,?,?,?,?)');
      for (const ev of newEvents) {
        insTrace.run(ev.eventId, newTaskId, ev.agentVersionId, ev.eventType, ev.timestamp);
      }
      for (const f of failures) {
        const traceRef = typeof f.traceRef === 'string' ? f.traceRef : null;
        insertRowClone(db, 'failure_record', f, {
          recordId: uuid(),
          taskId: newTaskId,
          // traceRef 重指克隆事件；映射外引用（理论不可达）保留原值——原事件仍存在，证据链不断
          traceRef: traceRef !== null ? (idMap.get(traceRef) ?? traceRef) : null,
        });
      }
    })();
  } catch (err) {
    rmSync(newTraceFile, { force: true });
    throw err;
  }

  return { taskId: newTaskId, eventCount: newEvents.length, failureCount: failures.length };
}
