import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { sha256Hex } from '../src/hash.js';
import { redactEventPayload } from '../src/modules/redaction.js';
import type { RedactionPolicy } from '../src/modules/redaction.js';
import {
  makeHarness, sampleSpec, validOutput, validInput, registerAndRelease,
  registerL3Tool, approvalSpec, memorySpec, fakeSecret, WHITELIST,
} from './helpers.js';

// WP-3B 批次二（§4.2 DB 侧脱敏 + §4.7-③）：四落盘面入库前过同一 redaction 实例。
// DoD：① 四落盘面行内零命中 ② 同实例断言 ③ contextJson 结构完整性 ④ 实验路径继承
//      ⑤ inputHash 原文对账 ⑥ 改进断言①（密钥→记忆→注入→provider system 端到端）⑦ 消费点清单（docs/phase3/02）。

const SECRET = fakeSecret();

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

const secretInputSpec = () => sampleSpec({
  inputContract: {
    type: 'object',
    properties: { topic: { type: 'string', minLength: 1, maxLength: 200 }, token: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['topic'],
    additionalProperties: false,
  },
});

describe('批次二 DoD-①/⑤：task_record.input 入库前过管道 + inputHash 原文对账', () => {
  it('input 含密钥 → DB 行零命中 + [REDACTED:*] 改写；task_created.inputHash = 原文摘要', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(validOutput()) }]);
    const agent = 'db-redact-input';
    const spec = secretInputSpec();
    (spec.identity as { agentId: string }).agentId = agent;
    registerAndRelease(h.rt, spec);
    const input = { topic: '含密钥输入', token: SECRET };
    const taskId = h.rt.tasks.createTask(agent, input, 'test');
    await h.rt.tasks.runTask(taskId);

    const row = dbOf(h.rt).prepare('SELECT input FROM task_record WHERE taskId = ?').get(taskId) as { input: string };
    expect(row.input).not.toContain(SECRET);
    expect(row.input).toContain('[REDACTED:');

    // DoD-⑤：inputHash 原文口径（跨任务对账键不破）
    const created = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_created')!;
    expect(created.inputHash).toBe(sha256Hex(JSON.stringify(input)));
    // §9.1-3 双写一致性：Trace 载荷 input 与 DB 行改写结果一致（同一实例）
    expect(JSON.stringify((created as { input?: unknown }).input)).toBe(row.input);
  });

  it('跨任务同 input（含密钥）→ 两任务 task_created.inputHash 相同（T1 对账在脱敏开启库不破）', async () => {
    const h = makeHarness([
      { kind: 'text', text: JSON.stringify(validOutput()) },
      { kind: 'text', text: JSON.stringify(validOutput()) },
    ]);
    const spec = secretInputSpec();
    (spec.identity as { agentId: string }).agentId = 'db-redact-t1';
    registerAndRelease(h.rt, spec);
    const input = { topic: '对账', token: SECRET };
    const id1 = h.rt.tasks.createTask('db-redact-t1', input, 'test');
    const id2 = h.rt.tasks.createTask('db-redact-t1', input, 'test');
    await h.rt.tasks.runTask(id1);
    await h.rt.tasks.runTask(id2);
    const h1 = h.rt.trace.readEvents(id1).find((e) => e.eventType === 'task_created')!;
    const h2 = h.rt.trace.readEvents(id2).find((e) => e.eventType === 'task_created')!;
    expect(h1.inputHash).toBe(h2.inputHash);
    expect(h1.inputHash).toBe(sha256Hex(JSON.stringify(input)));
  });
});

