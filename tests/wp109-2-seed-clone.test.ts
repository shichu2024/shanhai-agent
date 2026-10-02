import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput } from './helpers.js';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { WHITELIST } from './helpers.js';
import { cloneTaskForSeed, SeedCloneError } from '../src/modules/seedClone.js';
import type { TraceEnvelope } from '../src/modules/traceRecorder.js';

// TASK-109（每日优化第一批·第二项）：种子克隆 trace eventId 唯一化。
// 备案缺陷：直接复制 trace JSONL 构造种子保留原 eventId，boot 时 recover() 重放
// trace_index 撞 eventId PRIMARY KEY → 拒启。本测试钉死：经 cloneTaskForSeed 重复克隆
// 同一源任务，eventId/taskId 空间互不相交，重启（startup→recover 对账）正常启动零冲突。

function dbOf(rt: Runtime): import('better-sqlite3').Database {
  return (rt as unknown as { db: import('better-sqlite3').Database }).db;
}

describe('TASK-109 种子克隆 eventId 唯一化（cloneTaskForSeed）', () => {
  it('克隆足迹完整：task_record + trace JSONL（eventId/taskId 全新）+ failure_record traceRef 重指 + trace_index 一致', async () => {
    // 源任务跑出失败终局（带 failure_record，覆盖 traceRef 重映射路径）
    const h = makeHarness([
      { kind: 'text', text: '这不是 JSON' },
      { kind: 'text', text: '仍然不是 JSON' },
      { kind: 'text', text: '还不是 JSON' },
    ]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'seed-src-a' }));
    const srcTaskId = h.rt.tasks.createTask('seed-src-a', validInput, 't');
    const row = await h.rt.tasks.runTask(srcTaskId);
    expect(row.status).toBe('failed');
    const db = dbOf(h.rt);

    const srcEvents = h.rt.trace.readEvents(srcTaskId) as TraceEnvelope[];
    const srcFailures = db.prepare('SELECT * FROM failure_record WHERE taskId = ?').all(srcTaskId) as { recordId: string; traceRef: string | null }[];
    expect(srcFailures.length).toBeGreaterThan(0);

    const result = cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, srcTaskId);
    expect(result.eventCount).toBe(srcEvents.length);
    expect(result.failureCount).toBe(srcFailures.length);
    expect(result.taskId).not.toBe(srcTaskId);

    // 事件唯一化：新 JSONL 逐事件 eventId 全新、taskId/traceId 重写、时间戳保留（趋势分布不变）
    const cloneFile = path.join(h.rt.tracesDir, `${result.taskId}.jsonl`);
    expect(existsSync(cloneFile)).toBe(true);
    const cloneEvents = readFileSync(cloneFile, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as TraceEnvelope);
    const srcIds = new Set(srcEvents.map((e) => e.eventId));
    for (const ev of cloneEvents) {
      expect(srcIds.has(ev.eventId)).toBe(false);
      expect(ev.taskId).toBe(result.taskId);
      expect(ev.traceId).toBe(result.taskId);
    }
    expect(cloneEvents.map((e) => e.timestamp)).toEqual(srcEvents.map((e) => e.timestamp));

    // task_record 克隆行：新 taskId + 新 traceFile 路径，状态/计数随源
    const cloneRow = db.prepare('SELECT * FROM task_record WHERE taskId = ?').get(result.taskId) as { status: string; traceFile: string; modelCallCount: number };
    expect(cloneRow.status).toBe('failed');
    expect(cloneRow.traceFile).toBe(cloneFile);
    expect(cloneRow.modelCallCount).toBe(row.modelCallCount);

    // failure_record：recordId/taskId 全新，traceRef 指向克隆事件（映射内）
    const cloneFailures = db.prepare('SELECT * FROM failure_record WHERE taskId = ?').all(result.taskId) as { recordId: string; traceRef: string | null }[];
    const cloneEventIds = new Set(cloneEvents.map((e) => e.eventId));
    const srcRecordIds = new Set(srcFailures.map((f) => f.recordId));
    for (const f of cloneFailures) {
      expect(srcRecordIds.has(f.recordId)).toBe(false); // recordId 全新
    }
    for (const f of cloneFailures) {
      expect(f.traceRef === null || cloneEventIds.has(f.traceRef)).toBe(true);
    }

    // trace_index 与 JSONL 一致（克隆侧直接落索引）
    const idxCount = db.prepare('SELECT COUNT(*) c FROM trace_index WHERE taskId = ?').get(result.taskId) as { c: number };
    expect(idxCount.c).toBe(cloneEvents.length);

    h.rt.close();
  });

  it('重复克隆可正常启动：同一源任务克隆两次 → 新进程 startup（recover 对账重放）零 UNIQUE 冲突', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(validOutput()) }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'seed-src-b' }));
    const srcTaskId = h.rt.tasks.createTask('seed-src-b', validInput, 't');
    expect((await h.rt.tasks.runTask(srcTaskId)).status).toBe('succeeded');

    const db = dbOf(h.rt);
    const clone1 = cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, srcTaskId);
    const clone2 = cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, srcTaskId); // 重复克隆同一源
    h.rt.close();

    // 新进程 boot：startup → recover() 以 JSONL 为真源对账——修复前此路径撞 trace_index PRIMARY KEY 拒启
    const rt2 = Runtime.withProvider(new MockProvider([]), WHITELIST, h.dataDir, h.repoRoot);
    expect(() => rt2.startup('boot-check')).not.toThrow();
    const db2 = dbOf(rt2);

    // 三任务（源 + 两克隆）eventId 互不相交；各任务索引行数 = JSONL 行数（对账零漂移）
    const rows = db2.prepare('SELECT taskId, COUNT(*) c FROM trace_index GROUP BY taskId').all() as { taskId: string; c: number }[];
    const byTask = new Map(rows.map((r) => [r.taskId, r.c]));
    for (const tid of [srcTaskId, clone1.taskId, clone2.taskId]) {
      const lines = readFileSync(path.join(rt2.tracesDir, `${tid}.jsonl`), 'utf8').split('\n').filter((l) => l.trim().length > 0);
      expect(byTask.get(tid)).toBe(lines.length);
    }
    const total = db2.prepare('SELECT COUNT(*) c, COUNT(DISTINCT eventId) d FROM trace_index').get() as { c: number; d: number };
    expect(total.c).toBe(total.d); // 全局 eventId 无重复（PK 不变式成立）

    // 再 boot 一次（幂等）：二次 startup 不再触发重放漂移
    expect(() => rt2.startup('boot-check-2')).not.toThrow();
    rt2.close();
  });

  it('边界 fail-fast：源任务不存在 / trace 文件缺失 → 结构化 SeedCloneError', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(validOutput()) }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'seed-src-c' }));
    const srcTaskId = h.rt.tasks.createTask('seed-src-c', validInput, 't');
    await h.rt.tasks.runTask(srcTaskId);
    const db = dbOf(h.rt);

    expect(() => cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, 'no-such-task')).toThrowError(SeedCloneError);
    try {
      cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, 'no-such-task');
    } catch (err) {
      expect(err).toBeInstanceOf(SeedCloneError);
      expect((err as SeedCloneError).code).toBe('task_not_found');
    }

    // task_record 有行但 JSONL 被删（分叉）：trace_file_missing，不静默
    const lone = h.rt.tasks.createTask('seed-src-c', validInput, 't');
    rmSync(path.join(h.rt.tracesDir, `${lone}.jsonl`));
    expect(() => cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, lone)).toThrowError(/trace 文件缺失/);
    h.rt.close();
  });
});
