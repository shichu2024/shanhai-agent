import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { queryT2Prime } from '../src/evidence.js';
import {
  makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf,
  registerL3Tool, approvalSpec,
} from './helpers.js';

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function snapshotOf(rt: Runtime, taskId: string): unknown {
  return dbOf(rt).prepare('SELECT * FROM pause_snapshot WHERE taskId = ?').get(taskId);
}

/** 驱动到 Paused：模型请求 L3 工具 → 挂起即退出（runTask 返回 Paused 行） */
async function driveToPaused(h: ReturnType<typeof makeHarness>, agentId: string) {
  registerL3Tool(h);
  registerAndRelease(h.rt, approvalSpec(agentId));
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(taskId);
  expect(row.status).toBe('paused');
  const request = h.rt.approvals.pendingForTask(taskId)!;
  expect(request).not.toBeNull();
  return { taskId, request, agentId, versionId: h.rt.tasks.getTask(taskId).agentVersionId };
}

describe('DoD-① L3 审批端到端（注册→请求→Paused→approve→resume→终态）', () => {
  it('全链 Trace 事件齐：task_paused → approval_requested → approval_decided → task_resumed → 终态', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'prod-db' } }] },
      { kind: 'text', text: validJson },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('ap-e2e'));
    const taskId = h.rt.tasks.createTask('ap-e2e', validInput, 't');

    const pausedRow = await h.rt.tasks.runTask(taskId);
    expect(pausedRow.status).toBe('paused'); // run 进程于此退出（挂起即退出，D-18）
    const request = h.rt.approvals.pendingForTask(taskId)!;
    expect(request.toolId).toBe('l3-op');
    expect(request.riskLevel).toBe('L3');
    expect(request.decision).toBe('pending');
    expect(snapshotOf(h.rt, taskId)).toBeTruthy(); // PauseSnapshot 先持久化

    // approve 只写 decision（R-1：任务保持 Paused，迁移权归 resume）
    h.rt.approvals.approve(request.requestId, 'human');
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');

    // resume：迁移 + 反序列化 + 从 nextCallRef 继续执行至终态
    const finalRow = await h.rt.tasks.runTask(taskId, null, { resume: true, resumedBy: 'manual-resume' });
    expect(finalRow.status).toBe('succeeded');
    expect(snapshotOf(h.rt, taskId)).toBeUndefined(); // 离开 Paused 即删

    const types = h.rt.trace.readEvents(taskId).map((e) => e.eventType);
    const chain = ['task_paused', 'approval_requested', 'approval_decided', 'task_resumed', 'task_succeeded'];
    for (const evt of chain) expect(types).toContain(evt);
    expect(types.indexOf('task_paused')).toBeLessThan(types.indexOf('approval_requested'));
    expect(types.indexOf('approval_decided')).toBeLessThan(types.indexOf('task_resumed'));
    expect(types.indexOf('task_resumed')).toBeLessThan(types.indexOf('task_succeeded'));
    // 续跑后模型调用 2 次（挂起前后各一），预算跨进程续接
    expect(finalRow.modelCallCount).toBe(2);
  });

  it('审批通过后该次调用放行执行（工具真实执行、结果回填模型上下文）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'ap-exec');
    h.rt.approvals.approve(request.requestId, 'human');
    const row = await h.rt.tasks.runTask(taskId, null, { resume: true });
    expect(row.status).toBe('succeeded');
    const events = h.rt.trace.readEvents(taskId);
    const executed = events.find((e) => e.eventType === 'tool_call_executed') as unknown as { toolId: string; riskLevel: string };
    expect(executed.toolId).toBe('l3-op');
    expect(executed.riskLevel).toBe('L3');
  });

  it('多调用批次：L0 先执行成功、L3 后挂起 → resume 从 nextCallRef 续跑，callNo 不漂移（HIGH-1 回归）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'docs-list', args: { subdir: '' } }, { id: 'c2', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, sampleSpec({
      agentId: 'ap-batch',
      tools: [{ toolId: 'docs-list', riskLevel: 'L0' }, { toolId: 'l3-op', riskLevel: 'L3' }],
      extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
    }));
    const taskId = h.rt.tasks.createTask('ap-batch', validInput, 't');
    const pausedRow = await h.rt.tasks.runTask(taskId);
    expect(pausedRow.status).toBe('paused');

    // 挂起前 L0 已执行（tool_call_no=1）；L3 为第 2 个调用（toolCallNo=2）
    const events = h.rt.trace.readEvents(taskId);
    const l0Exec = events.find((e) => e.eventType === 'tool_call_executed') as unknown as { toolId: string; callNo: number };
    expect(l0Exec.toolId).toBe('docs-list');
    const request = h.rt.approvals.pendingForTask(taskId)!;
    expect(request.callRef).toBe('2');

    h.rt.approvals.approve(request.requestId, 'human');
    const row = await h.rt.tasks.runTask(taskId, null, { resume: true });
    expect(row.status).toBe('succeeded'); // 若编号回退公式错误，此处将再次挂起而非终态

    const executed = h.rt.trace.readEvents(taskId).filter((e) => e.eventType === 'tool_call_executed') as unknown as { toolId: string; callNo: number }[];
    const l3Exec = executed.find((e) => e.toolId === 'l3-op')!;
    expect(l3Exec.callNo).toBe(2); // 与快照 callRef 一致（approvedRef 匹配，不漂移）
    expect(executed).toHaveLength(2); // L0 未被重复执行
  });

  it('并发守卫：已 approve 的请求不受惰性超时覆写（先落库者生效，MEDIUM-1 回归）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] },
      { kind: 'text', text: validJson },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('ap-race'));
    const taskId = h.rt.tasks.createTask('ap-race', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    const request = h.rt.approvals.pendingForTask(taskId)!;
    h.rt.approvals.approve(request.requestId, 'human');
    // 另一进程视角：timeoutAt 已过 → 惰性扫描不得覆写 approved 裁决
    dbOf(h.rt).prepare(`UPDATE approval_request SET timeoutAt = '2020-01-01T00:00:00.000Z' WHERE taskId = ?`).run(taskId);
    h.rt.approvals.applyLazyTimeouts();
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('approved');
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 未被误终局
    const row = await h.rt.tasks.runTask(taskId, null, { resume: true });
    expect(row.status).toBe('succeeded'); // manual-resume 仍可达终态
  });

  it('approve 后模型后续轮次再请求 L3 → 新 ApprovalRequest 独立审批（§4.1-1 deny 语义）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }, // 第一次挂起
      { kind: 'tool_use', calls: [{ id: 'a2', toolId: 'l3-op', args: {} }] }, // 续跑后再次请求（新调用键）
      { kind: 'text', text: validJson },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('ap-again'));
    const taskId = h.rt.tasks.createTask('ap-again', validInput, 't');

    await h.rt.tasks.runTask(taskId);
    const r1 = h.rt.approvals.pendingForTask(taskId)!;
    h.rt.approvals.approve(r1.requestId, 'human');
    const row = await h.rt.tasks.runTask(taskId, null, { resume: true });
    expect(row.status).toBe('paused'); // 再次挂起（每次 L3 调用独立审批）

    const r2 = h.rt.approvals.pendingForTask(taskId)!;
    expect(r2.requestId).not.toBe(r1.requestId); // 新 ApprovalRequest（新调用键）
    expect(r2.callRef).not.toBe(r1.callRef);
    h.rt.approvals.approve(r2.requestId, 'human');
    const final = await h.rt.tasks.runTask(taskId, null, { resume: true });
    expect(final.status).toBe('succeeded');
  });
});

