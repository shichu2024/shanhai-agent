import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { REVIEW_ITEMS } from '../src/modules/registry.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf } from './helpers.js';

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 灰度基座：v1 Released（current）+ v2 Released --no-pointer（canary 候选） */
function setupCanaryHarness(h: ReturnType<typeof makeHarness>): { v1: string; v2: string } {
  const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'cn-a' }), 'a', validationDepsOf(h.rt));
  h.rt.registry.release('cn-a', v1, 'a');
  const v2Spec = sampleSpec({ agentId: 'cn-a', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } });
  const v2 = h.rt.registry.registerSpec(v2Spec, 'a', validationDepsOf(h.rt));
  h.rt.registry.release('cn-a', v2, 'a', { noPointer: true });
  return { v1, v2 };
}

describe('DoD-④ 灰度分派（D-12：双指针 + 权重 + assignmentSource 留痕）', () => {
  it('weight=0（缺省）→ 全部 stable（第一阶段行为不变）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }, { kind: 'text', text: validJson }]);
    const { v1, v2 } = setupCanaryHarness(h);
    void v2;
    const t1 = h.rt.tasks.createTask('cn-a', validInput, 't');
    const t2 = h.rt.tasks.createTask('cn-a', validInput, 't');
    for (const t of [t1, t2]) {
      expect(h.rt.tasks.getTask(t).assignmentSource).toBe('stable');
      expect(h.rt.tasks.getTask(t).agentVersionId).toBe(v1);
    }
  });

  it('weight=100 → 全部 canary；weight=0 显式 set 后仍 stable（roll 不参与）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }], process.cwd(), { dispatchRoll: () => 0 });
    const { v1, v2 } = setupCanaryHarness(h);
    h.rt.registry.canarySet('cn-a', v2, 0, 'op'); // weight=0 = 无灰度
    const t1 = h.rt.tasks.createTask('cn-a', validInput, 't');
    expect(h.rt.tasks.getTask(t1).assignmentSource).toBe('stable');

    h.rt.registry.canarySet('cn-a', v2, 100, 'op');
    const t2 = h.rt.tasks.createTask('cn-a', validInput, 't');
    expect(h.rt.tasks.getTask(t2).assignmentSource).toBe('canary');
    expect(h.rt.tasks.getTask(t2).agentVersionId).toBe(v2);
    void v1;
  });

  it('weight=50：roll<w → canary；roll≥w → stable（边界严格）', async () => {
    const rolls: number[] = [];
    const h = makeHarness(
      [{ kind: 'text', text: validJson }, { kind: 'text', text: validJson }],
      process.cwd(),
      {
        dispatchRoll: () => (rolls.length === 0 ? 49 : 50),
      },
    );
    const { v1, v2 } = setupCanaryHarness(h);
    h.rt.registry.canarySet('cn-a', v2, 50, 'op');
    const t1 = h.rt.tasks.createTask('cn-a', validInput, 't');
    rolls.push(1);
    const t2 = h.rt.tasks.createTask('cn-a', validInput, 't');
    expect(h.rt.tasks.getTask(t1).assignmentSource).toBe('canary'); // roll=49 < 50
    expect(h.rt.tasks.getTask(t1).agentVersionId).toBe(v2);
    expect(h.rt.tasks.getTask(t2).assignmentSource).toBe('stable'); // roll=50 ≱ < 50
    expect(h.rt.tasks.getTask(t2).agentVersionId).toBe(v1);
  });

  it('task_created 载荷留痕：assignmentSource + 当时双指针值（可回溯「为什么进了金丝雀」）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }], process.cwd(), { dispatchRoll: () => 10 });
    const { v1, v2 } = setupCanaryHarness(h);
    h.rt.registry.canarySet('cn-a', v2, 30, 'op');
    const taskId = h.rt.tasks.createTask('cn-a', validInput, 't');
    const created = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_created') as unknown as {
      assignmentSource: string;
      dispatchSnapshot: { stableVersionId: string | null; canaryVersionId: string | null; canaryWeight: number };
    };
    expect(created.assignmentSource).toBe('canary'); // roll=10 < 30
    expect(created.dispatchSnapshot).toEqual({ stableVersionId: v1, canaryVersionId: v2, canaryWeight: 30 });
  });

  it('显式 --draft/--reviewed 不参与灰度分派（assignmentSource=explicit）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }], process.cwd(), { dispatchRoll: () => 0 });
    const { v1, v2 } = setupCanaryHarness(h);
    h.rt.registry.canarySet('cn-a', v2, 100, 'op');
    // 指针 v1 为 released；显式路径绑定指针版本（本库无 draft 指针语义——断言 explicit 标记与固化）
    const taskId = h.rt.tasks.createTask('cn-a', validInput, 't', { allowDraft: true });
    expect(h.rt.tasks.getTask(taskId).assignmentSource).toBe('explicit');
  });

  it('canary set 约束：目标非 Released / = current / weight 越界 → 结构化拒绝 + 审计', () => {
    const h = makeHarness();
    const { v1 } = setupCanaryHarness(h);
    const draft = h.rt.registry.registerSpec(sampleSpec({ agentId: 'cn-a', modelPolicy: { maxModelCalls: 12, maxTokens: 100000 } }), 'a', validationDepsOf(h.rt));
    expect(() => h.rt.registry.canarySet('cn-a', draft, 50, 'op')).toThrowError(/Released/);
    expect(() => h.rt.registry.canarySet('cn-a', v1, 50, 'op')).toThrowError(/current/); // = current 拒绝
    const v2Spec = sampleSpec({ agentId: 'cn-a', modelPolicy: { maxModelCalls: 13, maxTokens: 100000 } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 'a', validationDepsOf(h.rt));
    h.rt.registry.release('cn-a', v2, 'a', { noPointer: true });
    expect(() => h.rt.registry.canarySet('cn-a', v2, 101, 'op')).toThrowError(/0-100/);
    const rejected = dbOf(h.rt).prepare(`SELECT COUNT(*) c FROM audit_events WHERE kind='cli_operation' AND target LIKE 'cn-a/%'`).get() as { c: number };
    expect(rejected.c).toBeGreaterThanOrEqual(3);
  });

  it('release --no-pointer → canary set → promote 全链（DoD-④ 全链单测）', () => {
    const h = makeHarness();
    const { v1, v2 } = setupCanaryHarness(h);
    // 结构入口：v2 已 release --no-pointer（current 仍指 v1）
    expect(h.rt.registry.getPointer('cn-a')).toBe(v1);
    expect(h.rt.registry.getVersion(v2)!.status).toBe('released');
    // canary set
    h.rt.registry.canarySet('cn-a', v2, 50, 'op');
    expect(h.rt.registry.getCanary('cn-a')).toEqual({ canaryVersionId: v2, canaryWeight: 50 });
    // promote：current 指针移至 canary 版本 + canary 清零 + version_promoted 审计
    const promoted = h.rt.registry.promote('cn-a', 'op');
    expect(promoted).toBe(v2);
    expect(h.rt.registry.getPointer('cn-a')).toBe(v2);
    expect(h.rt.registry.getCanary('cn-a')).toEqual({ canaryVersionId: null, canaryWeight: 0 });
    const events = (dbOf(h.rt).prepare(`SELECT eventType FROM audit_events WHERE agentVersionId IN (?,?) ORDER BY whenAt`).all(v1, v2) as { eventType: string }[]).map((r) => r.eventType);
    expect(events).toContain('canary_configured');
    expect(events).toContain('version_promoted');
    expect(events.filter((e) => e === 'version_released').length).toBeGreaterThanOrEqual(2); // v1 直发 + v2 --no-pointer
  });

  it('canary clear：归零立即 + 审计；deprecate canary 目标 → 拒绝（P2-6 同规则）', () => {
    const h = makeHarness();
    const { v2 } = setupCanaryHarness(h);
    h.rt.registry.canarySet('cn-a', v2, 40, 'op');
    expect(() => h.rt.registry.deprecate('cn-a', v2, 'op')).toThrowError(/canary/); // 先 clear 或换目标
    h.rt.registry.canaryClear('cn-a', 'op');
    expect(h.rt.registry.getCanary('cn-a')).toEqual({ canaryVersionId: null, canaryWeight: 0 });
    h.rt.registry.deprecate('cn-a', v2, 'op'); // clear 后可 deprecate
    expect(h.rt.registry.getVersion(v2)!.status).toBe('deprecated');
  });

  it('分派固化：指针移动后已创建任务的 agentVersionId 不变（版本绑定原则）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }], process.cwd(), { dispatchRoll: () => 99 });
    const { v1, v2 } = setupCanaryHarness(h);
    h.rt.registry.canarySet('cn-a', v2, 50, 'op'); // roll=99 ≱ 50 → stable v1
    const taskId = h.rt.tasks.createTask('cn-a', validInput, 't');
    expect(h.rt.tasks.getTask(taskId).agentVersionId).toBe(v1);
    h.rt.registry.promote('cn-a', 'op'); // 指针移到 v2
    expect(h.rt.tasks.getTask(taskId).agentVersionId).toBe(v1); // 已创建任务不动
  });
});

// 复用 REVIEW_ITEMS 断言（批次一 reviewed 全链已在 reviewed.test.ts 覆盖；此处仅确认 canary 入口结构可达）
void REVIEW_ITEMS;
