import { describe, expect, it } from 'vitest';
import {
  agentCatalogRows,
  insightUiOf,
  trendBarsOf,
  trendSummaryOf,
  cardUiOf,
  reportUiOf,
} from '../src/portal/ui/agentsData.js';

// 第七阶段批次四（7-4/4）：Agent 目录与详情（设计 V0.3 §7.5 FR-AG-1..5）——纯逻辑面。
// 实测形状锚点：insight.ts InsightAnswer / trend.ts CapabilityTrend+TrendBucketRow /
// report.ts ReportAnswer / agentCard.ts AgentCard / api.ts capabilityListRow。
// TDD 红阶段先行：本文件先于实现落库。
// 反思族（reflection）与 attempts 字段零出现（V0.3 删除项）。

const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;
const FORBIDDEN_FIELDS = /reflection|attempts/;

// ---------- 实测形状夹具 ----------

const CARD = {
  agentId: 'ag-1',
  versionId: 'v-0001',
  specVersion: '1',
  contentHash: 'hash-abcdef',
  mission: { responsibilities: ['执行回显工具调用'] },
  nonGoals: ['修改文件内容'],
  tools: [{ toolId: 'echo-echo', riskLevel: 'L3' }],
  inputContract: { digest: 'd-in', type: 'object' },
  outputContract: { digest: 'd-out', type: 'object' },
  budgets: { maxModelCalls: 10 },
  approvalPolicy: { mode: 'onHighRisk' },
  evolutionPolicy: null,
};

const INSIGHT = {
  agentId: 'ag-1',
  versionId: 'v-0001',
  generatedAt: '2026-10-01T12:00:00.000000000Z',
  declared: {
    agentId: 'ag-1',
    versionId: 'v-0001',
    specVersion: '1',
    contentHash: 'hash-abcdef',
    mission: { responsibilities: ['执行回显工具调用'] },
    nonGoals: ['修改文件内容'],
    tools: [{ toolId: 'echo-echo', riskLevel: 'L3' }],
  },
  assertions: {
    active: {
      counts: { capability: 2, limitation: 1 },
      entries: [
        { capabilityId: 'cap-1', kind: 'capability', statement: '能稳定回显', origin: 'derived', evidenceCount: 2 },
        { capabilityId: 'cap-2', kind: 'limitation', statement: '不能改文件', origin: 'derived', evidenceCount: 1 },
        { capabilityId: 'cap-3', kind: 'capability', statement: '并发安全', origin: 'manual', evidenceCount: 0 },
      ],
    },
    openCandidates: { total: 2, evidencePending: 1 },
    emptyHint: null,
  },
  behavior: {
    since: '2026-09-01T00:00:00.000000000Z',
    bucket: 'day',
    buckets: [
      { key: '2026-09-30', tasks: { total: 4, succeeded: 3, excludedCancelled: 1, contractFailures: 1, contractPassRate: 0.667 } },
    ],
    status: 'ok',
    insufficientNote: null,
  },
  limitations: { entries: [], evidenceSummary: {} },
};

const TREND = {
  agentId: 'ag-1',
  bucket: 'day',
  since: null,
  until: '2026-10-01T12:00:00.999999999Z',
  buckets: [
    {
      key: '2026-09-29',
      tasks: { total: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, contractPassRate: null },
      failureBySubClass: {},
      memoryEvents: 0,
      registry: { candidate: 0, active: 0, retired: 0 },
    },
    {
      key: '2026-09-30',
      tasks: { total: 4, succeeded: 3, excludedCancelled: 1, contractFailures: 1, contractPassRate: 0.667 },
      failureBySubClass: { contract: 1 },
      memoryEvents: 2,
      registry: { candidate: 1, active: 0, retired: 0 },
    },
    {
      key: '2026-10-01',
      tasks: { total: 2, succeeded: 2, excludedCancelled: 0, contractFailures: 0, contractPassRate: 1 },
      failureBySubClass: {},
      memoryEvents: 0,
      registry: { candidate: 0, active: 1, retired: 0 },
    },
  ],
  coverage: { memoryFrom: '2026-09-30T01:00:00.000000000Z', note: 'coverage-from-memory:2026-09-30T01:00:00.000000000Z——记忆面自此时间戳起可观测' },
};

const REPORT = {
  agentId: 'ag-1',
  since: null,
  groups: [
    { assignmentSource: 'stable', tasks: 5, succeeded: 4, excludedCancelled: 1, contractFailures: 1, contractPassRate: 0.75 },
    { assignmentSource: 'canary', tasks: 2, succeeded: 2, excludedCancelled: 0, contractFailures: 0, contractPassRate: 1 },
    { assignmentSource: 'explicit', tasks: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, contractPassRate: null },
  ],
  promoteCriteria: { status: 'insufficient-sample', canaryPassRate: 1, stablePassRate: 0.75, canarySample: 2, threshold: '金丝雀样本 2 < 20——数据不足，系统不假装给了答案' },
  sideColumns: {
    approvalTimeoutCount: 2,
    toolUpgradeAffectedSpecs: [],
    stale: { queued: 0, paused: 0 },
    canaryRounds: { boundaryEvents: [], warning: null },
  },
  healthPanel: { traceEventCount: 12000, traceFileCount: 3, t1QueryP95Ms: null, triggered: true, note: 'OTel 触发条件①已满足' },
};