describe('批次二 DoD-①/③：pause_snapshot.contextJson 解析后结构过管道（禁止字符串级正则）', () => {
  it('挂起快照含密钥 → contextJson 零命中；可解析 + 消息数/结构不变（对照无密钥运行）', async () => {
    const mk = async (args: Record<string, unknown>, input: Record<string, unknown>) => {
      const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args }] }]);
      registerL3Tool(h);
      registerAndRelease(h.rt, approvalSpec('db-redact-pause'));
      const taskId = h.rt.tasks.createTask('db-redact-pause', input, 'test');
      const row = await h.rt.tasks.runTask(taskId);
      expect(row.status).toBe('paused');
      return h.rt.approvals.getSnapshot(taskId)!;
    };
    const secretSnap = await mk({ payload: SECRET }, { topic: `输入含密钥 ${SECRET}` });
    const controlSnap = await mk({ payload: '普通参数' }, { topic: '普通输入' });

    // 零命中
    expect(secretSnap.contextJson).not.toContain(SECRET);
    expect(secretSnap.contextJson).toContain('[REDACTED:');
    // DoD-③ 结构完整性：脱敏后可解析 + 消息数不变（与同形无密钥对照一致）
    const secretCtx = JSON.parse(secretSnap.contextJson) as { messages: unknown[]; assistantToolCalls: unknown[]; pendingIndex: number };
    const controlCtx = JSON.parse(controlSnap.contextJson) as { messages: unknown[]; assistantToolCalls: unknown[]; pendingIndex: number };
    expect(secretCtx.messages).toHaveLength(controlCtx.messages.length);
    expect(secretCtx.assistantToolCalls).toHaveLength(controlCtx.assistantToolCalls.length);
    expect(typeof secretCtx.pendingIndex).toBe('number');
  });
});

describe('批次二 DoD-①：note-append 副作用输出过管道（data/notes.md）', () => {
  it('笔记含密钥 → notes.md 零命中 + [REDACTED:*]', async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'shanhai-note-'));
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'n1', toolId: 'note-append', args: { note: `观察到密钥 ${SECRET}` } }] },
      { kind: 'text', text: JSON.stringify(validOutput()) },
    ], repoRoot);
    registerAndRelease(h.rt, sampleSpec({ tools: [{ toolId: 'note-append', riskLevel: 'L1' }] }));
    const taskId = h.rt.tasks.createTask('docs-analyst', validInput, 'test');
    await h.rt.tasks.runTask(taskId);
    const notesPath = path.join(repoRoot, 'data', 'notes.md');
    expect(existsSync(notesPath)).toBe(true);
    const notes = readFileSync(notesPath, 'utf8');
    expect(notes).not.toContain(SECRET);
    expect(notes).toContain('[REDACTED:');
  });
});

describe('批次二 DoD-①：failure_record.message/expectedVsActual + audit_events.rejectReason 过管道', () => {
  it('failure 行 message 与 expectedVsActual 含密钥 → 零命中（排除表字段零改写）', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(validOutput()) }]);
    const agent = 'db-redact-fail';
    registerAndRelease(h.rt, sampleSpec({ agentId: agent }));
    const taskId = h.rt.tasks.createTask(agent, validInput, 'test');
    await h.rt.tasks.runTask(taskId);
    const base = dbOf(h.rt).prepare('SELECT agentVersionId FROM task_record WHERE taskId = ?').get(taskId) as { agentVersionId: string };

    const recordId = h.rt.failures.record({
      taskId, agentId: agent, agentVersionId: base.agentVersionId, attemptNo: 1,
      failureClass: 'Output', subClass: 'contract_mismatch',
      message: `输出不符契约，实际输出含密钥 ${SECRET}`,
      expectedVsActual: { expected: '符合契约', actual: SECRET, someDigest: SECRET, someHash: SECRET },
    });
    const row = dbOf(h.rt).prepare('SELECT message, expectedVsActual FROM failure_record WHERE recordId = ?').get(recordId) as { message: string; expectedVsActual: string };
    expect(row.message).not.toContain(SECRET);
    expect(row.message).toContain('[REDACTED:');
    const eva = JSON.parse(row.expectedVsActual) as { actual: string; someDigest: string; someHash: string };
    expect(eva.actual).not.toBe(SECRET);
    // *Digest 排除表既有 + §4.7-③ *Hash 后缀入排除表：digest/hash 字段零改写（原文口径）
    expect(eva.someDigest).toBe(SECRET);
    expect(eva.someHash).toBe(SECRET);
  });

  it('写入点直达：rejectReason 含密钥 JSON → 入库零命中 + [REDACTED:*]（结构级改写）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'db-redact-audit' }));
    h.rt.audit.rejectedRequest({
      kind: 'task_creation', who: 'test', target: 'db-redact-audit',
      inputHash: sha256Hex('x'), rejectReason: JSON.stringify([{ path: '$.token', message: `实际值 ${SECRET}` }]),
    });
    const row = dbOf(h.rt).prepare('SELECT rejectReason FROM audit_events WHERE kind = ?').get('task_creation') as { rejectReason: string };
    expect(row.rejectReason).not.toContain(SECRET);
    expect(row.rejectReason).toContain('[REDACTED:');
    expect(Array.isArray(JSON.parse(row.rejectReason))).toBe(true); // 结构级改写（可解析保持）
  });

  it('真实路径回归：契约违规拒绝（violation 描述不携带原文值）→ rejectReason 零命中', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({
      agentId: 'db-redact-audit2',
      inputContract: {
        type: 'object',
        properties: { topic: { type: 'string', minLength: 1, maxLength: 8 } },
        required: ['topic'],
        additionalProperties: false,
      },
    }));
    expect(() => h.rt.tasks.createTask('db-redact-audit2', { topic: `超长且含密钥${SECRET}` }, 'test')).toThrow();
    const row = dbOf(h.rt).prepare('SELECT rejectReason FROM audit_events WHERE kind = ?').get('task_creation') as { rejectReason: string };
    expect(row.rejectReason).not.toContain(SECRET);
  });
});

