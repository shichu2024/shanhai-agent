import { describe, expect, it } from 'vitest';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf } from './helpers.js';
import { queryT1, queryT2 } from '../src/evidence.js';
import { existsSync, readFileSync } from 'node:fs';

const validJson = JSON.stringify(validOutput());

describe('A3 任务生命周期（端到端）', () => {
  it('C1 主干：注册→校验→执行→Trace 落盘→终态与归因正确', async () => {
    const { rt } = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-a' }));
    const taskId = rt.tasks.createTask('e2e-a', validInput, 'tester');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded');
    expect(row.terminalFailureClass).toBeNull();
    expect(row.modelCallCount).toBe(1);

    const events = rt.trace.readEvents(taskId);
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(['task_created', 'contract_checked', 'task_queued', 'task_started', 'attempt_started', 'model_call_completed', 'contract_checked', 'task_succeeded']);
    // 信封字段在每个事件上（版本固定原则，A6 §1）
    for (const e of events) {
      expect(e.agentId).toBe('e2e-a');
      expect(e.agentVersionId).toHaveLength(36);
      expect(e.specContentHash).toHaveLength(64);
    }
    // 任务级事件 callNo=0 / callKind=null；调用事件键位正确（A6 §2）
    const call = events.find((e) => e.eventType === 'model_call_completed')!;
    expect(call.callKind).toBe('model');
    expect(call.callNo).toBe(1);
    expect(call.attemptNo).toBe(1);
    expect(call.usage).toMatchObject({ estimated: true }); // Mock 不返回 usage → 本地估算标 estimated
  });

  it('task_started.bindingSnapshot 承载 toolVersions/modelId/promptHash（T1 载体）', async () => {
    const { rt } = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-bind' }));
    const taskId = rt.tasks.createTask('e2e-bind', validInput, 't');
    await rt.tasks.runTask(taskId);
    const started = rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_started') as { bindingSnapshot: { toolVersions: { toolId: string; implVersion: string }[]; modelId: string; promptHash: string } };
    expect(started.bindingSnapshot.toolVersions).toEqual([{ toolId: 'docs-list', implVersion: '0.1.0' }]);
    expect(started.bindingSnapshot.modelId).toBe('mock-model');
    expect(started.bindingSnapshot.promptHash).toHaveLength(64);
  });

  it('工具调用闭环：模型请求工具 → 执行 → 结果回填 → 最终输出', async () => {
    const { rt } = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'docs-list', args: { subdir: '' } }] },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-tool' }));
    const taskId = rt.tasks.createTask('e2e-tool', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded');
    const types = rt.trace.readEvents(taskId).map((e) => e.eventType);
    expect(types).toContain('tool_call_requested');
    expect(types).toContain('tool_call_executed');
    // callNo 按 callKind 各自独立编号（R2-1）：model=1,2 / tool=1
    const modelCalls = rt.trace.readEvents(taskId).filter((e) => e.callKind === 'model').map((e) => e.callNo);
    const toolCalls = rt.trace.readEvents(taskId).filter((e) => e.callKind === 'tool').map((e) => e.callNo);
    expect(new Set(modelCalls)).toEqual(new Set([1, 2]));
    expect(new Set(toolCalls)).toEqual(new Set([1]));
    expect(row.modelCallCount).toBe(2);
  });

  it('审计边界：落库前拒绝 → RejectedRequest、无 Task、无 Trace（A3 §3.1-①）', () => {
    const { rt } = makeHarness();
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-reject' }));
    expect(() => rt.tasks.createTask('e2e-reject', { wrong: 'shape' }, 't')).toThrowError(/Input Contract/);
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    expect(db.prepare(`SELECT COUNT(*) c FROM task_record`).get()).toMatchObject({ c: 0 });
    const rejected = db.prepare(`SELECT * FROM audit_events WHERE kind='task_creation'`).get() as { agentVersionId: string; rejectReason: string };
    expect(rejected.agentVersionId).toHaveLength(36); // 可定位时填入（T2 锚点）
    expect(existsSync(rt.trace.traceFile('nonexistent'))).toBe(false);
  });

  it('指针解析失败：RejectedRequest.agentVersionId 为 NULL（P2-2 显式接受）', () => {
    const { rt } = makeHarness();
    expect(() => rt.tasks.createTask('no-such-agent', validInput, 't')).toThrowError(/不可解析/);
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    const row = db.prepare(`SELECT * FROM audit_events WHERE kind='task_creation'`).get() as { agentVersionId: string | null };
    expect(row.agentVersionId).toBeNull();
  });

  it('④ 防御性复验：注册后工具等级上调 → Created→Failed:Spec(defensive_revalidation_failed)', () => {
    const { rt } = makeHarness();
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-defensive' }));
    // 世界变了：工具等级 L0 → L1（等级只能升）
    rt.registry.registerTool({ toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L1', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' }, 'lib-maintainer');
    expect(() => rt.tasks.createTask('e2e-defensive', validInput, 't')).toThrowError(/defensive_revalidation_failed/);
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    const task = db.prepare(`SELECT * FROM task_record WHERE agentId='e2e-defensive'`).get() as { status: string; terminalFailureClass: string };
    expect(task.status).toBe('failed');
    expect(task.terminalFailureClass).toBe('Spec(defensive_revalidation_failed)');
    const trace = rt.trace.readEvents(task.taskId ?? (db.prepare(`SELECT taskId FROM task_record WHERE agentId='e2e-defensive'`).get() as { taskId: string }).taskId);
    expect(trace.map((e) => e.eventType)).toContain('task_failed');
  });

  it('Queued→Cancelled：等待中取消即时生效', async () => {
    const { rt } = makeHarness();
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-cancel-q' }));
    const taskId = rt.tasks.createTask('e2e-cancel-q', validInput, 't');
    rt.tasks.cancel(taskId, 'user');
    expect(rt.tasks.getTask(taskId).status).toBe('cancelled');
  });

  it('Running 取消：等待当前原子调用完成后生效（graceful 标记）', async () => {
    const { rt } = makeHarness([
      { kind: 'delay', ms: 150 },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-cancel-r' }));
    const taskId = rt.tasks.createTask('e2e-cancel-r', validInput, 't');
    const running = rt.tasks.runTask(taskId);
    await new Promise((r) => setTimeout(r, 50)); // 进入 Running 且处于原子调用中
    rt.tasks.cancel(taskId, 'user');
    const row = await running;
    expect(row.status).toBe('cancelled');
    const evt = rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_cancelled') as { graceful: boolean; cancelReason: string };
    expect(evt.graceful).toBe(true);
    expect(evt.cancelReason).toContain('原子调用');
  });

  it('输出空且未声明 allowEmpty → Output(ContractViolation)；声明后放行', async () => {
    const { rt } = makeHarness([
      { kind: 'text', text: JSON.stringify({}) },
      { kind: 'text', text: JSON.stringify({}) },
      { kind: 'text', text: JSON.stringify({}) },
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-empty' }));
    const taskId = rt.tasks.createTask('e2e-empty', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Model(schema_violation)'); // attempt 内契约失败耗尽后终局（A4 §3-⑤：末次 attempt 子类升级）

    const { rt: rt2 } = makeHarness([{ kind: 'text', text: JSON.stringify({}) }]);
    const spec = sampleSpec({ agentId: 'e2e-empty-ok' });
    (spec.outputContract as Record<string, unknown>).allowEmpty = true;
    registerAndRelease(rt2, spec);
    const t2 = rt2.tasks.createTask('e2e-empty-ok', validInput, 't');
    expect((await rt2.tasks.runTask(t2)).status).toBe('succeeded');
  });

  it('不可解析输出重试后耗尽 → Model(unparseable_output) 终局，attemptCount 聚合', async () => {
    const { rt } = makeHarness([
      { kind: 'text', text: '这不是 JSON' },
      { kind: 'text', text: '仍然不是 JSON' },
      { kind: 'text', text: '还不是 JSON' },
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'e2e-unparseable' }));
    const taskId = rt.tasks.createTask('e2e-unparseable', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Model(unparseable_output)');
    expect(row.modelCallCount).toBe(3); // 已发起口径含失败 attempt（D-2）
    expect(row.attemptCount).toBe(0); // 模型 attempt 不走工具计数（TaskRecord.attemptCount 仅展示聚合）
    const failures = rt.failures.forTask(taskId) as { failureClass: string; subClass: string; countedInContractRate: number }[];
    expect(failures.at(-1)).toMatchObject({ failureClass: 'Model', subClass: 'unparseable_output', countedInContractRate: 1 });
  });
});

describe('T1/T2 单一查询（A6 §6）', () => {
  it('T1：有 task_started → 完整绑定（快照 + toolVersions/modelId/promptHash）', async () => {
    const { rt } = makeHarness([{ kind: 'text', text: validJson }]);
    const versionId = registerAndRelease(rt, sampleSpec({ agentId: 't1-a' }));
    const taskId = rt.tasks.createTask('t1-a', validInput, 't');
    await rt.tasks.runTask(taskId);
    const answer = queryT1(rt, taskId);
    expect(answer.agentVersionId).toBe(versionId);
    expect((answer.specSnapshot as { identity: { agentId: string } }).identity.agentId).toBe('t1-a');
    expect(answer.hasTaskStarted).toBe(true);
    expect(answer.bindingSnapshot!.modelId).toBe('mock-model');
  });

  it('T1 两级形态（P2-7）：Created→Failed 无 task_started → 信封级答案非空', () => {
    const { rt } = makeHarness();
    registerAndRelease(rt, sampleSpec({ agentId: 't1-b' }));
    rt.registry.registerTool({ toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L1', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' }, 'x');
    expect(() => rt.tasks.createTask('t1-b', validInput, 't')).toThrowError();
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    const taskId = (db.prepare(`SELECT taskId FROM task_record WHERE agentId='t1-b'`).get() as { taskId: string }).taskId;
    const answer = queryT1(rt, taskId);
    expect(answer.hasTaskStarted).toBe(false);
    expect(answer.bindingSnapshot).toBeNull();
    expect(answer.agentVersionId).toHaveLength(36); // 信封级答案非空
    expect(answer.specSnapshot).toBeTruthy();
  });

  it('T2：单一查询返回全部越权尝试与拦截点（audit ∪ policy_denied + NULL 兜底）', async () => {
    const { rt } = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'rm-everything', args: {} }] }, // 越权 1
      { kind: 'tool_use', calls: [{ id: 'c2', toolId: 'drop-table', args: {} }] }, // 越权 2 → PolicyBlocked
    ]);
    const versionId = registerAndRelease(rt, sampleSpec({ agentId: 't2-a' }));
    const taskId = rt.tasks.createTask('t2-a', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Policy(PolicyBlocked)'); // C3-③ 归因不漂移

    // 制造一条该版本可定位的 task_creation 拒绝（T2 kind 并集）
    expect(() => rt.tasks.createTask('t2-a', { bad: 1 }, 't')).toThrowError();

    const answer = queryT2(rt, versionId);
    expect(answer.agentId).toBe('t2-a');
    expect(answer.policyDeniedEvents).toHaveLength(2);
    expect(answer.policyDeniedEvents.map((e) => e.reasonCode)).toEqual(['not_declared_in_spec', 'not_declared_in_spec']);
    expect(answer.policyDeniedEvents[1].consecutiveDenialCount).toBe(2);
    expect(answer.rejectedRequests.length).toBeGreaterThanOrEqual(1); // task_creation 拒绝在列
    expect(answer.unresolvableTaskCreations).toBe(0);
  });
});
