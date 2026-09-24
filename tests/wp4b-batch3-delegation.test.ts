import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, registerL3Tool, type Harness } from './helpers.js';
import { ToolExecutor, type ToolExecutorOptions } from '../src/modules/toolExecutor.js';
import { DelegationWaitSignal, DELEGATE_TOOL_ID } from '../src/modules/toolExecutor.js';
import { DELEGATION_DEPTH_LIMIT, governDelegationStatic } from '../src/runtime/delegation.js';
import { ENVREF_PLACEHOLDER } from '../src/mcp/client.js';

// WP-4B 批次三（§4.4 鲲鹏委托最小形态）：A-19 / A-20 验收断言 + R-1/R-2/风暴封闭句行为面 + P3-1′ 正则收敛。

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function snapshotRow(rt: Runtime, taskId: string): { contextJson: string; nextCallRef: string } | undefined {
  return dbOf(rt).prepare('SELECT * FROM pause_snapshot WHERE taskId = ?').get(taskId) as { contextJson: string; nextCallRef: string } | undefined;
}

function eventsOf(rt: Runtime, taskId: string) {
  return rt.trace.readEvents(taskId);
}

function typesOf(rt: Runtime, taskId: string): string[] {
  return eventsOf(rt, taskId).map((e) => e.eventType);
}

function childrenOf(rt: Runtime, parentTaskId: string): { taskId: string; status: string; delegationDepth: number; agentId: string }[] {
  return dbOf(rt)
    .prepare('SELECT taskId, status, delegationDepth, agentId FROM task_record WHERE parentTaskId = ? ORDER BY createdAt')
    .all(parentTaskId) as { taskId: string; status: string; delegationDepth: number; agentId: string }[];
}

/** 委托父 Spec：声明 task-delegate（L3 + targetWhitelist）+ onHighRisk */
function delegateParentSpec(agentId: string, whitelist: string[]): Record<string, unknown> {
  return sampleSpec({
    agentId,
    tools: [{ toolId: 'task-delegate', riskLevel: 'L3', controlledFields: { targetWhitelist: whitelist } }],
    extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
  });
}

/** 委托子 Spec：含 L3 工具（子级第二段审批用） */
function childWithL3Spec(agentId: string): Record<string, unknown> {
  return sampleSpec({
    agentId,
    tools: [{ toolId: 'l3-op', riskLevel: 'L3' }],
    extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
  });
}

const delegateArgs = (agentId: string, input: unknown = validInput, note = '委托说明') => ({ agentId, input, note });

/** 驱动到「委托审批挂起」（第一次人工介入）：父模型请求 task-delegate → Paused */
async function driveToDelegationPause(h: Harness, parentAgent = 'parent-agent', childAgent = 'child-agent') {
  registerL3Tool(h);
  registerAndRelease(h.rt, delegateParentSpec(parentAgent, [childAgent]));
  registerAndRelease(h.rt, childWithL3Spec(childAgent));
  const parentTaskId = h.rt.tasks.createTask(parentAgent, validInput, 't');
  const row = await h.rt.tasks.runTask(parentTaskId);
  expect(row.status).toBe('paused');
  const request = h.rt.approvals.pendingForTask(parentTaskId)!;
  expect(request).not.toBeNull();
  expect(request.toolId).toBe('task-delegate');
  return { parentTaskId, request, childAgent };
}

/** 驱动到「委托等待挂起」（子因自身 L3 挂起 → 信号上浮 → 父在委托边界 Paused，快照含 childTaskId 锚） */
async function driveToDelegationWait(h: Harness) {
  const ctx = await driveToDelegationPause(h);
  h.rt.approvals.approve(ctx.request.requestId, 'human');
  const row = await h.rt.tasks.runTask(ctx.parentTaskId, null, { resume: true });
  expect(row.status).toBe('paused');
  const children = childrenOf(h.rt, ctx.parentTaskId);
  expect(children).toHaveLength(1);
  const childTaskId = children[0].taskId;
  expect(children[0].status).toBe('paused'); // 子因自身 L3 挂起（先持久化，R-2 写序）
  const childRequest = h.rt.approvals.pendingForTask(childTaskId)!;
  expect(childRequest).not.toBeNull();
  expect(childRequest.toolId).toBe('l3-op');
  expect(h.rt.approvals.pendingForTask(ctx.parentTaskId)).toBeNull(); // 第二次人工介入挂子 taskId，父无新请求
  return { ...ctx, childTaskId, childRequest };
}

