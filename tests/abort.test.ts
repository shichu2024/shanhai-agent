import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, registerL3Tool, approvalSpec } from './helpers.js';

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

describe('DoD-④ abort 立即中止（A3 §2 v1.1 两级取消）', () => {
  it('abort 单测：模型调用中 --force → 立即放弃等待，Cancelled(abort) + abortedDuring', async () => {
    const h = makeHarness([
      { kind: 'delay', ms: 400 }, // 在飞原子调用窗口
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ab-model' }));
    const taskId = h.rt.tasks.createTask('ab-model', validInput, 't');
    const running = h.rt.tasks.runTask(taskId);
    await new Promise((r) => setTimeout(r, 50)); // 进入 Running 且处于模型调用中
    const t0 = Date.now();
    const result = h.rt.tasks.cancel(taskId, 'operator', { force: true });
    expect(result.mode).toBe('abort');
    const row = await running;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(350); // 立即（不等 400ms 原子调用完成）
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('abort');
    const evt = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_cancelled') as {
      cancelReason: string; mode: string; abortedDuring: { callNo: number; callKind: string; phase: string }; abortRequestedBy: string | null;
    };
    expect(evt.cancelReason).toBe('abort');
    expect(evt.mode).toBe('abort');
    expect(evt.abortedDuring).toMatchObject({ callKind: 'model', phase: 'model_call' });
    expect(evt.abortRequestedBy).toBe('operator');
  });

  it('跨进程 abortRequested 单测：持久化标志 → 执行进程在原子调用边界执行中止（延迟上限 = 最长原子调用）', async () => {
    const h = makeHarness([
      { kind: 'delay', ms: 200 },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ab-cross' }));
    const taskId = h.rt.tasks.createTask('ab-cross', validInput, 't');
    const running = h.rt.tasks.runTask(taskId);
    await new Promise((r) => setTimeout(r, 40)); // 复验后、在飞中
    // 模拟另一进程 cancel --force：只写 abortRequested 标志（不经本进程 cancel 入口）
    dbOf(h.rt).prepare('UPDATE task_record SET abortRequested = 1 WHERE taskId = ?').run(taskId);
    const row = await running;
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('abort');
    const evt = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_cancelled') as { mode: string };
    expect(evt.mode).toBe('abort');
  });

  it('graceful × Paused：挂起态无在飞原子调用 → 立即迁移 + superseded + 删 snapshot（P2-6）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('ab-paused'));
    const taskId = h.rt.tasks.createTask('ab-paused', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
    const requestId = h.rt.approvals.pendingForTask(taskId)!.requestId;

    const result = h.rt.tasks.cancel(taskId, 'user'); // graceful（无 --force）
    expect(result.mode).toBe('graceful');
    const row = h.rt.tasks.getTask(taskId);
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('user');
    // pending 请求作废（不产生假裁决）+ 快照删除
    expect(h.rt.approvals.getRequest(requestId)!.decision).toBe('superseded');
    expect(dbOf(h.rt).prepare('SELECT * FROM pause_snapshot WHERE taskId = ?').get(taskId)).toBeUndefined();
  });

  it('abort × Paused：--force 到达挂起任务 → 立即迁移（cancelReason=abort）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('ab-paused-f'));
    const taskId = h.rt.tasks.createTask('ab-paused-f', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    h.rt.tasks.cancel(taskId, 'operator', { force: true });
    const row = h.rt.tasks.getTask(taskId);
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('abort');
  });

  it('Queued abort：--force 到达等待任务 → 立即 Cancelled(abort)', async () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ab-queued' }));
    const taskId = h.rt.tasks.createTask('ab-queued', validInput, 't');
    h.rt.tasks.cancel(taskId, 'operator', { force: true });
    expect(h.rt.tasks.getTask(taskId).cancelReason).toBe('abort');
  });

  it('graceful 跨进程：任务由本进程执行之外 → 结构化提示使用 --force（F-3 两段式诚实语义）', async () => {
    const h = makeHarness([{ kind: 'delay', ms: 150 }, { kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ab-grace-x' }));
    const taskId = h.rt.tasks.createTask('ab-grace-x', validInput, 't');
    const running = h.rt.tasks.runTask(taskId);
    await new Promise((r) => setTimeout(r, 30));
    // 模拟另一进程视角：清除本进程运行时句柄（库层面 abortRequested 未置位）
    (h.rt.tasks as unknown as { runningCancels: Map<string, unknown> }).runningCancels.delete(taskId);
    expect(() => h.rt.tasks.cancel(taskId, 'other-proc')).toThrowError(/--force/);
    // 恢复句柄以正常收尾
    await running;
  });
});