describe('DoD-② P0-1 修复用例（run 于 Paused 退出/被 kill → approve → --resume → 终态）', () => {
  it('进程重启（run 进程已死）：新进程 approve + manual resume 仍可达终态（R-1 双断言之一）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('ap-restart'));
    const taskId = h.rt.tasks.createTask('ap-restart', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    const requestId = h.rt.approvals.pendingForTask(taskId)!.requestId;
    const versionId = h.rt.tasks.getTask(taskId).agentVersionId;
    h.rt.close(); // run 进程死亡（Paused 是持久化合法长驻态）

    // 新进程：审批 + 续跑（续跑脚本=text 输出；工具实现随进程挂载——对应真实 run 进程的 Tool Registry 装配）
    const rt2 = Runtime.withProvider(new MockProvider([{ kind: 'text', text: validJson }]), ['mock-model'], h.dataDir, process.cwd());
    rt2.startup('approver');
    rt2.toolImpls.set('l3-op', (args) => ({ ok: true, echo: args }));
    expect(rt2.tasks.getTask(taskId).status).toBe('paused'); // Paused 不进恢复扫描（A3 §6 v1.1）
    rt2.approvals.approve(requestId, 'human'); // approve 崩溃于 spawn 前的等价：只写 decision，无 spawn
    expect(rt2.tasks.getTask(taskId).status).toBe('paused'); // 任务停留 Paused（合法长驻）
    const row = await rt2.tasks.runTask(taskId, null, { resume: true, resumedBy: 'manual-resume' });
    expect(row.status).toBe('succeeded');
    const resumed = rt2.trace.readEvents(taskId).find((e) => e.eventType === 'task_resumed') as { resumedBy: string };
    expect(resumed.resumedBy).toBe('manual-resume');
    // T2′ 举证：跨进程查询该版本全部审批请求与裁决
    const t2p = queryT2Prime(rt2, versionId);
    expect(t2p.requests.map((r) => r.decision)).toEqual(['approved']);
    expect(t2p.events.map((e) => e.eventType)).toContain('approval_requested');
    expect(t2p.events.map((e) => e.eventType)).toContain('approval_decided');
    rt2.close();
  });

  it('--resume 前置校验：Paused+pending → 提示先审批；非 Paused → 报告当前状态', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId } = await driveToPaused(h, 'ap-precheck');
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/pending.*approve|approve.*pending|先.*approve/);

    const normal = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(normal.rt, sampleSpec({ agentId: 'ap-precheck-2' }));
    const otherId = normal.rt.tasks.createTask('ap-precheck-2', validInput, 't');
    await expect(normal.rt.tasks.runTask(otherId, null, { resume: true })).rejects.toThrowError(/resume|Paused/);
  });

  it('approve 二次调用/已裁决 → 结构化错误（先落库者生效）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { request } = await driveToPaused(h, 'ap-double');
    h.rt.approvals.approve(request.requestId, 'human');
    expect(() => h.rt.approvals.approve(request.requestId, 'human')).toThrowError(/已裁决/);
  });

  it('Paused 期间任务级超时暂停计时（挂钟 ≠ 执行时钟，pausedDurationMs 累计）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] },
      { kind: 'text', text: validJson },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, {
      ...approvalSpec('ap-timeout-pause'),
      modelPolicy: { allowedModels: ['mock-model'], maxModelCalls: 10, maxTokens: 100000, taskTimeoutMs: 300 },
    });
    const taskId = h.rt.tasks.createTask('ap-timeout-pause', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    const request = h.rt.approvals.pendingForTask(taskId)!;
    await new Promise((r) => setTimeout(r, 400)); // 挂起 400ms > taskTimeoutMs——但挂起期间不计时
    h.rt.approvals.approve(request.requestId, 'human');
    const row = await h.rt.tasks.runTask(taskId, null, { resume: true });
    expect(row.status).toBe('succeeded'); // 若按挂钟计早已超时；执行时钟排除 Paused 时长
    expect(row.pausedDurationMs).toBeGreaterThanOrEqual(350);
  });
});