describe('A-19 委托端到端（两段审批全链 + resume 先子后父）', () => {
  it('父审批 → 子创建（parentTaskId/delegationDepth）→ 子级 L3 信号上浮 → 先子后父 resume → 幂等重入返回摘要 → 双双终态；T1 各自成立', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId, childRequest } = await driveToDelegationWait(h);

    // 父 Trace 序列（F-11）：task_paused → approval_decided → task_resumed → task_delegated → task_paused(childTaskId) → …
    const pTypes = typesOf(h.rt, parentTaskId);
    for (const evt of ['task_paused', 'approval_decided', 'task_resumed', 'task_delegated', 'task_paused']) {
      expect(pTypes).toContain(evt);
    }
    expect(pTypes.indexOf('task_delegated')).toBeGreaterThan(pTypes.indexOf('task_resumed'));
    const secondPause = eventsOf(h.rt, parentTaskId).filter((e) => e.eventType === 'task_paused')[1] as unknown as { childTaskId?: string };
    expect(secondPause.childTaskId).toBe(childTaskId); // 快照/事件载荷含 childTaskId（幂等重入锚）
    // 父快照载荷含 childTaskId（幂等重入锚）
    const snap = snapshotRow(h.rt, parentTaskId);
    const delegationPayload = JSON.parse(snap!.contextJson).delegation as { childTaskId: string; note?: string };
    expect(delegationPayload.childTaskId).toBe(childTaskId);

    // 先子后父（规范时序）：approve 子 → resume 子至终态
    h.rt.approvals.approve(childRequest.requestId, 'human');
    const childFinal = await h.rt.tasks.runTask(childTaskId, null, { resume: true, resumedBy: 'manual-resume' });
    expect(childFinal.status).toBe('succeeded');
    const childModelCallsBefore = childFinal.modelCallCount;

    // resume 父 → impl 幂等重入：childTaskId 已终态 → 返回子终态摘要（不重建子任务）
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');
    expect(childrenOf(h.rt, parentTaskId)).toHaveLength(1); // 未重建
    expect(h.rt.tasks.getTask(childTaskId).modelCallCount).toBe(childModelCallsBefore); // 子未重复执行

    // 交接事件：task_delegated / task_delegation_completed（父 Trace）
    expect(typesOf(h.rt, parentTaskId)).toContain('task_delegation_completed');
    const completed = eventsOf(h.rt, parentTaskId).find((e) => e.eventType === 'task_delegation_completed') as unknown as Record<string, unknown>;
    expect(completed.childTaskId).toBe(childTaskId);
    expect(completed.status).toBe('succeeded');

    // 摘要返回父模型：{taskId,status,outputDigest,output}
    const lastParentCall = h.provider.receivedCalls[h.provider.receivedCalls.length - 1];
    const toolResults = (lastParentCall.messages as { role: string; results?: { content: unknown }[] }[]).find((m) => m.role === 'tool_results');
    const summary = toolResults?.results?.[0]?.content as Record<string, unknown>;
    expect(summary.taskId).toBe(childTaskId);
    expect(summary.status).toBe('succeeded');
    expect(summary.outputDigest).toBeTruthy();
    expect(summary.output).toEqual(validOutput());

    // 子任务治理元数据
    const childRow = h.rt.tasks.getTask(childTaskId);
    expect((childRow as unknown as { parentTaskId: string | null }).parentTaskId).toBe(parentTaskId);
    expect((childRow as unknown as { delegationDepth: number }).delegationDepth).toBe(1);

    // T1：父子 Trace 各自独立完整，版本绑定各自成立
    const parentEvents = eventsOf(h.rt, parentTaskId);
    const childEvents = eventsOf(h.rt, childTaskId);
    expect(parentEvents.length).toBeGreaterThan(0);
    expect(childEvents.length).toBeGreaterThan(0);
    expect(parentEvents.every((e) => e.agentId === 'parent-agent')).toBe(true);
    expect(childEvents.every((e) => e.agentId === 'child-agent')).toBe(true);
    expect(childEvents[0].eventType).toBe('task_created');
    expect(childEvents[childEvents.length - 1].eventType).toBe('task_succeeded');
  });
});

