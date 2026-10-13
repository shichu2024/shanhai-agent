import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeHarness, sampleSpec, registerAndRelease } from './helpers.js';

// 每日优化第十二批（TASK-151）：modules/evidenceStore.ts 分支覆盖加固（基线分支 82.45%，
// 未覆盖 307 = readRawLine 全文件扫描零命中 → return null——「trace_index 有索引行但
// JSONL 零命中，索引与文件分叉」防御路径）。以真实运行时构造：手工向 trace_index 插入
// 一条 eventId 与任务 JSONL 不对应的索引行（模拟分叉），evidence.show 该 trace_event
// 引用 → 结构化 not_found（JSONL 零命中口径），且全操作零写入面不受影响。

function dbOf(rt: unknown): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

describe('wp151 evidenceStore：trace_index 与 JSONL 分叉 → readRawLine 零命中回退（evidenceStore.ts:300-308）', () => {
  it('索引行命中但 JSONL 无该 eventId → not_found（JSONL 零命中，索引与文件分叉）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp151-evo-agent' }));
    const taskId = h.rt.tasks.createTask('wp151-evo-agent', { topic: '索引分叉夹具' }, 't');
    // 确认该任务 JSONL 真实存在（trace 落盘基座成立）
    expect(h.rt.trace.readEvents(taskId).length).toBeGreaterThan(0);
    // 手工制造分叉：索引行指向该任务，但 eventId 在 JSONL 中不存在
    const db = dbOf(h.rt);
    db.prepare(
      'INSERT INTO trace_index (eventId, taskId, agentVersionId, eventType, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run('wp151-fake-event-0001', taskId, 'ver-wp151', 'assistant_message', '2026-10-13T00:00:00.000Z');
    const r = h.rt.evidence.show('trace_event:wp151-fake-event-0001');
    expect(r).toMatchObject({ ok: false, code: 'not_found', kind: 'trace_event', ref: 'trace_event:wp151-fake-event-0001' });
    expect((r as { message?: string }).message ?? '').toContain('JSONL 零命中');
  });
});