describe('批次二 DoD-②：同一 redaction 管道实例（注入标记规则 → Trace 与 DB 四面改写结果一致）', () => {
  it('自定义 marker 规则在 Trace/task_record/pause_snapshot/notes/failure 五面一致改写（实例分裂即红灯）', async () => {
    const marker = 'ZZMARKER7Q';
    const policy: RedactionPolicy = { rules: [{ ruleId: 'marker', pattern: marker, scope: 'all' }] };
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'shanhai-inst-'));
    const h = makeHarness([
      { kind: 'tool_use', calls: [
        { id: 'n1', toolId: 'note-append', args: { note: `标记 ${marker}` } },
        { id: 'c1', toolId: 'l3-op', args: { payload: marker } },
      ] },
    ], repoRoot, { redaction: policy });
    registerL3Tool(h);
    registerAndRelease(h.rt, sampleSpec({
      agentId: 'db-redact-inst',
      tools: [{ toolId: 'note-append', riskLevel: 'L1' }, { toolId: 'l3-op', riskLevel: 'L3' }],
      extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
    }));
    const taskId = h.rt.tasks.createTask('db-redact-inst', { topic: `标记 ${marker}` }, 'test');
    await h.rt.tasks.runTask(taskId); // → paused（l3-op 挂起）

    const REPL = '[REDACTED:marker]';
    // 面 1：Trace JSONL（task_created 载荷 input）
    const created = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_created')!;
    expect(JSON.stringify((created as { input?: unknown }).input)).toContain(REPL);
    // 面 2：task_record.input
    const taskRow = dbOf(h.rt).prepare('SELECT input FROM task_record WHERE taskId = ?').get(taskId) as { input: string };
    expect(taskRow.input).toContain(REPL);
    expect(JSON.stringify((created as { input?: unknown }).input)).toBe(taskRow.input);
    // 面 3：pause_snapshot.contextJson（挂起调用 args + 用户消息）
    const snap = h.rt.approvals.getSnapshot(taskId)!;
    expect(snap.contextJson).toContain(REPL);
    // 面 4：notes.md（副作用输出）
    const notes = readFileSync(path.join(repoRoot, 'data', 'notes.md'), 'utf8');
    expect(notes).toContain(REPL);
    // 面 5：failure_record（直达写入点）
    const version = dbOf(h.rt).prepare('SELECT agentVersionId FROM task_record WHERE taskId = ?').get(taskId) as { agentVersionId: string };
    const rid = h.rt.failures.record({
      taskId, agentId: 'db-redact-inst', agentVersionId: version.agentVersionId, attemptNo: 0,
      failureClass: 'Runtime', subClass: 'InternalError', message: `标记 ${marker}`, expectedVsActual: { expected: marker },
    });
    const frow = dbOf(h.rt).prepare('SELECT message FROM failure_record WHERE recordId = ?').get(rid) as { message: string };
    expect(frow.message).toContain(REPL);
  });
});

