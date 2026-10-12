import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf } from './helpers.js';
import { DelegationWaitSignal } from '../src/modules/toolExecutor.js';
import { governDelegationStatic } from '../src/runtime/delegation.js';

// TASK-144 第十批：delegation 真实行为路径补强。
// 基线（main @ 82192c8）未覆盖段 → 本文件用例映射：
//   215-217       → resolveAgent 灰度分派（canary 指针 + 权重 → assignmentSource=canary）
//   65 / 73 分支   → govern：agentId 缺省（?? ''）；委托链上溯遇缺失行 break
//   102-103 分支   → execute：args.input 缺省（?? null，子任务 input 记 null）
//   113 分支       → 锚定重入：子行缺失 → 等待信号含「缺失」
//   147-148 分支   → task_delegated 事件 note 缺省（null）
//   189 分支       → summarize：子 succeeded 但 trace 无 task_succeeded 输出 → output/outputDigest 均 null
//   235 / 240     → getTaskRow 缺失行 → null；baseOf 父行缺失 → 结构化报错

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function eventsOf(rt: Runtime, taskId: string) {
  return rt.trace.readEvents(taskId);
}

/** 委托父 Spec（onHighRisk + task-delegate） */
function delegateParentSpec(agentId: string, whitelist: string[]): Record<string, unknown> {
  return sampleSpec({
    agentId,
    tools: [{ toolId: 'task-delegate', riskLevel: 'L3', controlledFields: { targetWhitelist: whitelist } }],
    extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
  });
}

const delegateArgs = (agentId: string, extra: Record<string, unknown> = {}) => ({ agentId, input: validInput, note: '委托说明', ...extra });

