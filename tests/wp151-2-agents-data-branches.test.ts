import { describe, expect, it } from 'vitest';
import {
  cardUiOf,
  insightUiOf,
  reportUiOf,
  trendBarsOf,
  trendSummaryOf,
} from '../src/portal/ui/agentsData.js';

// 每日优化第十二批（TASK-151）：agentsData.ts 分支覆盖加固（基线分支 68.18%）。
// 未覆盖段 = 形状防御的回退侧（213-219 trendBarsOf 桶级守卫 / 249-267 reportUiOf 兜底，
// 及 cardUiOf/insightUiOf/trendSummaryOf 的类型回退三分支）。全部为「形状异常不假装渲染」
// 语义（7-4 口径），断言回退后的展示值，不为凑覆盖写空转断言。

describe('wp151 trendBarsOf：桶级形状守卫回退（agentsData.ts:212-231）', () => {
  it('非 record 桶（null/标量）被过滤；key 非字符串 → 空串；tasks 非记录 → 五键全 0 + 「—」', () => {
    const bars = trendBarsOf([
      null,
      42,
      { key: 123, tasks: 'not-a-record' },
      { key: 'kb', tasks: { total: 'x', succeeded: null, excludedCancelled: undefined, contractFailures: false, contractPassRate: null } },
      { key: 'kmax', tasks: { total: 4, succeeded: 4, excludedCancelled: 0, contractFailures: 0, contractPassRate: 1 } },
    ] as unknown as ReadonlyArray<Record<string, unknown>>);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ key: '', total: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, rateLabel: '—', heightPct: 0 });
    expect(bars[1]).toMatchObject({ key: 'kb', total: 0, rateLabel: '—', heightPct: 0 });
    expect(bars[2]).toMatchObject({ key: 'kmax', total: 4, rateLabel: '1.000', heightPct: 100 });
  });

  it('缺少 tasks 键的桶 → 同样回退五键 0', () => {
    const bars = trendBarsOf([{ key: 'k' }] as ReadonlyArray<Record<string, unknown>>);
    expect(bars[0]).toMatchObject({ key: 'k', total: 0, rateLabel: '—', heightPct: 0 });
  });
});

describe('wp151 trendSummaryOf：最新桶形状回退（agentsData.ts:182-194）', () => {
  it('最新桶 tasks 非记录 → rateLabel「—（无分母不假装）」；key 非字符串 → latestKey null', () => {
    const s = trendSummaryOf({ agentId: 'ag-1', bucket: 'day', buckets: [{ key: 'ok', tasks: { contractPassRate: 1 } }, { tasks: 'not-a-record' }] });
    expect(s.hasData).toBe(true);
    expect(s.latestKey).toBeNull();
    expect(s.latestRateLabel).toBe('—（无分母不假装）');
  });

  it('最新桶 rate 为 null → 同口径「—（无分母不假装）」（contractPassRate null 桶不假装）', () => {
    const s = trendSummaryOf({ agentId: 'ag-1', bucket: 'day', buckets: [{ key: 'k', tasks: { contractPassRate: null } }] });
    expect(s.latestRateLabel).toBe('—（无分母不假装）');
  });
});

describe('wp151 reportUiOf：五键兜底回退（agentsData.ts:248-269）', () => {
  it('最小 record（各治理区全缺）→ 全兜底：groupCount 0 / promoteLabel 空串 / 超时 0 / 未触发 / note 空串', () => {
    const s = reportUiOf({});
    expect(s).not.toBeNull();
    expect(s!.agentId).toBe('');
    expect(s!.groupCount).toBe(0);
    expect(s!.promoteLabel).toBe('');
    expect(s!.approvalTimeoutCount).toBe(0);
    expect(s!.healthTriggered).toBe(false);
    expect(s!.healthNote).toBe('');
  });

  it('治理区类型异常（groups/promoteCriteria/sideColumns/healthPanel 非记录）→ 同兜底不崩', () => {
    const s = reportUiOf({ groups: 'nope', promoteCriteria: 'nope', sideColumns: 7, healthPanel: false })!;
    expect(s!.groupCount).toBe(0);
    expect(s!.approvalTimeoutCount).toBe(0);
    expect(s!.healthTriggered).toBe(false);
  });

  it('未知 promote status → 原样透出（词表外不假装翻译）；agentId 非字符串 → 空串', () => {
    const s = reportUiOf({ agentId: 42, promoteCriteria: { status: 'future-status' } })!;
    expect(s!.agentId).toBe('');
    expect(s!.promoteLabel).toBe('future-status');
  });

  it('healthPanel.triggered 非 true / note 非字符串 → false / 空串；approvalTimeoutCount 非数字 → 0', () => {
    const s = reportUiOf({ healthPanel: { triggered: 'yes', note: 5 }, sideColumns: { approvalTimeoutCount: '3' } })!;
    expect(s!.healthTriggered).toBe(false);
    expect(s!.healthNote).toBe('');
    expect(s!.approvalTimeoutCount).toBe(0);
  });
});

