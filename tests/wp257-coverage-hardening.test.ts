import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { InProcMcpTransport, McpClient } from '../src/mcp/client.js';
import { ToolExecutor, PolicyBlockedError } from '../src/modules/toolExecutor.js';
import {
  makeHarness, sampleSpec, registerAndRelease, validInput, validOutput,
  registerL3Tool, approvalSpec, type Harness,
} from './helpers.js';

// wp257（第四十五批 · 覆盖加固蓄余量）：纯测试触达的低风险只读/错误分支补测。
// 覆盖面分组：taskManager 错误分支 ×8 / approval 错误分支 ×2 / toolExecutor 闸门与实现解析 ×2 / mcp client 错误响应 ×1（合计 13）。
// 注意：toolExecutor.ts L213 仍未覆盖（该文件 119/120）——本文件不构成其全覆盖证据，防后续批次误判（第四十六批 TASK-258 注释修正备案）。
// 零 src 改动、零门值改动、零既有用例改动。

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 驱动到 Paused：模型请求 L3 工具 → 挂起即退出（runTask 返回 Paused 行） */
async function driveToPaused(h: Harness, agentId: string) {
  registerL3Tool(h);
  registerAndRelease(h.rt, approvalSpec(agentId));
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(taskId);
  expect(row.status).toBe('paused');
  const request = h.rt.approvals.pendingForTask(taskId)!;
  expect(request).not.toBeNull();
  return { taskId, request };
}

describe('wp257 覆盖加固：taskManager 错误分支', () => {
  it('runTask 拒绝非 Queued 任务（cancelled → 仅 Queued 可执行）', async () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp257-notq' }));
    const taskId = h.rt.tasks.createTask('wp257-notq', validInput, 't');
    h.rt.tasks.cancel(taskId, 'user');
    expect(h.rt.tasks.getTask(taskId).status).toBe('cancelled');
    await expect(h.rt.tasks.runTask(taskId)).rejects.toThrowError(/仅 Queued 可执行/);
  });

  it('runDelegatedChild 拒绝非 Queued 任务（仅 Queued 可嵌套执行）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp257-deleg' }));
    const taskId = h.rt.tasks.createTask('wp257-deleg', validInput, 't');
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded');
    await expect(h.rt.tasks.runDelegatedChild(taskId, { requested: () => false })).rejects.toThrowError(/仅 Queued 可嵌套执行/);
  });

  it('cancel 终态任务（succeeded）→ 不可取消', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp257-term' }));
    const taskId = h.rt.tasks.createTask('wp257-term', validInput, 't');
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded');
    expect(() => h.rt.tasks.cancel(taskId, 'user')).toThrowError(/不可取消/);
  });

  it('resume 非 Paused 且无 pending 审批 → --resume 仅适用于 Paused', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp257-rs-no' }));
    const taskId = h.rt.tasks.createTask('wp257-rs-no', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/--resume 仅适用于 Paused/);
  });

  it('resume 非 Paused 但审批仍 pending → 先 approval approve/deny', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'wp257-rs-pend');
    h.rt.approvals.approve(request.requestId, 'human');
    const versionId = h.rt.tasks.getTask(taskId).agentVersionId;
    // 世界漂移形态：新一轮挂起点的 pending 请求已存在，但任务已离开 Paused（并发取走）
    dbOf(h.rt).prepare(
      `INSERT INTO approval_request (requestId, taskId, agentVersionId, toolId, riskLevel, requestedAt, decision, timeoutAt, callRef)
       VALUES (?,?,?,?,'L3',?,'pending',?,?)`,
    ).run('wp257-r2', taskId, versionId, 'l3-op', new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString(), '2');
    dbOf(h.rt).prepare(`UPDATE task_record SET status = 'running' WHERE taskId = ?`).run(taskId);
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/审批仍 pending/);
  });

  it('resume：approved 但 PauseSnapshot 已删 → 快照缺失（任务留 Paused）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'wp257-rs-miss');
    h.rt.approvals.approve(request.requestId, 'human');
    h.rt.approvals.deleteSnapshot(taskId);
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/PauseSnapshot 缺失或损坏/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 错误路径不迁移状态
  });

  it('resume：快照损坏（结构不完整 / 非法 JSON）→ 结构化拒绝（任务留 Paused）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'wp257-rs-corrupt');
    h.rt.approvals.approve(request.requestId, 'human');
    const counters = JSON.stringify({ modelCallNo: 1, toolCallNo: 1 });
    // 形态一：可解析但 messages 非数组（结构不完整）
    h.rt.approvals.saveSnapshot(taskId, JSON.stringify({ messages: 'not-array', assistantToolCalls: [] }), counters, '1');
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/结构不完整/);
    // 形态二：非法 JSON（parse 即抛）
    h.rt.approvals.saveSnapshot(taskId, '{not-json', counters, '1');
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/PauseSnapshot 损坏/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 两次失败均不迁移状态
  });

  it('resume：快照 nextCallRef 无对应 approved 请求 → 不放行（历史 approved 不放行新一轮）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'wp257-rs-anchor');
    h.rt.approvals.approve(request.requestId, 'human');
    // 锚点漂移形态：nextCallRef 指向无任何请求的调用键（每次 L3 调用独立审批）
    h.rt.approvals.saveSnapshot(taskId, JSON.stringify({ messages: [], assistantToolCalls: [] }), JSON.stringify({ modelCallNo: 1, toolCallNo: 1 }), '424242');
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/无 decision=approved 的审批请求/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  });
});

