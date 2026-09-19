import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { REVIEW_ITEMS } from '../src/modules/registry.js';
import { makeHarness, sampleSpec, validInput, validOutput, registerAndRelease, registerL3Tool, approvalSpec, validationDepsOf } from './helpers.js';

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function allPassChecklist() {
  return REVIEW_ITEMS.map((item) => ({ item, verdict: true }));
}

describe('DoD-⑤ Reviewed 版本环（A5 §1 v1.1，D-10）', () => {
  it('draft→reviewed→released：diff 报告生成 + 逐项确认 + version_reviewed 载荷含清单结果', () => {
    const h = makeHarness();
    // v1：发布基线（docs-list L0，预算 10/100000）
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rv-a' }));
    // v2：工具集变化（新增 L3 审批工具 + 等级上调 docs-list→L2）+ 预算 +100%（>50% 标黄）
    registerL3Tool(h);
    const v2Spec = sampleSpec({
      agentId: 'rv-a',
      tools: [
        { toolId: 'docs-list', riskLevel: 'L2', controlledFields: { paramRanges: { n: { min: 0, max: 10 } } } },
        { toolId: 'l3-op', riskLevel: 'L3' },
      ],
      modelPolicy: { maxModelCalls: 20, maxTokens: 100000 },
      extraTop: { approvalPolicy: { mode: 'onHighRisk' } },
    });
    // v2 声明 docs-list 为 L2，但登记为 L0 → 先把登记升到 L2（等级只能升）
    h.rt.registry.registerTool(
      { toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L2', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' },
      'lib',
    );
    const v2 = h.rt.registry.registerSpec(v2Spec, 'author', validationDepsOf(h.rt));

    // diff 报告：5 项机械生成
    const diff = h.rt.registry.buildReviewDiff('rv-a', v2);
    expect(diff.diffAgainst).toBeTruthy(); // 上一 Released versionId
    const byItem = new Map(diff.items.map((i) => [i.item, i]));
    expect(byItem.get('tools')!.changed).toBe(true);
    expect(byItem.get('tools')!.flag).toBe('red'); // 等级上调标红
    expect(byItem.get('budgets')!.changed).toBe(true);
    expect(byItem.get('budgets')!.flag).toBe('yellow'); // 增幅 >50% 标黄（10→20）
    expect(byItem.get('approvalPolicy')!.changed).toBe(true);
    expect(byItem.get('approvalPolicy')!.flag).toBe('red'); // 新高风险工具准入
    expect(byItem.get('contracts')!.changed).toBe(false);

    // review：5 项逐项确认通过 → reviewed + 审计载荷
    const result = h.rt.registry.review('rv-a', v2, 'reviewer', allPassChecklist(), 'eval-001');
    expect(result.diffAgainst).toBe(diff.diffAgainst);
    expect(h.rt.registry.getVersion(v2)!.status).toBe('reviewed');
    const audit = dbOf(h.rt)
      .prepare(`SELECT * FROM audit_events WHERE eventType = 'version_reviewed' AND agentVersionId = ?`)
      .get(v2) as { payload: string };
    const payload = JSON.parse(audit.payload) as { checklist: { item: string; verdict: boolean }[]; diffAgainst: string; evalId: string | null };
    expect(payload.checklist).toHaveLength(5);
    expect(payload.checklist.every((c) => c.verdict === true)).toBe(true);
    expect(payload.diffAgainst).toBe(diff.diffAgainst);
    expect(payload.evalId).toBe('eval-001');

    // reviewed→released：移指针（Released 可被正式任务绑定）
    h.rt.registry.release('rv-a', v2, 'releaser');
    expect(h.rt.registry.getVersion(v2)!.status).toBe('released');
    expect(h.rt.registry.getPointer('rv-a')).toBe(v2);
  });

  it('无上一 Released 版本：首个发布 diff 基线为 null（5 项仍须确认）', () => {
    const h = makeHarness();
    const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'rv-first' }), 'a', validationDepsOf(h.rt));
    const diff = h.rt.registry.buildReviewDiff('rv-first', v1);
    expect(diff.diffAgainst).toBeNull();
    expect(diff.items).toHaveLength(5);
    h.rt.registry.review('rv-first', v1, 'r', allPassChecklist());
    expect(h.rt.registry.getVersion(v1)!.status).toBe('reviewed');
  });

  it('检视清单任一项不通过 → 拒绝迁移 + RejectedRequest 审计（保持 Draft）', () => {
    const h = makeHarness();
    const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'rv-fail' }), 'a', validationDepsOf(h.rt));
    const checklist = REVIEW_ITEMS.map((item, i) => ({ item, verdict: i !== 3 })); // approvalPolicy 项不通过
    expect(() => h.rt.registry.review('rv-fail', v1, 'r', checklist)).toThrowError(/未通过项/);
    expect(h.rt.registry.getVersion(v1)!.status).toBe('draft');
    expect(
      (dbOf(h.rt).prepare(`SELECT COUNT(*) c FROM audit_events WHERE kind='cli_operation' AND agentVersionId=?`).get(v1) as { c: number }).c,
    ).toBeGreaterThanOrEqual(1);
  });

  it('无回退边：reviewed 不可再 review / 不可退回 Draft；Draft 直发保留', () => {
    const h = makeHarness();
    // 直发保留（第一阶段行为不变）
    const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'rv-direct' }), 'a', validationDepsOf(h.rt));
    h.rt.registry.release('rv-direct', v1, 'r');
    expect(h.rt.registry.getVersion(v1)!.status).toBe('released');
    // reviewed 无回退
    const v2 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'rv-direct', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } }), 'a2', validationDepsOf(h.rt));
    h.rt.registry.review('rv-direct', v2, 'r', allPassChecklist());
    expect(() => h.rt.registry.review('rv-direct', v2, 'r', allPassChecklist())).toThrowError(/draft→reviewed/);
    expect(() => h.rt.registry.release('rv-direct', v1, 'r')).toThrowError(/draft→released|reviewed→released/); // released 无出边（除 deprecate）
  });

  it('release --no-pointer：发布不移指针（canary 入口，D-12）', () => {
    const h = makeHarness();
    const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'rv-nop' }), 'a', validationDepsOf(h.rt));
    h.rt.registry.release('rv-nop', v1, 'r');
    expect(h.rt.registry.getPointer('rv-nop')).toBe(v1);
    const v2Spec = sampleSpec({ agentId: 'rv-nop', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 'a', validationDepsOf(h.rt));
    h.rt.registry.review('rv-nop', v2, 'r', allPassChecklist());
    h.rt.registry.release('rv-nop', v2, 'r', { noPointer: true });
    expect(h.rt.registry.getVersion(v2)!.status).toBe('released');
    expect(h.rt.registry.getPointer('rv-nop')).toBe(v1); // 指针不动
    const audit = dbOf(h.rt).prepare(`SELECT payload FROM audit_events WHERE eventType='version_released' AND agentVersionId=?`).get(v2) as { payload: string };
    expect((JSON.parse(audit.payload) as { noPointer: boolean }).noPointer).toBe(true);
  });

  it('L3 注册准入联动（A2 §4-3）：未声明 approvalPolicy 引用 L3 → 注册拒绝；声明后放行；always 拒绝', () => {
    const h = makeHarness();
    registerL3Tool(h);
    // 未声明 → 拒（防死声明；错误信息指名字段路径，D-1）
    const bare = sampleSpec({ agentId: 'rv-l3-bare', tools: [{ toolId: 'l3-op', riskLevel: 'L3' }] });
    try {
      h.rt.registry.registerSpec(bare, 'a', validationDepsOf(h.rt));
      expect.unreachable('应当注册拒绝');
    } catch (err) {
      expect((err as { issues: { message: string }[] }).issues.some((i) => i.message.includes('L3') || i.message.includes('approvalPolicy'))).toBe(true);
    }
    // mode=never + L3 → 拒（无审批路径）
    const neverSpec = sampleSpec({ agentId: 'rv-l3-never', tools: [{ toolId: 'l3-op', riskLevel: 'L3' }], extraTop: { approvalPolicy: { mode: 'never' } } });
    try {
      h.rt.registry.registerSpec(neverSpec, 'a', validationDepsOf(h.rt));
      expect.unreachable('应当注册拒绝');
    } catch (err) {
      expect((err as { issues: { message: string }[] }).issues.some((i) => i.message.includes('L3') || i.message.includes('onHighRisk'))).toBe(true);
    }
    // mode=always → 拒（防伪声明，D-9；zod 枚举拒绝，错误信息含 always 注册拒绝）
    const alwaysSpec = sampleSpec({ agentId: 'rv-l3-always', tools: [{ toolId: 'docs-list', riskLevel: 'L0' }], extraTop: { approvalPolicy: { mode: 'always' } } });
    try {
      h.rt.registry.registerSpec(alwaysSpec, 'a', validationDepsOf(h.rt));
      expect.unreachable('应当注册拒绝');
    } catch (err) {
      expect((err as { issues: { path: string; message: string }[] }).issues.some((i) => i.path.includes('approvalPolicy') && i.message.includes('always'))).toBe(true);
    }
    // 声明 onHighRisk → 放行
    const versionId = h.rt.registry.registerSpec(approvalSpec('rv-l3-ok'), 'a', validationDepsOf(h.rt));
    expect(h.rt.registry.getVersion(versionId)!.status).toBe('draft');
  });

  it('reviewGate 断言档与默认 manual：evaluationPolicy.reviewGate 字段位接受', () => {
    const h = makeHarness();
    const spec = sampleSpec({ agentId: 'rv-gate', extraTop: { evaluationPolicy: { assertions: [{ path: '$.summary', op: 'nonEmpty' }], reviewGate: 'assertions' } } });
    const versionId = h.rt.registry.registerSpec(spec, 'a', validationDepsOf(h.rt));
    expect(h.rt.registry.getVersion(versionId)!.status).toBe('draft');
    const bad = sampleSpec({ agentId: 'rv-gate-bad', extraTop: { evaluationPolicy: { reviewGate: 'yolo' as unknown as string } } });
    expect(() => h.rt.registry.registerSpec(bad, 'a', validationDepsOf(h.rt))).toThrowError();
  });
});