describe('wp151 cardUiOf：能力卡形状回退（agentsData.ts:67-105）', () => {
  const BASE = {
    agentId: 'ag-1',
    versionId: 'v-0001',
    tools: [{ toolId: 't-ok', riskLevel: 'L3' }],
    inputContract: { digest: 'd-in', type: 'object' },
    outputContract: { digest: 'd-out', type: 'object' },
  };

  it('可选字段类型异常 → 空串/空数组兜底；坏工具行被过滤、好行保留', () => {
    const ui = cardUiOf({
      ...BASE,
      specVersion: 9,
      contentHash: null,
      mission: 'not-a-record',
      nonGoals: 'not-an-array',
      tools: [
        { toolId: 1, riskLevel: 'L3' },
        { toolId: 't-ok', riskLevel: 2 },
        { toolId: 't-good', riskLevel: 'L0' },
      ],
    });
    expect(ui).not.toBeNull();
    expect(ui!.specVersion).toBe('');
    expect(ui!.contentHash).toBe('');
    expect(ui!.mission).toEqual([]);
    expect(ui!.nonGoals).toEqual([]);
    expect(ui!.tools).toEqual([{ toolId: 't-good', riskLevel: 'L0' }]);
  });

  it('budgets/approvalPolicy 为 undefined（键缺失）→ 「—」（与 null 同口径空位）', () => {
    const ui = cardUiOf(BASE)!;
    expect(ui!.budgetsJson).toBe('—');
    expect(ui!.approvalJson).toBe('—');
    expect(ui!.evolutionJson).toBe('—');
  });

  it('契约摘要缺 type → contractOf null → 整卡 null（不假装渲染）', () => {
    expect(cardUiOf({ ...BASE, inputContract: { digest: 'd-in' } })).toBeNull();
    expect(cardUiOf({ ...BASE, outputContract: { digest: 'd-out' } })).toBeNull();
  });
});

describe('wp151 insightUiOf：洞察区形状回退（agentsData.ts:132-167）', () => {
  const BASE = {
    generatedAt: '2026-10-01T12:00:00.000000000Z',
    declared: {},
    assertions: {
      active: {
        counts: { capability: 2, limitation: 1 },
        entries: [{ capabilityId: 'cap-1', kind: 'capability', statement: 's', origin: 'derived', evidenceCount: 2 }],
      },
      openCandidates: { total: 1, evidencePending: 0 },
      emptyHint: null,
    },
    behavior: { since: '2026-09-01T00:00:00.000000000Z', status: 'ok', insufficientNote: null },
  };

  it('versionId 非字符串 → 空串；counts 非数字 → 0；坏条目被过滤、好条目保留', () => {
    const ui = insightUiOf({
      ...BASE,
      versionId: 9,
      assertions: {
        ...BASE.assertions,
        active: {
          counts: { capability: 'x', limitation: null },
          entries: [
            { capabilityId: 5, kind: 'capability', statement: 's', origin: 'derived', evidenceCount: 1 },
            { capabilityId: 'cap-2', kind: 'limitation', statement: 's2', origin: 'manual' },
            { capabilityId: 'cap-3', kind: 'capability', statement: 's3', origin: 'derived', evidenceCount: 'x' },
          ],
        },
      },
    })!;
    expect(ui).not.toBeNull();
    expect(ui.versionId).toBe('');
    expect(ui.activeCounts).toEqual({ capability: 0, limitation: 0 });
    expect(ui.activeEntries).toEqual([
      { capabilityId: 'cap-2', kind: 'limitation', statement: 's2', origin: 'manual', evidenceCount: 0 },
      { capabilityId: 'cap-3', kind: 'capability', statement: 's3', origin: 'derived', evidenceCount: 0 },
    ]);
  });

  it('openCandidates 数值键非数字 → null；emptyHint/behavior 字段非字符串 → null/空串（不假装）', () => {
    expect(insightUiOf({ ...BASE, assertions: { ...BASE.assertions, openCandidates: { total: 'x', evidencePending: 0 } } })).toBeNull();
    const ui = insightUiOf({
      ...BASE,
      assertions: { ...BASE.assertions, emptyHint: 5 },
      behavior: { since: 1, status: 2, insufficientNote: 3 },
    })!;
    expect(ui.emptyHint).toBeNull();
    expect(ui.behaviorSince).toBe('');
    expect(ui.behaviorStatus).toBe('');
    expect(ui.behaviorInsufficientNote).toBeNull();
  });

  it('结构区缺失（assertions/behavior/generatedAt）→ null（显错误条）', () => {
    expect(insightUiOf({ assertions: BASE.assertions, behavior: BASE.behavior, declared: {} })).toBeNull();
    expect(insightUiOf({ ...BASE, behavior: 'x' })).toBeNull();
    expect(insightUiOf(3)).toBeNull();
  });
});
