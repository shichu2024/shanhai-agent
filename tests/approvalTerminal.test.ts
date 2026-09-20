import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { ApprovalError } from '../src/modules/approval.js';
import {
  makeHarness, sampleSpec, registerAndRelease, registerL3Tool, validInput, validOutput, approvalSpec,
} from './helpers.js';

// §4.6 审批×中止终态组合测试（批次一热身项，A-2 / 改进断言②）：纯测试补齐，零实现变更。
// 实现已是简单结构化拒绝（approval.ts approve/deny 的 task_not_paused / already_decided / timeout_applied 分支），
// 本组用例补证既有行为并覆盖设计文档 §4.6 五用例表。

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 驱动到 Paused（L3 挂起），返回任务与 pending 请求 */
async function driveToPaused(h: ReturnType<typeof makeHarness>, agentId: string) {
  registerL3Tool(h);
  registerAndRelease(h.rt, approvalSpec(agentId));
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  await h.rt.tasks.runTask(taskId);
  expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  const request = h.rt.approvals.pendingForTask(taskId)!;
  expect(request).not.toBeNull();
  return { taskId, request };
}

/** 直取结构化错误码 */
function codeOf(fn: () => unknown): { code: string; detail: Record<string, unknown> | undefined } {
  try {
    fn();
  } catch (e) {
    const err = e as ApprovalError;
    expect(err).toBeInstanceOf(ApprovalError);
    return { code: err.code, detail: err.detail };
  }
  throw new Error('预期抛出 ApprovalError，实际未抛');
}

describe('§4.6 用例 1：终态任务上 approve / deny → task_not_paused 结构化拒绝 + 状态回显 + 无裁决写入', () => {
  for (const terminal of ['succeeded', 'failed', 'cancelled'] as const) {
    it(`终态 ${terminal}：approve 与 deny 均拒绝，pending 保持未裁决`, async () => {
      const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
      const { taskId, request } = await driveToPaused(h, `at-${terminal}`);
      // 直接迁移到终态（模拟裁决窗口外任务已被终结；pending 请求原样残留）
      dbOf(h.rt).prepare(`UPDATE task_record SET status = ? WHERE taskId = ?`).run(terminal, taskId);

      const ap = codeOf(() => h.rt.approvals.approve(request.requestId, 'human'));
      expect(ap.code).toBe('task_not_paused');
      expect(ap.detail?.status).toBe(terminal); // 状态回显
      const dn = codeOf(() => h.rt.approvals.deny(request.requestId, 'human'));
      expect(dn.code).toBe('task_not_paused');
      expect(dn.detail?.status).toBe(terminal);

      // 无裁决写入：请求仍 pending，无 approval_decided 事件
      expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('pending');
      const decided = h.rt.trace.readEvents(taskId).filter((e) => e.eventType === 'approval_decided');
      expect(decided).toEqual([]);
    });
  }

  it('真实终态（非 SQL 造态）对照：任务正常成功后再无挂起点，历史已裁决请求再 approve → already_decided', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'at-real');
    h.rt.approvals.approve(request.requestId, 'human');
    const row = await h.rt.tasks.runTask(taskId, null, { resume: true });
    expect(row.status).toBe('succeeded');
    // 终态 + 已裁决：先落库者生效（requirePending 先于状态检查——表内裁决是第一守卫）
    const again = codeOf(() => h.rt.approvals.approve(request.requestId, 'human'));
    expect(again.code).toBe('already_decided');
  });
});

describe('§4.6 用例 2：反序竞争——deny 先落库，approve 后到达', () => {
  it('approve → already_decided（decision=denied 回显），裁决不被覆写', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId, request } = await driveToPaused(h, 'at-race');
    h.rt.approvals.deny(request.requestId, 'human', '不该动生产库');
    const ap = codeOf(() => h.rt.approvals.approve(request.requestId, 'human'));
    expect(ap.code).toBe('already_decided');
    expect(ap.detail?.decision).toBe('denied'); // 先落库者生效（守卫既有行为补证）
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('denied');
    expect(h.rt.tasks.getTask(taskId).status).toBe('cancelled'); // deny 终局未被覆写
  });
});

describe('§4.6 用例 3：挂起超时后 approve 到达 → timeout_applied 分支（原零测试）', () => {
  it('请求仍 pending、任务仍 Paused、timeoutAt 已过 → approve 走 timeout_applied 结构化拒绝', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId, request } = await driveToPaused(h, 'at-late');
    // 构造「惰性扫描未认领、检查点已过期」的竞争窗口结果：
    // timeoutAt 写为小写 t/z 的 ISO 过去时刻——Date.parse 等值接受，而 SQLite 二进制比较中
    // 't' > 'T' 使惰性扫描（timeoutAt < nowNs()）不认领该行（等价于扫描与检查之间到期的竞争结局），
    // 从而唯一可达地覆盖 approve 内 timeout_applied 分支。
    const past = new Date(Date.now() - 60_000).toISOString().toLowerCase();
    dbOf(h.rt).prepare(`UPDATE approval_request SET timeoutAt = ? WHERE requestId = ?`).run(past, request.requestId);

    const ap = codeOf(() => h.rt.approvals.approve(request.requestId, 'human'));
    expect(ap.code).toBe('timeout_applied');
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 未被误终局
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('pending'); // 未误写裁决
  });
});

describe('§4.6 用例 4：任务被 cancel 后（superseded）approve 到达', () => {
  it('graceful cancel 挂起任务 → pending 置 superseded → approve → already_decided（decision=superseded）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId, request } = await driveToPaused(h, 'at-sup');
    h.rt.tasks.cancel(taskId, 'user'); // graceful：立即迁移 + supersedePending
    expect(h.rt.tasks.getTask(taskId).status).toBe('cancelled');
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('superseded');

    const ap = codeOf(() => h.rt.approvals.approve(request.requestId, 'human'));
    expect(ap.code).toBe('already_decided');
    expect(ap.detail?.decision).toBe('superseded'); // 无假裁决：不产生 approved/denied（A3 §2）
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('superseded');
  });
});

describe('§4.6 用例 5：resume 侧反序——裁决方先胜（deny 终局）后 task run --resume', () => {
  it('任务已 Cancelled → --resume 非 Paused 结构化错误，不复活任务', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    const { taskId, request } = await driveToPaused(h, 'at-resrev');
    h.rt.approvals.deny(request.requestId, 'human'); // 裁决方先胜：Cancelled(approval_denied)
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/resume|Paused|Cancelled/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('cancelled'); // 终局不复活
    expect(h.rt.approvals.pendingForTask(taskId)).toBeNull();
  });

  it('对照：非终态非法 resume 目标（Running 语义同族）——非 Paused 即结构化拒绝', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'at-resrev-2' }));
    const taskId = h.rt.tasks.createTask('at-resrev-2', validInput, 't');
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/resume|Paused/);
  });
});
