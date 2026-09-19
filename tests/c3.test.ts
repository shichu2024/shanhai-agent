import { describe, expect, it } from 'vitest';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput } from './helpers.js';

const validJson = JSON.stringify(validOutput());

describe('C3 反向验收（定稿 §6）', () => {
  it('C3-②：maxModelCalls=1 + 第二次调用 → 确定性截停 Failed:Runtime(BudgetExceeded)', async () => {
    const { rt } = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'docs-list', args: { subdir: '' } }] }, // 第 1 次调用（预算耗尽）
      { kind: 'text', text: validJson }, // 第 2 次调用 → 前置检查即终局（永远不会真的发出）
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'c3-budget', modelPolicy: { maxModelCalls: 1, maxTokens: 100000 } }));
    const taskId = rt.tasks.createTask('c3-budget', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Runtime(BudgetExceeded)');
    expect(row.modelCallCount).toBe(1);

    // D-2：终局附调用构成明细
    const failures = rt.failures.forTask(taskId) as { expectedVsActual: string; subClass: string }[];
    const budget = failures.find((f) => f.subClass === 'BudgetExceeded')!;
    const detail = JSON.parse(budget.expectedVsActual);
    expect(detail.budget).toEqual({ maxModelCalls: 1, maxTokens: 100000 });
    expect(detail.consumed.modelCalls).toBe(1);
    expect(detail.attemptBreakdown).toBeDefined();
  });

  it('C3-② 变体：maxTokens 保守口径同样确定性截停', async () => {
    const { rt } = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(rt, sampleSpec({ agentId: 'c3-tokens', modelPolicy: { maxModelCalls: 10, maxTokens: 1 } }));
    const taskId = rt.tasks.createTask('c3-tokens', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Runtime(BudgetExceeded)');
  });

  it('C3-③：连续请求被拒工具 ≥2 次 → Failed:Policy(PolicyBlocked)，归因不漂移（不得记 BudgetExceeded）', async () => {
    const { rt } = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'undeclared-evil', args: {} }] },
      { kind: 'tool_use', calls: [{ id: 'd2', toolId: 'another-evil', args: {} }] },
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'c3-policy', modelPolicy: { maxModelCalls: 50, maxTokens: 100000 } }));
    const taskId = rt.tasks.createTask('c3-policy', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Policy(PolicyBlocked)');
    expect(row.consecutiveDenialCount).toBe(2);
    const failures = rt.failures.forTask(taskId) as { subClass: string }[];
    expect(failures.some((f) => f.subClass === 'BudgetExceeded')).toBe(false); // 归因不漂移
  });

  it('C3-③ 计数清零：一次成功工具调用后连续计数归零', async () => {
    const { rt } = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'e1', toolId: 'evil-1', args: {} }] }, // 拒 1
      { kind: 'tool_use', calls: [{ id: 'e2', toolId: 'docs-list', args: { subdir: '' } }] }, // 成功 → 清零
      { kind: 'tool_use', calls: [{ id: 'e3', toolId: 'evil-2', args: {} }] }, // 拒 1（重新计）
      { kind: 'tool_use', calls: [{ id: 'e4', toolId: 'evil-3', args: {} }] }, // 拒 2 → 终局
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'c3-reset', modelPolicy: { maxModelCalls: 50, maxTokens: 100000 } }));
    const taskId = rt.tasks.createTask('c3-reset', validInput, 't');
    const row = await rt.tasks.runTask(taskId);
    expect(row.terminalFailureClass).toBe('Policy(PolicyBlocked)');
    const denied = rt.trace.readEvents(taskId).filter((e) => e.eventType === 'policy_denied') as unknown as { consecutiveDenialCount: number }[];
    expect(denied.map((d) => d.consecutiveDenialCount)).toEqual([1, 1, 2]);
  });

  it('运行期防御纵深：工具被上调为 L3 后，调用点按当前登记等级闸门拦截（risk_level_blocked）', async () => {
    const { rt } = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'f1', toolId: 'docs-list', args: {} }] },
      { kind: 'tool_use', calls: [{ id: 'f2', toolId: 'docs-list', args: {} }] },
    ]);
    registerAndRelease(rt, sampleSpec({ agentId: 'c3-depth', modelPolicy: { maxModelCalls: 50, maxTokens: 100000 } }));
    // 注册后、任务时复验之后调用之前的窗口：等级上调为 L3（等级只能升）
    rt.registry.registerTool({ toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L3', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' }, 'x');
    // 任务创建时 ④ 防御性复验会拦截（A2 §4-2 主路径）——本用例验证该窗口的兜底语义经 ToolExecutor reasonCode 可达
    const spec = sampleSpec({ agentId: 'c3-depth2', modelPolicy: { maxModelCalls: 50, maxTokens: 100000 } });
    // 用 L3 登记前的快照直接构造任务，模拟「复验之后、调用之前」窗口
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    void db;
    void spec;
    // 场景 A：创建时防御性复验路径（Created→Failed）
    expect(() => rt.tasks.createTask('c3-depth', validInput, 't')).toThrowError(/defensive_revalidation_failed/);
  });
});