describe('DoD-③ deny / 超时两路径终态', () => {
  it('deny → Cancelled(approval_denied)，无 FailureRecord，snapshot 删除，任务级终局', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId, request } = await driveToPaused(h, 'ap-deny');
    h.rt.approvals.deny(request.requestId, 'human', '不该动生产库');
    const row = h.rt.tasks.getTask(taskId);
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('approval_denied');
    expect(snapshotOf(h.rt, taskId)).toBeUndefined();
    expect(h.rt.failures.forTask(taskId)).toEqual([]); // Cancelled 不产生 FailureRecord
    const decided = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'approval_decided') as { decision: string };
    expect(decided.decision).toBe('denied');
  });

  it('超时-deny（默认 onTimeout）：惰性判定 → Cancelled(approval_timeout)', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId } = await driveToPaused(h, 'ap-timeout-d');
    // 推进时钟锚点：timeoutAt 置于过去（惰性判定锚点 = ApprovalRequest.timeoutAt）
    dbOf(h.rt).prepare(`UPDATE approval_request SET timeoutAt = '2020-01-01T00:00:00.000Z' WHERE taskId = ?`).run(taskId);
    const touched = h.rt.approvals.list({ pendingOnly: true }); // approval list 顺带惰性判定
    expect(touched).toEqual([]); // 判定后 pending 队列为空
    const row = h.rt.tasks.getTask(taskId);
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('approval_timeout');
    expect(snapshotOf(h.rt, taskId)).toBeUndefined();
  });

  it('超时-fail（onTimeout=fail）→ Failed:Policy(ApprovalTimeout)，不计契约失败率', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('ap-timeout-f', { approvalPolicy: { onTimeout: 'fail' } }));
    const taskId = h.rt.tasks.createTask('ap-timeout-f', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    dbOf(h.rt).prepare(`UPDATE approval_request SET timeoutAt = '2020-01-01T00:00:00.000Z' WHERE taskId = ?`).run(taskId);
    h.rt.approvals.applyLazyTimeouts();
    const row = h.rt.tasks.getTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Policy(ApprovalTimeout)');
    const failures = h.rt.failures.forTask(taskId) as { subClass: string; countedInContractRate: number }[];
    expect(failures.at(-1)).toMatchObject({ failureClass: 'Policy', subClass: 'ApprovalTimeout', countedInContractRate: 0 });
  });

  it('恢复扫描：Paused 超时未判定 → stalePausedTasks 只读警示（不改状态）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId } = await driveToPaused(h, 'ap-stale');
    dbOf(h.rt).prepare(`UPDATE approval_request SET timeoutAt = '2020-01-01T00:00:00.000Z' WHERE taskId = ?`).run(taskId);
    const report = h.rt.state.recover();
    expect(report.stalePausedTasks).toContain(taskId);
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 只读警示，不迁移
    expect(report.crashMarkedTasks).not.toContain(taskId);
  });
});