/** 直插一行 task_record（合成锚定重入/链上溯现场） */
function insertTask(rt: Runtime, taskId: string, agentId: string, opts: { status?: string; parentTaskId?: string | null; depth?: number } = {}): void {
  dbOf(rt)
    .prepare(`INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, createdAt, traceFile, delegationDepth, parentTaskId) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(taskId, agentId, 'v1', 'h1', '{}', opts.status ?? 'paused', new Date().toISOString(), `traces/${taskId}.jsonl`, opts.depth ?? 0, opts.parentTaskId ?? null);
}

describe('委托灰度分派（215-217：resolveAgent canary 路径）', () => {
  it('子 agent 配 canary（weight=100）→ 委托子任务 agentVersionId=canary 版、assignmentSource=canary（trace 留痕）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('canary-child') }] },
      { kind: 'text', text: validJson }, // 子（canary 版）终答
      { kind: 'text', text: validJson }, // 父收摘要后终答
    ], process.cwd(), { dispatchRoll: () => 0 }); // roll=0 < 100 → 必中 canary
    registerAndRelease(h.rt, delegateParentSpec('canary-parent', ['canary-child']));
    const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'canary-child' }), 't', validationDepsOf(h.rt));
    h.rt.registry.release('canary-child', v1, 't');
    const v2Spec = sampleSpec({ agentId: 'canary-child', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 't', validationDepsOf(h.rt));
    h.rt.registry.release('canary-child', v2, 't', { noPointer: true });
    h.rt.registry.canarySet('canary-child', v2, 100, 't');

    const parentTaskId = h.rt.tasks.createTask('canary-parent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');

    const childRow = dbOf(h.rt).prepare('SELECT taskId, agentVersionId, assignmentSource FROM task_record WHERE parentTaskId = ?').get(parentTaskId) as { taskId: string; agentVersionId: string; assignmentSource: string };
    expect(childRow.agentVersionId).toBe(v2); // 灰度指针命中（非 current v1）
    expect(childRow.assignmentSource).toBe('canary'); // 分派来源留痕（A5 §4a）
    const created = eventsOf(h.rt, childRow.taskId).find((e) => e.eventType === 'task_created') as unknown as { assignmentSource: string };
    expect(created.assignmentSource).toBe('canary');
  });

  it('canary 活跃但 roll ≥ weight → stable 分派（边界严格：<）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('stable-child') }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ], process.cwd(), { dispatchRoll: () => 100 }); // roll=100 ≮ weight=100 → stable
    registerAndRelease(h.rt, delegateParentSpec('stable-parent', ['stable-child']));
    const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'stable-child' }), 't', validationDepsOf(h.rt));
    h.rt.registry.release('stable-child', v1, 't');
    const v2Spec = sampleSpec({ agentId: 'stable-child', modelPolicy: { maxModelCalls: 12, maxTokens: 100000 } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 't', validationDepsOf(h.rt));
    h.rt.registry.release('stable-child', v2, 't', { noPointer: true });
    h.rt.registry.canarySet('stable-child', v2, 100, 't');

    const parentTaskId = h.rt.tasks.createTask('stable-parent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');
    const childRow = dbOf(h.rt).prepare('SELECT agentVersionId, assignmentSource FROM task_record WHERE parentTaskId = ?').get(parentTaskId) as { agentVersionId: string; assignmentSource: string };
    expect(childRow.agentVersionId).toBe(v1); // current 指针
    expect(childRow.assignmentSource).toBe('stable');
  });
});

describe('委托参数缺省分支（102-103 / 147-148）', () => {
  it('args 无 input → 子任务 input=null（?? null）；args 无 note → task_delegated.note=null', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: { agentId: 'minimal-child' } }] }, // input/note 均缺省
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, delegateParentSpec('minimal-parent', ['minimal-child']));
    // 子 inputContract 要求 topic → 子 Created→Failed(Input(contract_mismatch))，父收失败摘要后 Succeeded
    registerAndRelease(h.rt, sampleSpec({ agentId: 'minimal-child' }));
    const parentTaskId = h.rt.tasks.createTask('minimal-parent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');

    const childRow = dbOf(h.rt).prepare('SELECT taskId, input, status FROM task_record WHERE parentTaskId = ?').get(parentTaskId) as { taskId: string; input: string; status: string };
    expect(childRow.input).toBe('null'); // ?? null 落库（JSON 序列化形态）
    expect(childRow.status).toBe('failed'); // inputContract 不合（topic 缺失）
    const delegated = eventsOf(h.rt, parentTaskId).find((e) => e.eventType === 'task_delegated') as unknown as { note: unknown };
    expect(delegated.note).toBeNull(); // note 缺省 → null 留痕
  });
});

describe('govern 边界（65 / 73 分支）', () => {
  it('args.agentId 缺省 → 空串不构成环路；parentTaskId 指向缺失行 → 上溯 break 后放行（深度 0）', () => {
    const h = makeHarness([]);
    insertTask(h.rt, 'g-root', 'a-agent', { depth: 0 });
    // agentId 缺省：chain（['a-agent']）不含 '' → 环路不命中；深度 0 放行
    expect(governDelegationStatic(dbOf(h.rt), {}, { parentTaskId: 'g-root', delegationDepth: 0 })).toBeNull();
    // 链上溯遇缺失行：parentTaskId 指向不存在任务 → break → chain 为空 → 放行
    expect(governDelegationStatic(dbOf(h.rt), { agentId: 'a-agent' }, { parentTaskId: 'ghost-parent', delegationDepth: 0 })).toBeNull();
  });
});

describe('Delegation 直驱边界（113 / 189 / 235 / 240）', () => {
  it('锚定重入：childTaskId 无行 → DelegationWaitSignal（「缺失」）', async () => {
    const h = makeHarness([]);
    const task = { parentTaskId: 'anchor-parent', delegationDepth: 0, isParentCancelRequested: () => false };
    let captured: unknown = null;
    try {
      await h.rt.delegation.execute({ agentId: 'c', input: validInput }, task, { callNo: 1, anchorChildTaskId: 'ghost-child' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(DelegationWaitSignal);
    expect((captured as DelegationWaitSignal).message).toContain('缺失'); // 行缺失态（235：getTaskRow → null）
    expect((captured as DelegationWaitSignal).childTaskId).toBe('ghost-child');
  });

  it('锚定重入：子行 succeeded 但 trace 无 task_succeeded 输出 → 摘要 output/outputDigest 均 null（189 fallback）', async () => {
    const h = makeHarness([]);
    insertTask(h.rt, 'sum-parent', 'p-agent', { status: 'paused' });
    insertTask(h.rt, 'sum-child-ok', 'c-agent', { status: 'succeeded', parentTaskId: 'sum-parent', depth: 1 });
    const task = { parentTaskId: 'sum-parent', delegationDepth: 0, isParentCancelRequested: () => false };
    const summary = (await h.rt.delegation.execute(
      { agentId: 'c', input: validInput }, task, { callNo: 1, anchorChildTaskId: 'sum-child-ok' },
    )) as Record<string, unknown>;
    expect(summary.taskId).toBe('sum-child-ok');
    expect(summary.status).toBe('succeeded');
    expect(summary.output).toBeNull(); // 无 task_succeeded 事件可读 → null
    expect(summary.outputDigest).toBeNull(); // output=null → digest=null
    // 父 Trace 收到 task_delegation_completed（outputDigest=null）
    const completed = eventsOf(h.rt, 'sum-parent').find((e) => e.eventType === 'task_delegation_completed') as unknown as { outputDigest: unknown };
    expect(completed.outputDigest).toBeNull();
  });

  it('父任务行缺失 → baseOf 结构化报错（240；子行已先持久化——先持久化后继续不变式）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'orphan-child' })); // resolveAgent 可解析
    const task = { parentTaskId: 'ghost-parent-2', delegationDepth: 0, isParentCancelRequested: () => false };
    await expect(
      h.rt.delegation.execute({ agentId: 'orphan-child', input: validInput }, task, { callNo: 1 }),
    ).rejects.toThrow('委托父任务不存在');
    // 子行已落库（INSERT 先于 baseOf）——合成现场下的先持久化次序旁证
    const orphan = dbOf(h.rt).prepare(`SELECT COUNT(*) AS c FROM task_record WHERE parentTaskId = 'ghost-parent-2'`).get() as { c: number };
    expect(orphan.c).toBe(1);
  });
});