// ---------- FR-AG 目录聚合 ----------

describe('7-4 agentCatalogRows（Agent 目录聚合，FR-O-2 同款双源口径）', () => {
  it('tasks + capabilities 双源 agentId 去重排序；能力计数按 status 三枚举聚合', () => {
    const tasks = [{ agentId: 'ag-bravo' }, { agentId: 'ag-bravo' }, { agentId: 'ag-alpha' }];
    const caps = [
      { agentId: 'ag-charlie', status: 'candidate' },
      { agentId: 'ag-alpha', status: 'active' },
      { agentId: 'ag-alpha', status: 'retired' },
      { agentId: 'ag-alpha', status: 'candidate' },
      { agentId: 'ag-alpha', status: 'weird' }, // 未知 status 忽略
    ];
    const rows = agentCatalogRows(tasks, caps);
    expect(rows.map((r) => r.agentId)).toEqual(['ag-alpha', 'ag-bravo', 'ag-charlie']);
    expect(rows[0]).toEqual({ agentId: 'ag-alpha', candidate: 1, active: 1, retired: 1 });
    expect(rows[1]).toEqual({ agentId: 'ag-bravo', candidate: 0, active: 0, retired: 0 });
    expect(rows[2]).toEqual({ agentId: 'ag-charlie', candidate: 1, active: 0, retired: 0 });
  });
});

// ---------- FR-AG-1 能力卡 UI 模型 ----------

describe('7-4 cardUiOf（能力卡区 UI 模型，FR-AG-1）', () => {
  it('AgentCard 实测形状 → UI 模型（身份 4 字段 + mission/nonGoals/tools + 契约摘要 + 治理 JSON）', () => {
    const ui = cardUiOf(CARD);
    expect(ui.agentId).toBe('ag-1');
    expect(ui.versionId).toBe('v-0001');
    expect(ui.specVersion).toBe('1');
    expect(ui.contentHash).toBe('hash-abcdef');
    expect(ui.mission).toEqual(['执行回显工具调用']);
    expect(ui.nonGoals).toEqual(['修改文件内容']);
    expect(ui.tools).toEqual([{ toolId: 'echo-echo', riskLevel: 'L3' }]);
    expect(ui.inputContract).toEqual({ digest: 'd-in', type: 'object' });
    expect(ui.outputContract).toEqual({ digest: 'd-out', type: 'object' });
    expect(ui.budgetsJson).toBe(JSON.stringify({ maxModelCalls: 10 }, null, 2));
    expect(ui.approvalJson).toBe(JSON.stringify({ mode: 'onHighRisk' }, null, 2));
    expect(ui.evolutionJson).toBe('—'); // null → —（原样呈现空位）
    expect(PLACEHOLDER_BEASTS.test(JSON.stringify(ui))).toBe(false);
    expect(FORBIDDEN_FIELDS.test(JSON.stringify(ui))).toBe(false);
  });

  it('形状异常 → null（控制器显错误条，不假装渲染）', () => {
    expect(cardUiOf(null)).toBeNull();
    expect(cardUiOf({ nope: 1 })).toBeNull();
    expect(cardUiOf({ ...CARD, tools: 'not-array' })).toBeNull();
  });
});

// ---------- FR-AG-2 认知洞察 UI 模型 ----------

describe('7-4 insightUiOf（认知洞察区 UI 模型，FR-AG-2）', () => {
  it('三区模型：declared 冻结子集 / assertions 内嵌三键 / behavior 近 30 天窗；反思族零出现', () => {
    const ui = insightUiOf(INSIGHT)!;
    expect(ui).not.toBeNull();
    expect(ui.generatedAt).toBe(INSIGHT.generatedAt);
    // declared：Agent Card 冻结字段子集七键
    expect(ui.declared.agentId).toBe('ag-1');
    expect(ui.declared.mission).toEqual({ responsibilities: ['执行回显工具调用'] });
    expect(ui.declared.tools).toEqual([{ toolId: 'echo-echo', riskLevel: 'L3' }]);
    // assertions：active.counts + active.entries + openCandidates{total,evidencePending} + emptyHint
    expect(ui.activeCounts).toEqual({ capability: 2, limitation: 1 });
    expect(ui.activeEntries).toHaveLength(3);
    expect(ui.activeEntries[0]).toEqual({ capabilityId: 'cap-1', kind: 'capability', statement: '能稳定回显', origin: 'derived', evidenceCount: 2 });
    expect(ui.openCandidates).toEqual({ total: 2, evidencePending: 1 });
    expect(ui.emptyHint).toBeNull();
    // behavior：近 30 天趋势窗
    expect(ui.behaviorSince).toBe('2026-09-01T00:00:00.000000000Z');
    expect(ui.behaviorStatus).toBe('ok');
    expect(ui.behaviorInsufficientNote).toBeNull();
    expect(JSON.stringify(ui)).not.toMatch(/reflection/i);
    expect(FORBIDDEN_FIELDS.test(JSON.stringify(ui))).toBe(false);
  });

  it('空 Registry：emptyHint 原样透出（非错误）；behavior 样本不足 note 透出', () => {
    const ui = insightUiOf({
      ...INSIGHT,
      assertions: { active: { counts: { capability: 0, limitation: 0 }, entries: [] }, openCandidates: { total: 0, evidencePending: 0 }, emptyHint: 'Registry 无该 agent 条目——capability add 人工登记，或等 derived 判据窗口内数据积累（空清单非错误）' },
      behavior: { ...INSIGHT.behavior, buckets: [], status: 'insufficient-sample', insufficientNote: 'insufficient-sample：窗口内无任务数据——系统不假装给了答案' },
    })!;
    expect(ui.emptyHint).toContain('Registry 无该 agent 条目');
    expect(ui.behaviorStatus).toBe('insufficient-sample');
    expect(ui.behaviorInsufficientNote).toContain('insufficient-sample');
  });

  it('形状异常 → null（显错误条）', () => {
    expect(insightUiOf(null)).toBeNull();
    expect(insightUiOf({ assertions: 'x' })).toBeNull();
  });
});