describe('DoD-④ 孤儿快照清理（R-4）与恢复扫描', () => {
  it('snapshot 写后、Paused 迁移前被 kill → Running 遗留 → CrashRecovery 终局 + 快照删除 + 孤儿 pending 作废', () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ap-orphan' }));
    const taskId = h.rt.tasks.createTask('ap-orphan', validInput, 't');
    // 模拟崩溃窗口：snapshot 与 request 已写但迁移未发生（任务从未进入 Paused）
    dbOf(h.rt)
      .prepare(`INSERT INTO pause_snapshot (taskId, contextJson, callCounters, nextCallRef, savedAt) VALUES (?,?,?,?,?)`)
      .run(taskId, '{}', '{}', '1', '2026-01-01T00:00:00.000Z');
    dbOf(h.rt)
      .prepare(
        `INSERT INTO approval_request (requestId, taskId, agentVersionId, toolId, riskLevel, requestedAt, decision, timeoutAt, callRef)
         VALUES ('req-orphan', ?, ?, 'docs-list', 'L3', '2026-01-01T00:00:00.000Z', 'pending', '2999-01-01T00:00:00.000Z', '1')`,
      )
      .run(taskId, h.rt.tasks.getTask(taskId).agentVersionId);
    dbOf(h.rt).prepare(`UPDATE task_record SET status='running' WHERE taskId=?`).run(taskId);

    const report = h.rt.state.recover();
    expect(report.crashMarkedTasks).toContain(taskId);
    expect(h.rt.tasks.getTask(taskId).terminalFailureClass).toBe('Runtime(CrashRecovery)');
    expect(snapshotOf(h.rt, taskId)).toBeUndefined(); // R-4：孤儿快照兜底删除
    expect(h.rt.approvals.getRequest('req-orphan')!.decision).toBe('superseded'); // 孤儿 pending 一并作废
  });

  it('Paused 任务跨重启不迁移（A3 §6 v1.1：合法长驻态不进恢复扫描）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId } = await driveToPaused(h, 'ap-survive');
    h.rt.close();
    const rt2 = Runtime.withProvider(new MockProvider([]), ['mock-model'], h.dataDir, process.cwd());
    const report = rt2.startup('restart');
    expect(report.crashMarkedTasks).toEqual([]);
    expect(rt2.tasks.getTask(taskId).status).toBe('paused');
    expect(snapshotOf(rt2, taskId)).toBeTruthy();
    rt2.close();
  });
});

describe('DoD-⑥ T2′ 审批可举证 + R-3 调用点拦截回归', () => {
  it('T2′：单一查询返回该版本全部 L3 审批请求及裁决（表 ∪ Trace）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, versionId } = await driveToPaused(h, 'ap-t2p');
    const requestId = h.rt.approvals.pendingForTask(taskId)!.requestId;
    h.rt.approvals.approve(requestId, 'human');
    await h.rt.tasks.runTask(taskId, null, { resume: true });

    const answer = queryT2Prime(h.rt, versionId);
    expect(answer.agentId).toBe('ap-t2p');
    expect(answer.requests).toHaveLength(1);
    expect(answer.requests[0]).toMatchObject({ requestId, toolId: 'l3-op', riskLevel: 'L3', decision: 'approved' });
    const eventTypes = answer.events.map((e) => e.eventType);
    expect(eventTypes).toContain('approval_requested');
    expect(eventTypes).toContain('approval_decided');
  });

  it('R-3：工具重登记 L3 后，在飞调用点按当前登记等级拦截（risk_level_blocked 可达）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'docs-list', args: {} }] },
      { kind: 'tool_use', calls: [{ id: 'c2', toolId: 'docs-list', args: {} }] },
    ]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ap-r3', modelPolicy: { maxModelCalls: 50, maxTokens: 100000 } }));
    const taskId = h.rt.tasks.createTask('ap-r3', validInput, 't'); // 复验通过（此时 L0）
    // 复验之后、调用之前：等级上调 L3（等级只能升）
    h.rt.registry.registerTool(
      { toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L3', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' },
      'lib-maintainer',
    );
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Policy(PolicyBlocked)');
    const denied = h.rt.trace.readEvents(taskId).filter((e) => e.eventType === 'policy_denied') as unknown as { reasonCode: string }[];
    expect(denied.map((d) => d.reasonCode)).toEqual(['risk_level_blocked', 'risk_level_blocked']); // 调用点拦截可达（无审批路径不改道）
  });
});