describe('批次二 DoD-④：实验路径继承（experiment-runs/ 同 modules 构建自动继承脱敏）', () => {
  it('experiment 形态构造（不传 redaction → 默认规则集）→ 落盘面零命中', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'shanhai-exp-'));
    const dataDir = path.join(root, 'experiment-runs', 'hyp4-inherit');
    const provider = new MockProvider([{ kind: 'text', text: JSON.stringify(validOutput()) }]);
    const rt = new Runtime({ dataDir, repoRoot: root, provider, whitelist: new Set(WHITELIST) });
    rt.startup('experiment');
    const spec = secretInputSpec();
    (spec.identity as { agentId: string }).agentId = 'exp-inherit';
    registerAndRelease(rt, spec);
    const taskId = rt.tasks.createTask('exp-inherit', { topic: '实验继承', token: SECRET }, 'experiment');
    await rt.tasks.runTask(taskId);

    const row = dbOf(rt).prepare('SELECT input FROM task_record WHERE taskId = ?').get(taskId) as { input: string };
    expect(row.input).not.toContain(SECRET);
    const rid = rt.failures.record({
      taskId, agentId: 'exp-inherit',
      agentVersionId: (dbOf(rt).prepare('SELECT agentVersionId FROM task_record WHERE taskId = ?').get(taskId) as { agentVersionId: string }).agentVersionId,
      attemptNo: 0, failureClass: 'Runtime', subClass: 'InternalError',
      message: `实验失败 ${SECRET}`, expectedVsActual: { expected: 'ok' },
    });
    const frow = dbOf(rt).prepare('SELECT message FROM failure_record WHERE recordId = ?').get(rid) as { message: string };
    expect(frow.message).not.toContain(SECRET);
  });
});

describe('批次二 DoD-⑥ 改进断言①：密钥输出→记忆→注入→provider system 端到端无密钥', () => {
  it('含密钥输出写记忆（redacted）→ 两任务复证 active → 第三任务注入 system 无密钥', async () => {
    const h = makeHarness([
      { kind: 'text', text: JSON.stringify({ ...validOutput(), summary: `结论含密钥 ${SECRET}` }) },
      { kind: 'text', text: JSON.stringify({ ...validOutput(), summary: `结论含密钥 ${SECRET}` }) },
      { kind: 'text', text: JSON.stringify(validOutput()) },
    ]);
    registerAndRelease(h.rt, memorySpec('db-redact-mem', { injection: 'context' }));
    const mkTask = () => h.rt.tasks.createTask('db-redact-mem', validInput, 'test');
    await h.rt.tasks.runTask(mkTask());
    await h.rt.tasks.runTask(mkTask());
    await h.rt.tasks.runTask(mkTask());

    // 记忆行零命中
    const rows = dbOf(h.rt).prepare('SELECT content FROM memory_record WHERE agentId = ?').all('db-redact-mem') as { content: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.content).not.toContain(SECRET);

    // 注入调用：system 含边界标记且无密钥（改进断言①核心）
    const injectedCalls = h.provider.receivedCalls.filter((c) => c.system.includes('MEMORY-REFERENCE-BEGIN'));
    expect(injectedCalls.length).toBeGreaterThan(0);
    for (const c of injectedCalls) {
      expect(c.system).not.toContain(SECRET);
      expect(c.system).toContain('[REDACTED:');
    }
  });
});

describe('批次二 §4.7-③：*Hash 后缀入脱敏排除表（自定义 hex 规则不误改写摘要字段面）', () => {
  it('键名以 Hash/Digest 结尾的字符串值零改写；自由文本键照常改写', () => {
    const policy: RedactionPolicy = { rules: [{ ruleId: 'hexish', pattern: 'AAAABBBBCCCC', scope: 'all' }] };
    const { payload } = redactEventPayload(
      { inputHash: 'AAAABBBBCCCC', contentHash: 'AAAABBBBCCCC', outputDigest: 'AAAABBBBCCCC', note: 'AAAABBBBCCCC' },
      policy,
    ) as { payload: Record<string, string> };
    expect(payload.inputHash).toBe('AAAABBBBCCCC');
    expect(payload.contentHash).toBe('AAAABBBBCCCC');
    expect(payload.outputDigest).toBe('AAAABBBBCCCC');
    expect(payload.note).toBe('[REDACTED:hexish]');
  });
});