describe('A-20 委托治理与委托原语类别属性', () => {
  it('① agentId 越白名单 → target_not_whitelisted（等级无关：L3 审批前拦截，不挂起）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['other-agent']));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'child-agent' }));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');
    const row = await h.rt.tasks.runTask(parentTaskId);
    // 白名单拒绝发生在 L3 审批分支之前（闸门顺序修订：等级无关步骤）——不产生 ApprovalRequest
    expect(row.status).toBe('succeeded');
    expect(h.rt.approvals.pendingForTask(parentTaskId)).toBeNull();
    const denied = eventsOf(h.rt, parentTaskId).find((e) => e.eventType === 'policy_denied') as unknown as Record<string, unknown>;
    expect(denied.reasonCode).toBe('target_not_whitelisted');
    expect(childrenOf(h.rt, parentTaskId)).toHaveLength(0);
  });

  it('② 深度超限 → 运行期调用点拦截（delegation_depth），不创建孙任务、不触发子级审批', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('b-agent') }] },
      { kind: 'tool_use', calls: [{ id: 'g1', toolId: 'task-delegate', args: delegateArgs('c-agent') }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, delegateParentSpec('a-agent', ['b-agent']));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'c-agent' }));
    registerAndRelease(h.rt, delegateParentSpec('b-agent', ['c-agent'])); // 子声明 task-delegate：注册放行
    const parentTaskId = h.rt.tasks.createTask('a-agent', validInput, 't');
    const paused = await h.rt.tasks.runTask(parentTaskId);
    expect(paused.status).toBe('paused');
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const finalRow = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(finalRow.status).toBe('succeeded');

    const children = childrenOf(h.rt, parentTaskId);
    expect(children).toHaveLength(1); // 仅一层委托（b），孙任务零创建
    const childTaskId = children[0].taskId;
    expect(childrenOf(h.rt, childTaskId)).toHaveLength(0);
    // 子 Trace：孙委托请求被 policy_denied（risk_level_blocked，reason=delegation_depth），未触发子级审批挂起
    const childEvents = eventsOf(h.rt, childTaskId);
    const denied = childEvents.find((e) => e.eventType === 'policy_denied') as unknown as Record<string, unknown>;
    expect(denied.reasonCode).toBe('risk_level_blocked');
    expect(String(denied.message)).toContain('delegation_depth');
    expect(childEvents.filter((e) => e.eventType === 'approval_requested')).toHaveLength(0);
  });

  it('② 环路禁止 → delegation_cycle（govern 单元：沿 parentTaskId 上溯校验，A→B→A）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, delegateParentSpec('a-agent', ['b-agent']));
    registerAndRelease(h.rt, delegateParentSpec('b-agent', ['a-agent']));
    // 构造委托链：taskA(a, 根) ← taskB(b, depth 1)
    const insert = (taskId: string, agentId: string, parentTaskId: string | null, depth: number) =>
      dbOf(h.rt)
        .prepare(`INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, createdAt, traceFile, delegationDepth, parentTaskId) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(taskId, agentId, 'v1', 'h1', '{}', 'paused', new Date().toISOString(), `traces/${taskId}.jsonl`, depth, parentTaskId);
    insert('task-a', 'a-agent', null, 0);
    insert('task-b', 'b-agent', 'task-a', 1);

    // 环路：B（链上已含 a-agent）请求委托 a-agent → 拒绝
    const cycle = governDelegationStatic(dbOf(h.rt), { agentId: 'a-agent' }, { parentTaskId: 'task-b', delegationDepth: 1 });
    expect(cycle?.reasonCode).toBe('risk_level_blocked');
    expect(String(cycle?.message)).toContain('delegation_cycle');
    // 深度：B（depth 1）请求全新 agent → 深度超限（默认上限 1）
    registerAndRelease(h.rt, sampleSpec({ agentId: 'c-agent' }));
    const depth = governDelegationStatic(dbOf(h.rt), { agentId: 'c-agent' }, { parentTaskId: 'task-b', delegationDepth: 1 });
    expect(depth?.reasonCode).toBe('risk_level_blocked');
    expect(String(depth?.message)).toContain('delegation_depth');
    expect(DELEGATION_DEPTH_LIMIT).toBe(1);
  });

  it('③ 超时豁免 + 禁重试（unit：ToolExecutor 委托原语特殊类别——impl 超 toolTimeoutMs 不杀、失败 attempt=1 不重试）', async () => {
    const h = makeHarness([]);
    const base = { taskId: 'unit-delegate', agentId: 'x', agentVersionId: 'v1', specContentHash: 'h1' };
    let implCalls = 0;
    let resolveImpl: ((v: unknown) => void) | null = null;
    const primitive = {
      govern: () => null,
      execute: () => {
        implCalls += 1;
        return new Promise((resolve) => { resolveImpl = resolve; });
      },
    };
    const opts: ToolExecutorOptions = {
      base, trace: h.rt.trace,
      getTool: () => ({ riskLevel: 'L3', status: 'active', implVersion: '0.2.0' }),
      impls: new Map(),
      declared: [{ toolId: 'task-delegate', riskLevel: 'L3' }],
      maxConsecutiveDenials: 2, maxAttempts: 3, toolTimeoutMs: 50,
      getDenialCount: () => 0, setDenialCount: () => {}, approvalMode: 'onHighRisk',
      delegation: { primitive, anchorChildTaskId: undefined },
    };
    const exec = new ToolExecutor(opts);
    const p = exec.execute(1, 'task-delegate', { agentId: 'y', input: {} }, '1');
    await new Promise((r) => setTimeout(r, 120)); // > toolTimeoutMs(50)：委托原语超时豁免
    expect(implCalls).toBe(1);
    resolveImpl?.({ ok: true });
    const out = await p;
    expect(out.outcome).toBe('ok'); // 未被 50ms 超时杀掉（超时豁免，§4.4）

    // 禁重试：impl 失败 → attempt=1 即终局（无第二次 impl 调用）
    let failCalls = 0;
    const failing = {
      govern: () => null,
      execute: () => { failCalls += 1; throw new Error('子任务派发失败'); },
    };
    const exec2 = new ToolExecutor({ ...opts, delegation: { primitive: failing } });
    await expect(exec2.execute(2, 'task-delegate', { agentId: 'y', input: {} }, '2')).rejects.toMatchObject({ name: 'ToolTerminalFailure' });
    expect(failCalls).toBe(1);
    const attempts = eventsOf(h.rt, 'unit-delegate').filter((e) => e.eventType === 'attempt_started' && e.callNo === 2);
    expect(attempts).toHaveLength(1); // 禁重试：单次 attempt
    const failed = eventsOf(h.rt, 'unit-delegate').filter((e) => e.eventType === 'attempt_failed' && e.callNo === 2) as unknown as { willRetry: boolean }[];
    expect(failed).toHaveLength(1);
    expect(failed[0].willRetry).toBe(false);
  });

  it('③ 信号上浮：子挂起信号不被归因 Tool(execution_failed)（unit：DelegationWaitSignal 原样上浮）', async () => {
    const h = makeHarness([]);
    const base = { taskId: 'unit-float', agentId: 'x', agentVersionId: 'v1', specContentHash: 'h1' };
    const primitive = {
      govern: () => null,
      execute: () => { throw new DelegationWaitSignal('child-1', '子任务未终态'); },
    };
    const exec = new ToolExecutor({
      base, trace: h.rt.trace,
      getTool: () => ({ riskLevel: 'L3', status: 'active', implVersion: '0.2.0' }),
      impls: new Map(),
      declared: [{ toolId: 'task-delegate', riskLevel: 'L3' }],
      maxConsecutiveDenials: 2, maxAttempts: 3, toolTimeoutMs: 30000,
      getDenialCount: () => 0, setDenialCount: () => {}, approvalMode: 'onHighRisk',
      delegation: { primitive },
    });
    // R-1 分类表：子挂起 → 上浮（不进 attempt 异常归类、不重试、不产生 attempt_failed）
    await expect(exec.execute(1, 'task-delegate', { agentId: 'y', input: {} }, '1')).rejects.toBeInstanceOf(DelegationWaitSignal);
    expect(eventsOf(h.rt, 'unit-float').filter((e) => e.eventType === 'attempt_failed')).toHaveLength(0);
  });

  it('③ agentId 无 Released 指针 → 结构化拒绝（工具失败归因、attempt=1、零子任务）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('ghost-agent') }] },
    ]);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['ghost-agent']));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');
    const paused = await h.rt.tasks.runTask(parentTaskId);
    expect(paused.status).toBe('paused');
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const finalRow = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(finalRow.status).toBe('failed');
    expect(finalRow.terminalFailureClass).toBe('Tool(execution_failed)');
    expect(childrenOf(h.rt, parentTaskId)).toHaveLength(0); // 子任务未创建（F-12-①）
    const attempts = eventsOf(h.rt, parentTaskId).filter((e) => e.eventType === 'attempt_started' && e.callKind === 'tool');
    expect(attempts).toHaveLength(1); // 委托原语 attempt=1（禁重试——模型调用 attempt 不计）
  });

  it('④ 乱序容错：子仍 Paused 时 resume 父 → 父保持 Paused + 结构化提示（幂等可重复；子不受扰动）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId, childRequest } = await driveToDelegationWait(h);
    const childModelCalls = h.rt.tasks.getTask(childTaskId).modelCallCount;

    // 乱序 resume 父（子仍 Paused）：父保持 Paused + 提示，可重复
    for (let i = 0; i < 2; i++) {
      const row = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
      expect(row.status).toBe('paused');
      const pauses = eventsOf(h.rt, parentTaskId).filter((e) => e.eventType === 'task_paused') as unknown as { reason: string; childTaskId?: string; note?: string }[];
      const last = pauses[pauses.length - 1];
      expect(last.reason).toBe('delegation_child_wait');
      expect(last.childTaskId).toBe(childTaskId);
      expect(last.note).toContain('先处置子任务');
      expect(snapshotRow(h.rt, parentTaskId)).toBeTruthy();
    }
    expect(h.rt.tasks.getTask(childTaskId).modelCallCount).toBe(childModelCalls); // 子未受扰动
    expect(h.rt.approvals.pendingForTask(parentTaskId)).toBeNull(); // 不产生新父级审批

    // 规范时序补齐 → 双双终态
    h.rt.approvals.approve(childRequest.requestId, 'human');
    expect((await h.rt.tasks.runTask(childTaskId, null, { resume: true })).status).toBe('succeeded');
    expect((await h.rt.tasks.runTask(parentTaskId, null, { resume: true })).status).toBe('succeeded');
  });

  it('⑤ 父 graceful cancel 线程化：嵌套执行中 → 子 Cancelled(superseded) + 父 Cancelled(user)', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'delay', ms: 400 },
      { kind: 'text', text: validJson },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['child-agent']));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'child-agent' }));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');

    const resumed = h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    await new Promise((r) => setTimeout(r, 120)); // 子循环进入在飞原子调用（delay 400ms）
    const cancelResult = h.rt.tasks.cancel(parentTaskId, 'tester');
    expect(cancelResult.mode).toBe('graceful');
    const parentFinal = await resumed;
    expect(parentFinal.status).toBe('cancelled');
    expect(parentFinal.cancelReason).toBe('user');
    const children = childrenOf(h.rt, parentTaskId);
    expect(children).toHaveLength(1);
    const childRow = h.rt.tasks.getTask(children[0].taskId);
    expect(childRow.status).toBe('cancelled');
    expect(childRow.cancelReason).toBe('superseded'); // P2-2：子循环原子调用边界代查父取消 → superseded
  });

  it('⑤ 父跨进程 abort（abortRequested 持久化标志）：子 superseded + 父 Cancelled(abort)', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'delay', ms: 400 },
      { kind: 'text', text: validJson },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['child-agent']));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'child-agent' }));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');

    const resumed = h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    await new Promise((r) => setTimeout(r, 120));
    // 模拟另一进程 force-cancel：直接置 abortRequested 持久化标志
    dbOf(h.rt).prepare('UPDATE task_record SET abortRequested = 1 WHERE taskId = ?').run(parentTaskId);
    const parentFinal = await resumed;
    expect(parentFinal.status).toBe('cancelled');
    expect(parentFinal.cancelReason).toBe('abort');
    const children = childrenOf(h.rt, parentTaskId);
    expect(h.rt.tasks.getTask(children[0].taskId).cancelReason).toBe('superseded');
  });

  it('⑥ 崩溃窗口①（父 snapshot 写前）：父/子双 Running → 恢复扫描双双 CrashRecovery（零新机制）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['child-agent']));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');
    const childTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't'); // 合成：子行
    dbOf(h.rt).prepare(`UPDATE task_record SET status='running', parentTaskId=?, delegationDepth=1 WHERE taskId=?`).run(parentTaskId, childTaskId);
    dbOf(h.rt).prepare(`UPDATE task_record SET status='running' WHERE taskId=?`).run(parentTaskId);
    const report = h.rt.state.recover();
    expect(report.crashMarkedTasks.sort()).toEqual([childTaskId, parentTaskId].sort());
    expect(h.rt.tasks.getTask(parentTaskId).terminalFailureClass).toBe('Runtime(CrashRecovery)');
    expect(h.rt.tasks.getTask(childTaskId).terminalFailureClass).toBe('Runtime(CrashRecovery)');
  });

  it('⑥ 崩溃窗口②（父 snapshot 写后、子循环随父进程退出）：子被扫描终局、父保持 Paused → resume 父幂等重入返回失败摘要，父模型自行决策', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson }, // 窗口② 子不会跑到这里（被扫描终局）
      { kind: 'text', text: validJson }, // 父收到失败摘要后自行决策输出
    ]);
    const { parentTaskId, childTaskId, childRequest } = await driveToDelegationWait(h);
    // 合成窗口②可达态（docs/phase4/03 矩阵②行）：操作者已 resume 子（独立进程跑子循环）、
    // 该进程在飞时崩溃——现场 = 子 Running、父 Paused（快照含锚）。SQL 合成等价现场验证重入语义。
    dbOf(h.rt).prepare(`UPDATE task_record SET status='running' WHERE taskId=?`).run(childTaskId);
    dbOf(h.rt).prepare(`DELETE FROM pause_snapshot WHERE taskId=?`).run(childTaskId);
    dbOf(h.rt).prepare(`UPDATE approval_request SET decision='superseded' WHERE requestId=?`).run(childRequest.requestId);

    const report = h.rt.state.recover();
    expect(report.crashMarkedTasks).toContain(childTaskId);
    expect(h.rt.tasks.getTask(childTaskId).terminalFailureClass).toBe('Runtime(CrashRecovery)');
    expect(h.rt.tasks.getTask(parentTaskId).status).toBe('paused'); // 父保持 Paused（合法长驻）
    expect(snapshotRow(h.rt, parentTaskId)).toBeTruthy();

    // resume 父 → 幂等重入：子已终局 → 返回失败摘要（不重建、不重试）
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded'); // 父模型收到失败摘要后自行决策（不自动传播失败）
    const lastCall = h.provider.receivedCalls[h.provider.receivedCalls.length - 1];
    const toolResults = (lastCall.messages as { role: string; results?: { content: unknown }[] }[]).find((m) => m.role === 'tool_results');
    const summary = toolResults?.results?.[0]?.content as Record<string, unknown>;
    expect(summary.taskId).toBe(childTaskId);
    expect(summary.status).toBe('failed');
    expect(childrenOf(h.rt, parentTaskId)).toHaveLength(1);
  });

  it('⑦ 子失败不自动传播：子 Failed(Model) → 父收失败摘要 → 父自行决策 Succeeded', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'text', text: '不是合法 JSON' },
      { kind: 'text', text: '仍然不是合法 JSON' },
      { kind: 'text', text: '还是不是合法 JSON' },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['child-agent']));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'child-agent' }));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');
    const children = childrenOf(h.rt, parentTaskId);
    expect(h.rt.tasks.getTask(children[0].taskId).status).toBe('failed');
    const completed = eventsOf(h.rt, parentTaskId).find((e) => e.eventType === 'task_delegation_completed') as unknown as Record<string, unknown>;
    expect(completed.status).toBe('failed');
    const lastCall = h.provider.receivedCalls[h.provider.receivedCalls.length - 1];
    const toolResults = (lastCall.messages as { role: string; results?: { content: unknown }[] }[]).find((m) => m.role === 'tool_results');
    expect((toolResults?.results?.[0]?.content as Record<string, unknown>).status).toBe('failed');
  });

  it('F-12-② 子 inputContract 不合 → 子 Created→Failed（落库后审计边界），父收失败摘要后 Succeeded', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: { agentId: 'child-agent', input: { foo: 'bar' }, note: 'n' } }] },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['child-agent']));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'child-agent' }));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');
    const children = childrenOf(h.rt, parentTaskId);
    expect(children).toHaveLength(1); // 子任务已创建（非落库前 RejectedRequest）
    const childRow = h.rt.tasks.getTask(children[0].taskId);
    expect(childRow.status).toBe('failed');
    expect(childRow.terminalFailureClass).toBe('Input(contract_mismatch)');
  });

  it('F-13-③ 同一父任务多次委托（不同 approve）→ 各自独立子任务，无共享状态', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'text', text: validJson },
      { kind: 'tool_use', calls: [{ id: 'd2', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, delegateParentSpec('parent-agent', ['child-agent']));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'child-agent' }));
    const parentTaskId = h.rt.tasks.createTask('parent-agent', validInput, 't');

    // 第一次委托
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const mid = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(mid.status).toBe('paused'); // 第二次委托请求挂起
    const children1 = childrenOf(h.rt, parentTaskId);
    expect(children1).toHaveLength(1);
    expect(children1[0].status).toBe('succeeded');

    // 第二次委托（不同 approve、不同子任务）
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const finalRow = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(finalRow.status).toBe('succeeded');
    const children = childrenOf(h.rt, parentTaskId);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((c) => c.taskId)).size).toBe(2);
    expect(children.every((c) => c.delegationDepth === 1)).toBe(true);
    expect(typesOf(h.rt, parentTaskId).filter((t) => t === 'task_delegated')).toHaveLength(2);
    expect(typesOf(h.rt, parentTaskId).filter((t) => t === 'task_delegation_completed')).toHaveLength(2);
  });

  it('F-13-② 父在委托等待挂起中被 cancel → 父终局 + 子 superseded + 双方快照/审批清理', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId, childRequest } = await driveToDelegationWait(h);
    const result = h.rt.tasks.cancel(parentTaskId, 'tester');
    expect(result.note).toContain('Paused');
    expect(h.rt.tasks.getTask(parentTaskId).status).toBe('cancelled');
    const childRow = h.rt.tasks.getTask(childTaskId);
    expect(childRow.status).toBe('cancelled');
    expect(childRow.cancelReason).toBe('superseded'); // 孤儿处置：取消传播覆盖
    expect(h.rt.approvals.getRequest(childRequest.requestId)?.decision).toBe('superseded');
    expect(snapshotRow(h.rt, childTaskId)).toBeUndefined();
    expect(snapshotRow(h.rt, parentTaskId)).toBeUndefined();
  });

  it('F-13-② 子任务单独 cancel 不影响父：父从返回摘要感知，自行决策至终态', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs('child-agent') }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { parentTaskId, childTaskId } = await driveToDelegationWait(h);
    h.rt.tasks.cancel(childTaskId, 'tester');
    expect(h.rt.tasks.getTask(childTaskId).status).toBe('cancelled');
    expect(h.rt.tasks.getTask(parentTaskId).status).toBe('paused'); // 父不受影响
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');
    const lastCall = h.provider.receivedCalls[h.provider.receivedCalls.length - 1];
    const toolResults = (lastCall.messages as { role: string; results?: { content: unknown }[] }[]).find((m) => m.role === 'tool_results');
    expect((toolResults?.results?.[0]?.content as Record<string, unknown>).status).toBe('cancelled');
  });
});

describe('批次三登记与闸门（登记面 + 等级无关白名单回归）', () => {
  it('task-delegate 登记缺省 L3 builtin；声明它而无 approvalPolicy → Spec 注册即拒（D-8）', () => {
    const h = makeHarness([]);
    const entry = h.rt.registry.getTool('task-delegate');
    expect(entry).not.toBeNull();
    expect((entry as unknown as { riskLevel: string }).riskLevel).toBe('L3');
    expect((entry as unknown as { kind: string }).kind).toBe('builtin');
    expect((entry as unknown as { status: string }).status).toBe('active');
    expect(DELEGATE_TOOL_ID).toBe('task-delegate');

    const badSpec = sampleSpec({
      agentId: 'no-approval-parent',
      tools: [{ toolId: 'task-delegate', riskLevel: 'L3', controlledFields: { targetWhitelist: ['child-agent'] } }],
    });
    let issues: { path: string; message: string }[] = [];
    try {
      h.rt.registry.registerSpec(badSpec, 't', {
        getTool: (id) => {
          const t = h.rt.registry.getTool(id);
          return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null;
        },
        modelWhitelist: h.rt.gateway.modelWhitelist,
      });
    } catch (err) {
      issues = (err as { issues?: { path: string; message: string }[] }).issues ?? [];
    }
    expect(issues.some((i) => i.message.includes('onHighRisk'))).toBe(true); // D-8：L3 声明无审批路径 → 注册即拒
  });

  it('闸门白名单等级无关化：既有 L2 字面 target 检查零变更；非 L2 声明白名单亦生效', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'w1', toolId: 'l2-op', args: { target: 'bad-target' } }] },
      { kind: 'text', text: validJson },
    ]);
    // L2 工具 + 字面 target 白名单（既有语义，行为零变更）
    h.rt.registry.registerTool(
      { toolId: 'l2-op', name: 'l2-op', kind: 'builtin', riskLevel: 'L2', implVersion: '0.1.0',
        paramSchema: '{}', controlledFieldsSchema: null, status: 'active' },
      't',
    );
    h.rt.toolImpls.set('l2-op', () => ({ ok: true }));
    registerAndRelease(h.rt, sampleSpec({
      agentId: 'l2-parent',
      tools: [{ toolId: 'l2-op', riskLevel: 'L2', controlledFields: { targetWhitelist: ['good-target'] } }],
    }));
    const taskId = h.rt.tasks.createTask('l2-parent', validInput, 't');
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded');
    const denied = eventsOf(h.rt, taskId).find((e) => e.eventType === 'policy_denied') as unknown as Record<string, unknown>;
    expect(denied.reasonCode).toBe('target_not_whitelisted'); // L2 字面 target 检查仍在（回归断言）
    expect(denied.toolId).toBe('l2-op');
  });
});

describe('P3-1′ envRefs 占位正则收敛单一导出', () => {
  it('client.ts 单一导出，releaseScan 与测试消费同一源（结构 + 行为）', () => {
    // 行为：占位形态判定
    expect(ENVREF_PLACEHOLDER.test('${MY_VAR}')).toBe(true);
    expect(ENVREF_PLACEHOLDER.test('${A_1}')).toBe(true);
    expect(ENVREF_PLACEHOLDER.test('literal-secret')).toBe(false);
    expect(ENVREF_PLACEHOLDER.test('${1BAD}')).toBe(false);
    expect(ENVREF_PLACEHOLDER.test('prefix-${VAR}')).toBe(false);

    // 结构：正则字面量在 src 内仅存一处（client.ts 导出）；releaseScan 导入消费
    const clientSrc = readFileSync(path.resolve(import.meta.dirname, '../src/mcp/client.ts'), 'utf8');
    const scanSrc = readFileSync(path.resolve(import.meta.dirname, '../src/scripts/releaseScan.ts'), 'utf8');
    const literal = /A-Za-z_\]\[A-Za-z0-9_\]/;
    const clientMatches = clientSrc.match(new RegExp(literal, 'g'));
    expect(clientMatches).toHaveLength(1); // 仅导出定义一处
    expect(scanSrc).not.toMatch(literal); // releaseScan 不再复制
    expect(scanSrc).toContain('ENVREF_PLACEHOLDER');
    expect(scanSrc).toContain("from '../mcp/client.js'");
  });
});