describe('wp257 覆盖加固：approval 错误分支', () => {
  it('show()：快照 contextJson 非法 JSON → argsDigest 兜底 null（不抛出）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'wp257-show');
    h.rt.approvals.saveSnapshot(taskId, '{not-json', JSON.stringify({ modelCallNo: 1, toolCallNo: 1 }), '1');
    const view = h.rt.approvals.show(request.requestId) as { request: { taskId: string }; argsDigest: string | null };
    expect(view.request.taskId).toBe(taskId);
    expect(view.argsDigest).toBeNull(); // 非法 JSON 静默兜底（digest 不可得而非报错）
  });

  it('approve：request.agentVersionId 与 TaskRecord 不一致 → version_mismatch', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'wp257-vmsg');
    const drifted = '11111111-2222-3333-4444-555555555555';
    dbOf(h.rt).prepare(`UPDATE approval_request SET agentVersionId = ? WHERE requestId = ?`).run(drifted, request.requestId);
    expect(() => h.rt.approvals.approve(request.requestId, 'human')).toThrowError(/version_mismatch|不一致/);
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('pending'); // 未落库任何裁决
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  });
});

describe('wp257 覆盖加固：toolExecutor 闸门与实现解析', () => {
  it('工具已声明登记但运行时未挂实现且无 external 分派 → PolicyBlockedError（Runtime internal 内部缺陷信号）', async () => {
    const h = makeHarness();
    h.rt.registry.registerTool(
      { toolId: 'noimpl-op', name: 'noimpl-op', kind: 'builtin', riskLevel: 'L0', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' },
      'test',
    );
    // 无 externalCall 形态（组合根未接 MCP 桥）：impls Miss 且无分派 → resolveImpl undefined
    const exec = new ToolExecutor({
      base: { taskId: 'wp257-noimpl', agentId: 'a', agentVersionId: 'v', specContentHash: 'h' },
      trace: h.rt.trace,
      getTool: (id) => h.rt.registry.getTool(id),
      impls: new Map(),
      declared: [{ toolId: 'noimpl-op', riskLevel: 'L0' }],
      maxConsecutiveDenials: 3, maxAttempts: 1, toolTimeoutMs: 1000,
      getDenialCount: () => 0, setDenialCount: () => {},
    });
    const err = await exec.execute(1, 'noimpl-op', {}).catch((e) => e as PolicyBlockedError);
    expect(err).toBeInstanceOf(PolicyBlockedError);
    expect((err as Error).message).toMatch(/无实现挂载/);
    // 留痕：tool_call_requested 先行（请求可见，失败可归因）
    const types = h.rt.trace.readEvents('wp257-noimpl').map((e) => e.eventType);
    expect(types).toContain('tool_call_requested');
  });

  it('创建后等级上调 L4 → 运行期闸门兜底拒绝（denied 非终局，任务续跑成功）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l4-op', args: {} }] },
      { kind: 'text', text: validJson },
    ]);
    h.rt.registry.registerTool(
      { toolId: 'l4-op', name: 'l4-op', kind: 'builtin', riskLevel: 'L0', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' },
      'test',
    );
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp257-l4', tools: [{ toolId: 'l4-op', riskLevel: 'L0' }] }));
    const taskId = h.rt.tasks.createTask('wp257-l4', validInput, 't'); // 创建时 L0 防御校验通过
    // 世界漂移：创建后等级上调 L4（注册即拒为主路径，运行期闸门为兜底）
    h.rt.registry.registerTool(
      { toolId: 'l4-op', name: 'l4-op', kind: 'builtin', riskLevel: 'L4', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' },
      'lib-maintainer',
    );
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded'); // 单次 denial 不终局，模型收到结构化反馈后续跑
    const denied = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'policy_denied') as unknown as { toolId: string; reasonCode: string; message: string };
    expect(denied.toolId).toBe('l4-op');
    expect(denied.reasonCode).toBe('risk_level_blocked');
    expect(denied.message).toMatch(/L4/);
  });
});

describe('wp257 覆盖加固：mcp client 错误响应', () => {
  it('InProcMcpTransport handler 异常 → 结构化 JSON-RPC error（-32603），client reject', async () => {
    const transport = new InProcMcpTransport(async () => {
      throw new Error('wp257 server boom');
    });
    const client = new McpClient();
    client.attach(transport);
    await expect(client.request('initialize', {})).rejects.toThrowError(/MCP -32603: wp257 server boom/);
    await client.close();
  });
});
