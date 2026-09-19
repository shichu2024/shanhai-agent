import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';

// §11 兼容迁移路径：全部 schema 变更 = 新表 + ADD COLUMN / CHECK 扩展（agent_version 重建）——无数据回填
describe('v1 存量库原地升级（零回填，A3 §4 / A5 D-10）', () => {
  it('v1 库（无 reviewed 态、无新表新列）→ 打开即迁移：数据保留、新能力可用、幂等', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-mig-'));
    // 先按 v1 结构手工构造存量库
    const raw = new Database(path.join(dataDir, 'shanhai.db'));
    raw.exec(`
      CREATE TABLE agent_version (
        versionId TEXT PRIMARY KEY, agentId TEXT NOT NULL, version INTEGER NOT NULL,
        specSnapshot TEXT NOT NULL, contentHash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','released','deprecated')),
        registeredAt TEXT NOT NULL, registeredBy TEXT NOT NULL
      );
      CREATE TABLE task_record (
        taskId TEXT PRIMARY KEY, agentId TEXT NOT NULL, agentVersionId TEXT NOT NULL,
        specContentHash TEXT NOT NULL, input TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('created','queued','running','paused','succeeded','failed','cancelled')),
        attemptCount INTEGER NOT NULL DEFAULT 0, modelCallCount INTEGER NOT NULL DEFAULT 0,
        tokensUsed INTEGER NOT NULL DEFAULT 0, consecutiveDenialCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, startedAt TEXT, endedAt TEXT, traceFile TEXT NOT NULL,
        terminalFailureClass TEXT, evaluationId TEXT, evolutionCandidateId TEXT
      );
    `);
    raw.prepare(`INSERT INTO agent_version VALUES ('v-old','a1',1,'{}','hash-1','released','2026-01-01T00:00:00Z','legacy')`).run();
    raw.prepare(
      `INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, createdAt, traceFile)
       VALUES ('t-old','a1','v-old','hash-1','{}','queued','2026-01-01T00:00:00Z','x.jsonl')`,
    ).run();
    raw.close();

    // 打开即迁移（openDatabase → migrate）
    const handles = openDatabase(dataDir);
    const db = handles.db;
    // ① 存量数据保留
    const v = db.prepare(`SELECT * FROM agent_version WHERE versionId='v-old'`).get() as { status: string; specSnapshot: string };
    expect(v.status).toBe('released');
    expect(v.specSnapshot).toBe('{}');
    // ② reviewed 状态可写入（A5 D-10 迁移目标）
    expect(() => db.prepare(`INSERT INTO agent_version VALUES ('v-new','a1',2,'{}','hash-2','reviewed','2026-01-02T00:00:00Z','x')`).run()).not.toThrow();
    // ③ 不可变触发器在重建后仍然生效（DROP TABLE 会连带删触发器——迁移须重建）
    expect(() => db.prepare(`UPDATE agent_version SET specSnapshot='tampered' WHERE versionId='v-old'`).run()).toThrowError(/immutable/);
    expect(() => db.prepare(`DELETE FROM agent_version WHERE versionId='v-old'`).run()).toThrowError(/immutable/);
    // ④ task_record v1.1 新列存在且默认值 = 第一阶段语义
    const t = db.prepare(`SELECT abortRequested, pausedDurationMs, cancelReason FROM task_record WHERE taskId='t-old'`).get() as { abortRequested: number; pausedDurationMs: number; cancelReason: string | null };
    expect(t).toMatchObject({ abortRequested: 0, pausedDurationMs: 0, cancelReason: null });
    // ⑤ 新表存在
    expect(() => db.prepare(`SELECT COUNT(*) c FROM approval_request`).get()).not.toThrow();
    expect(() => db.prepare(`SELECT COUNT(*) c FROM pause_snapshot`).get()).not.toThrow();
    // ⑥ 幂等：二次打开不报错不重复迁移
    db.close();
    const handles2 = openDatabase(dataDir);
    expect((handles2.db.prepare(`SELECT COUNT(*) c FROM agent_version`).get() as { c: number }).c).toBe(2);
    handles2.db.close();
  });
});