// ---------- FR-AG-3 趋势 bar 模型 ----------

describe('7-4 trendBarsOf（趋势区 bar 模型，FR-AG-3 五键 + null 桶「—」）', () => {
  it('每桶五键直通 + contractPassRate null → 「—」+ 高度按 total 最大值归一', () => {
    const bars = trendBarsOf(TREND.buckets);
    expect(bars).toHaveLength(3);
    expect(bars[0].key).toBe('2026-09-29');
    expect(bars[0].rateLabel).toBe('—'); // null 桶不假装
    expect(bars[0].heightPct).toBe(0);
    expect(bars[1]).toMatchObject({ key: '2026-09-30', total: 4, succeeded: 3, excludedCancelled: 1, contractFailures: 1, rateLabel: '0.667', heightPct: 100 });
    expect(bars[2]).toMatchObject({ key: '2026-10-01', total: 2, rateLabel: '1.000', heightPct: 50 });
    expect(JSON.stringify(bars)).not.toContain('attempts');
  });

  it('全空桶序列：高度 0、rateLabel「—」', () => {
    const bars = trendBarsOf([TREND.buckets[0], { ...TREND.buckets[0], key: '2026-09-30' }]);
    expect(bars.every((b) => b.heightPct === 0 && b.rateLabel === '—')).toBe(true);
  });
});

describe('7-4 trendSummaryOf（TrendSummary 同款口径，锚点 view/capability.ts，FR-AG-3）', () => {
  it('hasData=false → 全图区空态判据成立；latestKey/latestRateLabel 实测', () => {
    const empty = trendSummaryOf({ agentId: TREND.agentId, bucket: TREND.bucket, buckets: [] });
    expect(empty.hasData).toBe(false);
    expect(empty.latestKey).toBeNull();
    expect(empty.latestRateLabel).toBe('—');
    const s = trendSummaryOf(TREND);
    expect(s.bucketCount).toBe(3);
    expect(s.latestKey).toBe('2026-10-01');
    expect(s.latestRateLabel).toBe('1.000');
  });
});

// ---------- FR-AG-4 报告摘要五键 ----------

describe('7-4 reportUiOf promoteLabel 词表（锚点 view/agent.ts PROMOTE_LABELS，FR-AG-4 五键）', () => {
  it('五键：agentId/groupCount/promoteLabel/approvalTimeoutCount/healthTriggered', () => {
    const s = reportUiOf(REPORT)!;
    expect(s.agentId).toBe('ag-1');
    expect(s.groupCount).toBe(3);
    expect(s.promoteLabel).toBe('样本不足');
    expect(s.approvalTimeoutCount).toBe(2); // >0 → 橙色徽章判据
    expect(s.healthTriggered).toBe(true); // → 提示条判据
  });

  it('零超时/未触发形态：徽章与提示条判据均不成立', () => {
    const s = reportUiOf({ ...REPORT, sideColumns: { ...REPORT.sideColumns, approvalTimeoutCount: 0 }, healthPanel: { ...REPORT.healthPanel, triggered: false } })!;
    expect(s.approvalTimeoutCount).toBe(0);
    expect(s.healthTriggered).toBe(false);
  });
});

describe('7-4 reportUiOf / trendUiOf 覆盖注记与健康提示（FR-AG-3/4 附注）', () => {
  it('reportUiOf 带健康面板 note（触发时提示条正文）', () => {
    const ui = reportUiOf(REPORT as never)!;
    expect(ui.healthNote).toContain('OTel');
  });

  it('趋势 coverage.note 透传（FR-AG-3 覆盖说明）', () => {
    const ui = trendBarsOf(TREND.buckets);
    expect(ui.length).toBeGreaterThan(0); // 注记由视图层从 trend.coverage.note 原样渲染（详见 detail 视图测试）
  });
});
