import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { buildAgentReport } from '../src/modules/report.js';
import {
  makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, registerL3Tool, approvalSpec, validationDepsOf,
} from './helpers.js';

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function setRoll(rt: Runtime, roll: number): void {
  (rt.tasks as unknown as { deps: { dispatchRoll?: () => number } }).deps.dispatchRoll = () => roll;
}

/** 灰度基座：v1 Released（current）+ v2 Released --no-pointer */
function setupTwoVersions(h: ReturnType<typeof makeHarness>, agentId: string): { v1: string; v2: string } {
  const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId }), 'a', validationDepsOf(h.rt));
  h.rt.registry.release(agentId, v1, 'a');
  const v2Spec = sampleSpec({ agentId, modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } });
  const v2 = h.rt.registry.registerSpec(v2Spec, 'a', validationDepsOf(h.rt));
  h.rt.registry.release(agentId, v2, 'a', { noPointer: true });
  return { v1, v2 };
}

describe('DoD-⑤ report：分组判据 + insufficient-sample + 旁挂三单列', () => {
  it('分组正确 + insufficient-sample：金丝雀样本 <20 → 显式输出（系统不假装给了答案）', async () => {
    const h = makeHarness(
      [{ kind: 'text', text: validJson }, { kind: 'text', text: validJson }, { kind: 'text', text: validJson }, { kind: 'text', text: validJson }, { kind: 'text', text: validJson }],
    );
    const { v2 } = setupTwoVersions(h, 'rp-a');
    h.rt.registry.canarySet('rp-a', v2, 50, 'op');
    setRoll(h.rt, 99); // stable ×3
    for (let i = 0; i < 3; i++) {
      const t = h.rt.tasks.createTask('rp-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    setRoll(h.rt, 0); // canary ×2
    for (let i = 0; i < 2; i++) {
      const t = h.rt.tasks.createTask('rp-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.groups.find((g) => g.assignmentSource === 'stable')!).toMatchObject({ tasks: 3, succeeded: 3, contractFailures: 0, contractPassRate: 1 });
    expect(report.groups.find((g) => g.assignmentSource === 'canary')!).toMatchObject({ tasks: 2, succeeded: 2, contractPassRate: 1 });
    expect(report.promoteCriteria.status).toBe('insufficient-sample'); // 样本 2 < 20
    expect(report.promoteCriteria.canarySample).toBe(2);
  });

  it('promote-recommended：样本 ≥20 且通过率 ≥ stable − 5pp', async () => {
    const h = makeHarness([], process.cwd(), { dispatchRoll: () => 0 });
    const { v2 } = setupTwoVersions(h, 'rp-a');
    // 先积累 stable 基线（canary 未设置 → 全部 stable）
    h.provider.script = Array.from({ length: 2 }, () => ({ kind: 'text' as const, text: validJson }));
    for (let i = 0; i < 2; i++) {
      const t = h.rt.tasks.createTask('rp-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    h.rt.registry.canarySet('rp-a', v2, 100, 'op');
    h.provider.script.push(...Array.from({ length: 25 }, () => ({ kind: 'text' as const, text: validJson })));
    for (let i = 0; i < 25; i++) {
      const t = h.rt.tasks.createTask('rp-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.groups.find((g) => g.assignmentSource === 'canary')!).toMatchObject({ tasks: 25, contractPassRate: 1 });
    expect(report.groups.find((g) => g.assignmentSource === 'stable')!.contractPassRate).toBe(1);
    expect(report.promoteCriteria.status).toBe('promote-recommended');
  });

  it('below-threshold：金丝雀契约失败率 100% → 跌破 stable − 5pp', async () => {
    const h = makeHarness([], process.cwd(), { dispatchRoll: () => 0 });
    const { v2 } = setupTwoVersions(h, 'rp-a');
    // stable 基线 ×1 成功（canary 未设置）
    h.provider.script.push({ kind: 'text', text: validJson });
    const t0 = h.rt.tasks.createTask('rp-a', validInput, 't');
    await h.rt.tasks.runTask(t0);
    h.rt.registry.canarySet('rp-a', v2, 100, 'op');
    const failing = JSON.stringify({ broken: true });
    for (let i = 0; i < 20; i++) {
      h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
      const t = h.rt.tasks.createTask('rp-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }

    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.promoteCriteria.status).toBe('below-threshold');
    expect(report.promoteCriteria.canaryPassRate).toBe(0);
    expect(report.groups.find((g) => g.assignmentSource === 'canary')!.contractFailures).toBe(20);
  });

  it('insufficient-sample（无 stable 基线）：canary 样本足但对照组为空 → 不假装给答案', async () => {
    const h = makeHarness([], process.cwd(), { dispatchRoll: () => 0 });
    const { v2 } = setupTwoVersions(h, 'rp-a');
    h.rt.registry.canarySet('rp-a', v2, 100, 'op');
    h.provider.script.push(...Array.from({ length: 25 }, () => ({ kind: 'text' as const, text: validJson })));
    for (let i = 0; i < 25; i++) {
      const t = h.rt.tasks.createTask('rp-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.promoteCriteria.status).toBe('insufficient-sample'); // stable 基线 0——不输出判据结论
  });

  it('旁挂单列：审批超时计数（不进 C2 失败率但必须可见）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('rp-a'));
    const taskId = h.rt.tasks.createTask('rp-a', validInput, 't');
    await h.rt.tasks.runTask(taskId); // paused
    dbOf(h.rt).prepare(`UPDATE approval_request SET timeoutAt='2020-01-01T00:00:00.000Z' WHERE taskId=?`).run(taskId);
    h.rt.approvals.applyLazyTimeouts(); // → cancelled(approval_timeout)

    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.sideColumns.approvalTimeoutCount).toBe(1);
    expect(report.groups.find((g) => g.assignmentSource === 'stable')!.contractFailures).toBe(0); // 超时是治理惰性非任务失败
  });

  it('旁挂单列：受工具升级影响的 Spec（R-5：Spec 声明等级 < 当前登记等级）', () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rp-a' })); // 声明 docs-list L0
    h.rt.registry.registerTool(
      { toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L1', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' },
      'lib',
    ); // 升级 L0→L1
    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.sideColumns.toolUpgradeAffectedSpecs).toEqual([
      expect.objectContaining({ toolId: 'docs-list', declared: 'L0', current: 'L1' }),
    ]);
  });

  it('旁挂单列：staleQueued/stalePaused 只读汇总 + --since 口径分组', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('rp-a'));
    const pausedId = h.rt.tasks.createTask('rp-a', validInput, 't');
    await h.rt.tasks.runTask(pausedId); // paused 且已超时未惰性判定
    dbOf(h.rt).prepare(`UPDATE approval_request SET timeoutAt='2020-01-01T00:00:00.000Z' WHERE taskId=?`).run(pausedId);

    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.sideColumns.stale.paused).toBe(1);
    expect(report.sideColumns.stale.queued).toBe(0);

    const future = buildAgentReport(dbOf(h.rt), 'rp-a', { since: '2999-01-01T00:00:00Z' });
    expect(future.groups.every((g) => g.tasks === 0)).toBe(true);
  });

  it('no-canary：无灰度进行中 → 显式状态（不输出判据数字结论）', () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rp-a' }));
    const report = buildAgentReport(dbOf(h.rt), 'rp-a');
    expect(report.promoteCriteria.status).toBe('no-canary');
  });
});
