import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import {
  makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, registerL3Tool,
  fakeSecret, type Harness,
} from './helpers.js';
import {
  EvidenceStore, EvidenceRefError, parseEvidenceRef, EVIDENCE_REF_KINDS,
  type EvidenceShow,
} from '../src/modules/evidenceStore.js';

// WP-5B 批次一（§4.1，D-35）：Evidence Store 只读派生存取层。
// A-23 解析 API（封闭枚举 5 种 + not_found/not_implemented 结构化错误）
// A-24 evidence task 全链证据链（trace 对账 + failure/memory 关联 + 委托父子链）
// A-25 零写入（dbDump 全库快照）+ payload 逐字节一致（读已脱敏落盘体，不二次脱敏——§9-1）

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 全库内容快照（只读派生断言：全操作前后完全一致——零表零迁移零新事件零写入） */
function dbDump(db: Database.Database): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    parts.push(`${t}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

const delegateArgs = (agentId: string) => ({ agentId, input: validInput, note: '委托说明' });

/** 委托父 Spec：声明 task-delegate（L3 + targetWhitelist）+ onHighRisk */
function delegateParentSpec(agentId: string, whitelist: string[]): Record<string, unknown> {
  return sampleSpec({
    agentId,
    tools: [{ toolId: 'task-delegate', riskLevel: 'L3', controlledFields: { targetWhitelist: whitelist } }],
    extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
  });
}

/** 委托子 Spec：含 L3 工具 + 持久化记忆（子成功终态写 memory——A-24 关联 memory 行基座） */
function childSpec(agentId: string): Record<string, unknown> {
  return sampleSpec({
    agentId,
    tools: [{ toolId: 'l3-op', riskLevel: 'L3' }],
    extraTop: {
      approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 },
      memoryPolicy: { type: 'persistent' },
    },
  });
}

/** 完整委托链夹具：父→委托→子（含 L3 审批）→子成功（写记忆）→父成功；父任务上另落一条 failure */
async function delegationFixture(h: Harness, parentAgent = 'ev-parent', childAgent = 'ev-child') {
  registerL3Tool(h);
  const parentVersionId = registerAndRelease(h.rt, delegateParentSpec(parentAgent, [childAgent]));
  registerAndRelease(h.rt, childSpec(childAgent));
  const parentTaskId = h.rt.tasks.createTask(parentAgent, validInput, 't');

  let row = await h.rt.tasks.runTask(parentTaskId);
  expect(row.status).toBe('paused'); // 委托审批挂起
  const delegateRequest = h.rt.approvals.pendingForTask(parentTaskId)!;
  h.rt.approvals.approve(delegateRequest.requestId, 'human');

  row = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
  expect(row.status).toBe('paused'); // 子 L3 信号上浮，父在委托边界等待
  const childTaskId = (
    dbOf(h.rt).prepare('SELECT taskId FROM task_record WHERE parentTaskId = ?').all(parentTaskId) as { taskId: string }[]
  )[0].taskId;
  const childRequest = h.rt.approvals.pendingForTask(childTaskId)!;
  h.rt.approvals.approve(childRequest.requestId, 'human');
  const childFinal = await h.rt.tasks.runTask(childTaskId, null, { resume: true, resumedBy: 'manual-resume' });
  expect(childFinal.status).toBe('succeeded');
  const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
  expect(parentFinal.status).toBe('succeeded');

  // 父任务上落一条 failure（A-24 关联 failure 行基座；traceRef 回链父 trace 事件）
  const firstParentEvent = h.rt.trace.readEvents(parentTaskId)[0];
  const recordId = h.rt.failures.record({
    taskId: parentTaskId, agentId: parentAgent, agentVersionId: parentVersionId, attemptNo: 1,
    failureClass: 'Model', subClass: 'provider_error',
    message: '供应商 5xx（证据演示）', expectedVsActual: { expected: 200, actual: 503 },
    traceRef: firstParentEvent.eventId,
  });
  return { parentTaskId, childTaskId, recordId, parentAgent, parentVersionId };
}

// ============================================================
// A-23：统一引用格式 + 解析 API
// ============================================================

describe('WP-5B 批次一 A-23：统一证据引用格式与解析 API', () => {
  it('EVIDENCE_REF_KINDS = 封闭枚举 5 种（eval 为预留位——D-36 成文载体）', () => {
    expect([...EVIDENCE_REF_KINDS]).toEqual(['task', 'trace_event', 'failure', 'memory', 'eval']);
  });

  it('parseEvidenceRef：<kind>:<id> 解析；非法形态（无冒号/未知 kind/空 id）→ invalid_ref', () => {
    expect(parseEvidenceRef('task:t-1')).toEqual({ kind: 'task', id: 't-1' });
    expect(parseEvidenceRef('trace_event:e-1')).toEqual({ kind: 'trace_event', id: 'e-1' });
    expect(parseEvidenceRef('failure:f-1')).toEqual({ kind: 'failure', id: 'f-1' });
    expect(parseEvidenceRef('memory:m-1')).toEqual({ kind: 'memory', id: 'm-1' });
    expect(parseEvidenceRef('eval:x-1')).toEqual({ kind: 'eval', id: 'x-1' }); // 格式合法（解析层面），执行层面 not_implemented
    expect(() => parseEvidenceRef('nos-colon')).toThrow(EvidenceRefError);
    expect(() => parseEvidenceRef('task')).toThrow(EvidenceRefError);
    expect(() => parseEvidenceRef('ghost:1')).toThrow(EvidenceRefError);
    expect(() => parseEvidenceRef('task:')).toThrow(EvidenceRefError);
    expect(() => parseEvidenceRef('task:t-1:extra')).toThrow(EvidenceRefError); // 恰一个冒号（id 不含冒号）
  });

  it('四种合法 ref 单查询解析：信封四字段 + digest + 状态 + occurredAt + payload 字段集冻结', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('ev-child') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId, recordId, parentAgent, parentVersionId } = await delegationFixture(h);
    const store: EvidenceStore = h.rt.evidence;

    // --- task ref ---
    const taskShow = store.show(`task:${parentTaskId}`);
    expect(taskShow.ok).toBe(true);
    const t = taskShow as Extract<EvidenceShow, { ok: true }>;
    expect(Object.keys(t).sort()).toEqual(['digest', 'envelope', 'kind', 'occurredAt', 'ok', 'payload', 'ref', 'status'].sort());
    expect(t.kind).toBe('task');
    expect(t.envelope).toEqual({
      taskId: parentTaskId,
      agentId: parentAgent,
      agentVersionId: parentVersionId,
      specContentHash: dbOf(h.rt).prepare('SELECT specContentHash FROM task_record WHERE taskId = ?').get(parentTaskId).specContentHash,
    });
    expect(t.status).toBe('succeeded');
    expect(t.digest).toMatch(/^[0-9a-f]{64}$/);

    // --- trace_event ref（父任务首个事件）---
    const firstEvent = h.rt.trace.readEvents(parentTaskId)[0];
    const evShow = store.show(`trace_event:${firstEvent.eventId}`);
    expect(evShow.ok).toBe(true);
    const e = evShow as Extract<EvidenceShow, { ok: true }>;
    expect(e.kind).toBe('trace_event');
    expect(e.envelope).toEqual({
      taskId: firstEvent.taskId, agentId: firstEvent.agentId,
      agentVersionId: firstEvent.agentVersionId, specContentHash: firstEvent.specContentHash,
    });
    expect(e.status).toBe(firstEvent.eventType); // 事件类型即状态描述（成文口径）

    // --- failure ref ---
    const failShow = store.show(`failure:${recordId}`);
    expect(failShow.ok).toBe(true);
    const f = failShow as Extract<EvidenceShow, { ok: true }>;
    expect(f.kind).toBe('failure');
    expect(f.envelope.taskId).toBe(parentTaskId);
    expect(f.envelope.agentId).toBe(parentAgent);
    expect(f.status).toBe('excluded-from-contract-rate'); // provider_error 不在契约口径（countedInContractRate=0）

    // --- memory ref（子成功终态写入）---
    const memoryId = (
      dbOf(h.rt).prepare('SELECT memoryId FROM memory_record WHERE taskId = ?').get(childTaskId) as { memoryId: string }
    ).memoryId;
    const memShow = store.show(`memory:${memoryId}`);
    expect(memShow.ok).toBe(true);
    const m = memShow as Extract<EvidenceShow, { ok: true }>;
    expect(m.kind).toBe('memory');
    expect(m.envelope.taskId).toBe(childTaskId);
    expect(['candidate', 'active', 'degraded', 'retired']).toContain(m.status); // memory 状态机口径
  });

  it('不存在 ref → not_found 结构化错误（四种 kind 各一）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('ev-child') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    await delegationFixture(h);
    for (const ref of ['task:ghost', 'trace_event:ghost', 'failure:ghost', 'memory:ghost']) {
      const r = h.rt.evidence.show(ref);
      expect(r).toMatchObject({ ok: false, code: 'not_found', ref });
    }
  });

  it('eval:* → not_implemented 结构化错误（预留位成文：不静默、不猜测——D-36）', () => {
    const h = makeHarness([]);
    const r = h.rt.evidence.show('eval:any-id');
    expect(r).toMatchObject({ ok: false, code: 'not_implemented', ref: 'eval:any-id', kind: 'eval' });
    expect((r as { message?: string }).message ?? '').toMatch(/not_implemented|预留|D-36/);
  });

  it('读已脱敏落盘体：含密钥任务 input 落盘已脱敏，回读 payload 含 [REDACTED:*] 而非原文（不二次脱敏也不放行原文）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ev-secret-agent' }));
    const taskId = h.rt.tasks.createTask('ev-secret-agent', { topic: `密钥样本 ${fakeSecret()}` }, 't');
    const r = h.rt.evidence.show(`task:${taskId}`) as Extract<EvidenceShow, { ok: true }>;
    expect(r.payload).toContain('[REDACTED:');
    expect(r.payload).not.toContain(fakeSecret());
  });
});

// ============================================================
// A-24：evidence task 全链证据链
// ============================================================

describe('WP-5B 批次一 A-24：任务全链证据链', () => {
  it('trace_index 行数 = JSONL 事件数对账；关联 failure/memory 行齐；委托父子链沿树返回', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('ev-child') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId, recordId } = await delegationFixture(h);
    const store: EvidenceStore = h.rt.evidence;

    // --- 子任务链 ---
    const childChain = store.taskEvidence(childTaskId);
    expect(childChain.ok).toBe(true);
    const c = childChain as Extract<ReturnType<EvidenceStore['taskEvidence']>, { ok: true }>;
    const childIndexRows = (
      dbOf(h.rt).prepare('SELECT COUNT(*) AS n FROM trace_index WHERE taskId = ?').get(childTaskId) as { n: number }
    ).n;
    const childJsonl = h.rt.trace.readEvents(childTaskId).length;
    expect(childIndexRows).toBeGreaterThan(0);
    expect(c.trace.traceIndexRows).toBe(childIndexRows);
    expect(c.trace.jsonlEvents).toBe(childJsonl);
    expect(c.trace.consistent).toBe(true); // 对账一致
    expect(c.trace.eventIds).toHaveLength(childJsonl);
    expect(c.memories.map((x) => x.memoryId)).toEqual(
      (dbOf(h.rt).prepare('SELECT memoryId FROM memory_record WHERE taskId = ?').all(childTaskId) as { memoryId: string }[]).map((x) => x.memoryId),
    );
    expect(c.failures).toEqual([]);
    expect(c.parentTaskId).toBe(parentTaskId);
    expect(c.delegationDepth).toBe(1);
    expect(c.delegationChain.ancestors.map((a) => a.taskId)).toEqual([parentTaskId]); // 父链（近→远）
    expect(c.delegationChain.descendants).toEqual([]);

    // --- 父任务链 ---
    const p = store.taskEvidence(parentTaskId) as Extract<ReturnType<EvidenceStore['taskEvidence']>, { ok: true }>;
    expect(p.parentTaskId).toBeNull();
    expect(p.delegationDepth).toBe(0);
    expect(p.failures.map((x) => x.recordId)).toEqual([recordId]);
    expect(p.delegationChain.ancestors).toEqual([]);
    expect(p.delegationChain.descendants.map((d) => d.taskId)).toEqual([childTaskId]); // 委托子树单查询沿树
    expect(p.delegationChain.descendants[0].delegationDepth).toBe(1);
  });

  it('对账不一致（索引与 JSONL 行数分叉）→ consistent=false 且两侧计数如实返回（不猜测、不静默）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('ev-child') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId } = await delegationFixture(h);
    // 人为删除一行索引（模拟漂移——只读层须如实报告）
    dbOf(h.rt).prepare('DELETE FROM trace_index WHERE rowid = (SELECT MIN(rowid) FROM trace_index WHERE taskId = ?)').run(parentTaskId);
    const p = h.rt.evidence.taskEvidence(parentTaskId) as Extract<ReturnType<EvidenceStore['taskEvidence']>, { ok: true }>;
    expect(p.trace.consistent).toBe(false);
    expect(p.trace.traceIndexRows).toBe(p.trace.jsonlEvents - 1);
  });

  it('不存在任务 → not_found 结构化错误', () => {
    const h = makeHarness([]);
    expect(h.rt.evidence.taskEvidence('ghost-task')).toMatchObject({ ok: false, code: 'not_found' });
  });
});

// ============================================================
// A-25：零写入 + payload 逐字节一致
// ============================================================

describe('WP-5B 批次一 A-25：只读派生（零表零迁移零新事件零写入）+ 逐字节一致回读', () => {
  it('全操作 dbDump 全库快照零变化（show 四 kind + not_found + eval + taskEvidence ×2）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('ev-child') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId, recordId } = await delegationFixture(h);
    const memoryId = (dbOf(h.rt).prepare('SELECT memoryId FROM memory_record WHERE taskId = ?').get(childTaskId) as { memoryId: string }).memoryId;
    const eventId = h.rt.trace.readEvents(parentTaskId)[0].eventId;

    const before = dbDump(dbOf(h.rt));
    void h.rt.evidence.show(`task:${parentTaskId}`);
    void h.rt.evidence.show(`trace_event:${eventId}`);
    void h.rt.evidence.show(`failure:${recordId}`);
    void h.rt.evidence.show(`memory:${memoryId}`);
    void h.rt.evidence.show('task:ghost');
    void h.rt.evidence.show('eval:whatever');
    void h.rt.evidence.taskEvidence(parentTaskId);
    void h.rt.evidence.taskEvidence(childTaskId);
    const after = dbDump(dbOf(h.rt));
    expect(after).toBe(before); // 零写入（含 audit_events——只读层零新事件）
  });

  it('payload 与已脱敏落盘体逐字节一致：task.input / trace JSONL 原始行 / failure 两文本列 / memory.content', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('ev-child') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId, recordId } = await delegationFixture(h);

    // task：与 task_record.input 存储值逐字节一致
    const taskRow = dbOf(h.rt).prepare('SELECT input FROM task_record WHERE taskId = ?').get(parentTaskId) as { input: string };
    const t = h.rt.evidence.show(`task:${parentTaskId}`) as Extract<EvidenceShow, { ok: true }>;
    expect(t.payload).toBe(taskRow.input);

    // trace_event：与 JSONL 原始行（去行尾换行）逐字节一致
    const firstEvent = h.rt.trace.readEvents(parentTaskId)[0];
    const rawLine = readFileSync(h.rt.trace.traceFile(parentTaskId), 'utf8')
      .split('\n')
      .find((line) => line.includes(`"eventId":"${firstEvent.eventId}"`))!;
    const e = h.rt.evidence.show(`trace_event:${firstEvent.eventId}`) as Extract<EvidenceShow, { ok: true }>;
    expect(e.payload).toBe(rawLine);

    // failure：与 message + expectedVsActual 两存储文本列按成文口径拼接逐字节一致
    const failRow = dbOf(h.rt).prepare('SELECT message, expectedVsActual FROM failure_record WHERE recordId = ?').get(recordId) as { message: string; expectedVsActual: string };
    const f = h.rt.evidence.show(`failure:${recordId}`) as Extract<EvidenceShow, { ok: true }>;
    expect(f.payload).toBe(`${failRow.message}\n${failRow.expectedVsActual}`);

    // memory：与 memory_record.content 存储值逐字节一致
    const memRow = dbOf(h.rt).prepare('SELECT content FROM memory_record WHERE taskId = ?').get(childTaskId) as { content: string };
    const memId = (dbOf(h.rt).prepare('SELECT memoryId FROM memory_record WHERE taskId = ?').get(childTaskId) as { memoryId: string }).memoryId;
    const m = h.rt.evidence.show(`memory:${memId}`) as Extract<EvidenceShow, { ok: true }>;
    expect(m.payload).toBe(memRow.content);

    // digest 口径：sha256(payload)（task/memory/trace_event/failure 统一——读侧对账锚点）
    const { sha256Hex } = await import('../src/hash.js');
    expect(t.digest).toBe(sha256Hex(taskRow.input));
    expect(m.digest).toBe(sha256Hex(memRow.content));
    expect(e.digest).toBe(sha256Hex(rawLine));
    expect(f.digest).toBe(sha256Hex(`${failRow.message}\n${failRow.expectedVsActual}`));
  });
});

// ============================================================
// CLI 面（机械断言：形态不变，与 Agent Card 先例同款）
// ============================================================

describe('WP-5B 批次一 CLI 面', () => {
  it('usage 含 evidence show / evidence task 命令行（源文本机械断言）', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
    expect(src).toContain('shanhai evidence show <ref>');
    expect(src).toContain('shanhai evidence task <taskId>');
  });
});
