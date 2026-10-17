import { describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { makeHarness, sampleSpec, registerAndRelease } from './helpers.js';

// 每日优化第十六批（TASK-163）：modules/evidenceStore.ts 分支覆盖加固（基线分支 87.93%，
// 未覆盖 234/255/270/273/290/302/312 段）。真实运行时构造（零 src 改动）：
//  - 234/255：孤儿 failure/memory（taskId 无对应 task_record 行）→ LEFT JOIN specContentHash
//    为 NULL → 信封 specContentHash ?? '' 回退空串（悬空引用仍可读证据本体，不 404）；
//  - 273：parentTaskId 指向不存在的任务 → 上溯 stmt.get 无行 → break（祖先链止步）；
//  - 270/290：parentTaskId 环（A↔B）→ 上溯 seen 命中 break + 子树 BFS seen 命中 continue
//    （环形防御：不发散、不死循环）；
//  - 302：trace_index 有索引行但任务 JSONL 文件不存在 → readRawLine existsSync false →
//    not_found（索引与文件分叉的文件缺失形态）；
//  - 312：taskEvidence 的 readJsonl 文件缺失 → 计 0 事件（对账 consistent=false 如实返回）。

function dbOf(rt: unknown): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function traceFileOf(rt: unknown, taskId: string): string {
  return (rt as unknown as { trace: { traceFile(id: string): string } }).trace.traceFile(taskId);
}

describe('wp163 evidenceStore：孤儿 failure/memory → 信封 specContentHash 回退空串（evidenceStore.ts:234/255）', () => {
  it('failure_record 的 taskId 无 task_record 行 → show 成功且 envelope.specContentHash 为空串', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp163-eva-agent' }));
    const db = dbOf(h.rt);
    db.prepare(
      `INSERT INTO failure_record (recordId, taskId, agentId, agentVersionId, attemptNo, failureClass, subClass,
         message, expectedVsActual, countedInContractRate, occurredAt)
       VALUES ('wp163-f1', 'wp163-ghost-task', 'wp163-eva-agent', 'ver-wp163', 1, 'output', 'contract-mismatch',
         '输出缺 summary 字段', '期望 summary 非空，实际为空', 0, '2026-10-18T00:00:00.000Z')`,
    ).run();
    const r = h.rt.evidence.show('failure:wp163-f1');
    expect(r).toMatchObject({
      ok: true, kind: 'failure', ref: 'failure:wp163-f1',
      envelope: { taskId: 'wp163-ghost-task', agentId: 'wp163-eva-agent', agentVersionId: 'ver-wp163', specContentHash: '' },
      status: 'excluded-from-contract-rate', // countedInContractRate=0
      payload: '输出缺 summary 字段\n期望 summary 非空，实际为空',
    });
  });

  it('memory_record 的 taskId 无 task_record 行 → show 成功且 envelope.specContentHash 为空串', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp163-eva-agent' }));
    const db = dbOf(h.rt);
    db.prepare(
      `INSERT INTO memory_record (memoryId, agentId, agentVersionId, taskId, kind, content, contentDigest,
         status, createdAt, lastUpdatedAt)
       VALUES ('wp163-m1', 'wp163-eva-agent', 'ver-wp163', 'wp163-ghost-task', 'episodic',
         '该域接口须带 traceId 重试', 'digest-wp163-m1', 'candidate',
         '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z')`,
    ).run();
    const r = h.rt.evidence.show('memory:wp163-m1');
    expect(r).toMatchObject({
      ok: true, kind: 'memory', ref: 'memory:wp163-m1',
      envelope: { taskId: 'wp163-ghost-task', agentId: 'wp163-eva-agent', agentVersionId: 'ver-wp163', specContentHash: '' },
      status: 'candidate',
      payload: '该域接口须带 traceId 重试',
    });
  });
});

describe('wp163 evidenceStore：委托树上溯/子树环形与悬空防御（evidenceStore.ts:269-295）', () => {
  it('parentTaskId 指向不存在的任务 → 上溯无行 break，祖先链为空（evidenceStore.ts:273）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp163-eva-agent' }));
    const t1 = h.rt.tasks.createTask('wp163-eva-agent', { topic: '悬空父链' }, 't');
    dbOf(h.rt).prepare('UPDATE task_record SET parentTaskId = ? WHERE taskId = ?').run('wp163-ghost-parent', t1);
    const chain = h.rt.evidence.taskEvidence(t1);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    expect(chain.parentTaskId).toBe('wp163-ghost-parent');
    expect(chain.delegationChain.ancestors).toEqual([]); // 无行 → break（不猜测、不发散）
  });

  it('parentTaskId 环（A↔B）→ 上溯 seen 命中 break + 子树 BFS seen 命中 continue（evidenceStore.ts:270/290）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp163-eva-agent' }));
    const a = h.rt.tasks.createTask('wp163-eva-agent', { topic: '环 A' }, 't');
    const b = h.rt.tasks.createTask('wp163-eva-agent', { topic: '环 B' }, 't');
    const db = dbOf(h.rt);
    db.prepare('UPDATE task_record SET parentTaskId = ? WHERE taskId = ?').run(b, a); // A.parent = B
    db.prepare('UPDATE task_record SET parentTaskId = ? WHERE taskId = ?').run(a, b); // B.parent = A（成环）
    const chain = h.rt.evidence.taskEvidence(a);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    // 上溯：cursor=B（未见）入链 → cursor=A 已 seen → break：祖先 = [B] 恰一层，不死循环
    expect(chain.delegationChain.ancestors.map((x) => x.taskId)).toEqual([b]);
    // 子树：A 的孩子 = [B] 入队；B 的孩子 = [A] 已 seen → continue：子树 = [B]，不回环
    expect(chain.delegationChain.descendants.map((x) => x.taskId)).toEqual([b]);
  });
});

describe('wp163 evidenceStore：trace 文件缺失形态（evidenceStore.ts:302/312）', () => {
  it('trace_index 有索引行但任务 JSONL 文件不存在 → readRawLine 回退 not_found（evidenceStore.ts:302）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp163-eva-agent' }));
    dbOf(h.rt).prepare(
      'INSERT INTO trace_index (eventId, taskId, agentVersionId, eventType, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run('wp163-e-nojs', 'wp163-nojs-task', 'ver-wp163', 'assistant_message', '2026-10-18T00:00:00.000Z');
    const r = h.rt.evidence.show('trace_event:wp163-e-nojs');
    expect(r).toMatchObject({ ok: false, code: 'not_found', kind: 'trace_event', ref: 'trace_event:wp163-e-nojs' });
    expect((r as { message?: string }).message ?? '').toContain('JSONL 零命中');
  });

  it('任务 JSONL 文件被移除 → taskEvidence 计 0 事件，对账 consistent=false 如实返回（evidenceStore.ts:312）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp163-eva-agent' }));
    const taskId = h.rt.tasks.createTask('wp163-eva-agent', { topic: '文件缺失' }, 't');
    expect(h.rt.trace.readEvents(taskId).length).toBeGreaterThan(0); // 基座成立：JSONL 原本存在
    unlinkSync(traceFileOf(h.rt, taskId)); // 模拟文件缺失（索引行保留）
    const chain = h.rt.evidence.taskEvidence(taskId);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    expect(chain.trace.traceIndexRows).toBeGreaterThan(0); // 索引行仍在
    expect(chain.trace.jsonlEvents).toBe(0); // readJsonl existsSync false → []
    expect(chain.trace.eventIds).toEqual([]);
    expect(chain.trace.consistent).toBe(false); // 分叉如实暴露
  });
});
