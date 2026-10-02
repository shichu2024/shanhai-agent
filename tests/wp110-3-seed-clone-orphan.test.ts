import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput } from './helpers.js';
import type { Runtime } from '../src/runtime.js';
import { cloneTaskForSeed } from '../src/modules/seedClone.js';

// TASK-110（每日优化第二批·第三项）：cloneTaskForSeed 孤儿 JSONL 回删（TASK-109 反方备案 P3-2）。
// 备案缺陷：先落 JSONL 后开事务（D-6 同序），事务失败时残留无 task_record 的孤儿 JSONL——
// 新 eventId 唯一不至于拒启，但 boot 对账会产生无主 trace 行。契约：事务失败时回删已落盘 JSONL，
// traces 目录与库面恢复到克隆前原状（task_record / trace_index 零残留）。

function dbOf(rt: Runtime): import('better-sqlite3').Database {
  return (rt as unknown as { db: import('better-sqlite3').Database }).db;
}

describe('TASK-110 cloneTaskForSeed 事务失败回删孤儿 JSONL', () => {
  it('事务失败：JSONL 被回删，traces 目录与库面零残留（task_record/trace_index 不新增）', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(validOutput()) }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'seed-orphan-a' }));
    const srcTaskId = h.rt.tasks.createTask('seed-orphan-a', validInput, 't');
    expect((await h.rt.tasks.runTask(srcTaskId)).status).toBe('succeeded');
    const db = dbOf(h.rt);

    const taskCountBefore = (db.prepare('SELECT COUNT(*) c FROM task_record').get() as { c: number }).c;
    const traceCountBefore = (db.prepare('SELECT COUNT(*) c FROM trace_index').get() as { c: number }).c;
    const filesBefore = new Set(readdirSync(h.rt.tracesDir));

    // 注入事务失败：克隆路径必经 trace_index 插入——触发器强制 ABORT
    db.exec(`CREATE TRIGGER wp110_force_clone_fail BEFORE INSERT ON trace_index BEGIN SELECT RAISE(ABORT, 'wp110 forced'); END`);

    expect(() => cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, srcTaskId)).toThrow(/wp110 forced/);

    // 孤儿 JSONL 已被回删：目录集合与克隆前一致
    const filesAfter = new Set(readdirSync(h.rt.tracesDir));
    expect([...filesAfter].sort()).toEqual([...filesBefore].sort());
    for (const f of filesAfter) {
      if (!filesBefore.has(f)) expect(existsSync(path.join(h.rt.tracesDir, f))).toBe(false); // 无新增文件
    }

    // 库面零残留（事务回滚）
    expect((db.prepare('SELECT COUNT(*) c FROM task_record').get() as { c: number }).c).toBe(taskCountBefore);
    expect((db.prepare('SELECT COUNT(*) c FROM trace_index').get() as { c: number }).c).toBe(traceCountBefore);

    // 移除注入后同一源任务可正常克隆（失败不留副作用）
    db.exec('DROP TRIGGER wp110_force_clone_fail');
    const ok = cloneTaskForSeed({ db, tracesDir: h.rt.tracesDir }, srcTaskId);
    expect(existsSync(path.join(h.rt.tracesDir, `${ok.taskId}.jsonl`))).toBe(true);
    h.rt.close();
  });
});
