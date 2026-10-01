import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KIND_LABELS,
  CAPABILITY_ORIGIN_LABELS,
  CAPABILITY_STATUS_LABELS,
  EVOLUTION_STATUSES,
  EVOLUTION_STATUS_LABELS,
  EVOLUTION_TRIGGER_LABELS,
  EVIDENCE_PAYLOAD_COLLAPSE_CHARS,
  capabilityStatusCounts,
  collectAgentIds,
  digestHead,
  firstLine,
  mergeTimeline,
  oldestPendingRel,
  parseEvolutionEvidenceRefs,
  prettyJson,
  taskEvidenceRef,
  taskSuccessRate,
  truncateText,
} from '../src/portal/ui/observeData.js';

// 第七阶段批次三（7-3/4）：观测面纯逻辑（设计 V0.3 §7.1–7.4）——
// 三卡聚合口径（任务七状态+成功率分母=total−cancelled / 能力三枚举 / 待办最老相对时间）、
// 合并时间线、agentId 双源去重、文本截断、演进 evidenceRefs 解析与证据 ref 映射、
// payload 折叠口径。TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

// ---------- 词表（中文映射，与 view 层既有词表同款口径） ----------

describe('7-3 观测词表（FR-O-2/FR-O-3）', () => {
  it('能力 status 三枚举中文 = CAPABILITY_STATUS_LABELS 同款（view/capability.ts:6）', () => {
    expect(CAPABILITY_STATUS_LABELS).toEqual({ candidate: '待确认', active: '已生效', retired: '已退场' });
  });

  it('能力 kind/origin 中文映射（db.ts capability_registry CHECK 枚举）', () => {
    expect(CAPABILITY_KIND_LABELS).toEqual({ capability: '能力', limitation: '局限' });
    expect(CAPABILITY_ORIGIN_LABELS).toEqual({ derived: '派生', manual: '人工' });
  });

  it('演进 status 三枚举分组顺序 open/confirmed/dismissed + 中文（db.ts evolution_candidate CHECK）', () => {
    expect([...EVOLUTION_STATUSES]).toEqual(['open', 'confirmed', 'dismissed']);
    expect(EVOLUTION_STATUS_LABELS).toEqual({ open: '待决策', confirmed: '已确认', dismissed: '已驳回' });
  });

  it('演进 trigger 两枚举中文（db.ts CHECK）', () => {
    expect(EVOLUTION_TRIGGER_LABELS).toEqual({
      repeated_failure: '重复失败',
      capability_degradation: '能力退化',
    });
  });

  it('词表零占位神兽', () => {
    const all = [
      ...Object.values(CAPABILITY_STATUS_LABELS),
      ...Object.values(CAPABILITY_KIND_LABELS),
      ...Object.values(CAPABILITY_ORIGIN_LABELS),
      ...Object.values(EVOLUTION_STATUS_LABELS),
      ...Object.values(EVOLUTION_TRIGGER_LABELS),
    ].join('');
    expect(PLACEHOLDER_BEASTS.test(all)).toBe(false);
  });
});

// ---------- FR-O-1 三卡聚合 ----------

describe('7-3 任务统计卡口径（FR-O-1：与 FR-T-1 完全相同，分母=total−cancelled）', () => {
  it('成功率 = succeeded / (total − cancelled)', () => {
    // 10 条：succeeded 4 / failed 2 / cancelled 2 / running 2 → 分母 8 → 0.5
    const counts = { created: 0, queued: 0, running: 2, paused: 0, succeeded: 4, failed: 2, cancelled: 2 };
    expect(taskSuccessRate(counts)).toBe(0.5);
  });

  it('全 cancelled / 空数据 → 分母 0 → null（无分母不假装）', () => {
    expect(taskSuccessRate({ created: 0, queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 3 })).toBeNull();
    expect(taskSuccessRate({ created: 0, queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0 })).toBeNull();
  });

  it('含 created/queued/paused 计入分母（七状态全量口径）', () => {
    // total 10, cancelled 1 → 分母 9，succeeded 3 → 1/3
    const counts = { created: 1, queued: 2, running: 1, paused: 1, succeeded: 3, failed: 1, cancelled: 1 };
    expect(taskSuccessRate(counts)).toBeCloseTo(1 / 3, 10);
  });
});

describe('7-3 能力统计卡（FR-O-1：status 三枚举聚合计数）', () => {
  it('candidate/active/retired 计数，未知 status 忽略', () => {
    const counts = capabilityStatusCounts([
      { status: 'candidate' },
      { status: 'candidate' },
      { status: 'active' },
      { status: 'retired' },
      { status: 'bogus' },
    ]);
    expect(counts).toEqual({ candidate: 2, active: 1, retired: 1 });
  });
});

describe('7-3 待办审批卡（FR-O-1：最老待办相对时间）', () => {
  it('取 requestedAt 最小者渲染相对时间（relativeTime 同款词表：整点进位为小时）', () => {
    const rows = [
      { requestId: 'r-new', requestedAt: '2026-10-01T11:55:00.000Z' },
      { requestId: 'r-old', requestedAt: '2026-10-01T11:00:00.000Z' }, // 60 分钟 → 1 小时前
    ];
    expect(oldestPendingRel(rows, NOW)).toBe('最老待办 1 小时前');
  });

  it('无待办 → 空串（卡片显 0）', () => {
    expect(oldestPendingRel([], NOW)).toBe('');
  });
});

// ---------- FR-O-1 合并时间线 ----------

describe('7-3 合并时间线（FR-O-1：任务前 10 + pending 审批，时间倒序交错）', () => {
  const tasks = [
    { taskId: 't-1', status: 'running', createdAt: '2026-10-01T11:50:00.000Z' },
    { taskId: 't-2', status: 'succeeded', createdAt: '2026-10-01T11:40:00.000Z' },
    { taskId: 't-3', status: 'queued', createdAt: '2026-10-01T11:30:00.000Z' },
  ];
  const approvals = [
    { requestId: 'r-1', toolId: 'shell', requestedAt: '2026-10-01T11:45:00.000Z' },
    { requestId: 'r-2', toolId: 'http', requestedAt: '2026-10-01T11:35:00.000Z' },
  ];

  it('按时间倒序交错合并；任务条目与审批条目各带跳转键', () => {
    const merged = mergeTimeline(tasks, approvals);
    expect(merged.map((e) => e.kind)).toEqual(['task', 'approval', 'task', 'approval', 'task']);
    expect(merged[0]).toMatchObject({ kind: 'task', taskId: 't-1', at: '2026-10-01T11:50:00.000Z' });
    expect(merged[1]).toMatchObject({ kind: 'approval', requestId: 'r-1', toolId: 'shell' });
  });

  it('任务取 createdAt desc 前 10 条（超量截断）', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      taskId: `t-${String(i).padStart(2, '0')}`,
      status: 'queued',
      createdAt: new Date(Date.parse('2026-10-01T10:00:00.000Z') + i * 60_000).toISOString(),
    }));
    const merged = mergeTimeline(many, []);
    expect(merged).toHaveLength(10);
    expect(merged[0].kind === 'task' && merged[0].taskId).toBe('t-14'); // 最新在前
  });

  it('同刻并列时任务在前（确定性稳定序）', () => {
    const at = '2026-10-01T11:00:00.000Z';
    const merged = mergeTimeline([{ taskId: 't-x', status: 'paused', createdAt: at }], [{ requestId: 'r-x', toolId: 'sh', requestedAt: at }]);
    expect(merged[0].kind).toBe('task');
    expect(merged).toHaveLength(2);
  });
});

// ---------- FR-O-2 Agent 选择器 ----------

describe('7-3 Agent 选择器聚合（FR-O-2：tasks+capabilities 双源去重排序）', () => {
  it('两源 agentId 去重 + 字典序排序', () => {
    const ids = collectAgentIds(
      [
        { agentId: 'bravo' },
        { agentId: 'alpha' },
      ],
      [
        { agentId: 'alpha' },
        { agentId: 'charlie' },
      ],
    );
    expect(ids).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('两源皆空 → 空数组（空态「暂无 Agent 数据」判据）', () => {
    expect(collectAgentIds([], [])).toEqual([]);
  });
});

// ---------- 文本截断（FR-O-2 statement / FR-O-3 proposedChange） ----------

describe('7-3 文本处理（截断 80 + 首行）', () => {
  it('truncateText：≤80 原样；>80 截断加省略号', () => {
    const exact80 = 'a'.repeat(80);
    expect(truncateText(exact80, 80)).toBe(exact80);
    expect(truncateText('b'.repeat(81), 80)).toBe(`${'b'.repeat(80)}…`);
    expect(truncateText('短文本', 80)).toBe('短文本');
  });

  it('firstLine：取首行；null → 空串', () => {
    expect(firstLine('第一行\n第二行')).toBe('第一行');
    expect(firstLine('单行')).toBe('单行');
    expect(firstLine(null)).toBe('');
  });
});

// ---------- FR-O-3 evidenceRefs 解析与证据 ref 映射 ----------

describe('7-3 演进 evidenceRefs（FR-O-3 ④：可点击跳证据页）', () => {
  it('解析 JSON 数组条目（EvolutionCandidateRow.evidenceRefs 实测形态）', () => {
    const raw = JSON.stringify([
      { taskId: 't-1', agentVersionId: 'v-1', subClass: 'tool.shell.timeout', occurredAt: '2026-10-01T10:00:00.000Z' },
      { taskId: 't-2', agentVersionId: 'v-1', subClass: 'tool.http.dns', occurredAt: '2026-10-01T10:05:00.000Z' },
    ]);
    const refs = parseEvolutionEvidenceRefs(raw);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ taskId: 't-1', agentVersionId: 'v-1', subClass: 'tool.shell.timeout', occurredAt: '2026-10-01T10:00:00.000Z' });
  });

  it('异常形态防御：null/空串/非 JSON → 空数组', () => {
    expect(parseEvolutionEvidenceRefs(null)).toEqual([]);
    expect(parseEvolutionEvidenceRefs('')).toEqual([]);
    expect(parseEvolutionEvidenceRefs('not-json')).toEqual([]);
    expect(parseEvolutionEvidenceRefs('{"a":1}')).toEqual([]); // 非数组
  });

  it('任务证据 ref 映射 = task:<taskId>（evidenceStore ref 形态 kind:id，kind 封闭枚举含 task）', () => {
    expect(taskEvidenceRef('t-1')).toBe('task:t-1');
  });
});

// ---------- FR-O-4 证据六键呈现口径 ----------

describe('7-3 证据呈现口径（FR-O-4：digest 前 12 / payload >2048 折叠）', () => {
  it('EVIDENCE_PAYLOAD_COLLAPSE_CHARS = 2048（与 view/evidence.ts 同口径）', () => {
    expect(EVIDENCE_PAYLOAD_COLLAPSE_CHARS).toBe(2048);
  });

  it('digestHead：前 12 位（悬停显全由 title 承载）', () => {
    expect(digestHead('abcdef0123456789')).toBe('abcdef012345');
    expect(digestHead('short')).toBe('short');
  });

  it('prettyJson：JSON 字符串美化缩进 2；非 JSON 原样返回', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('plain text')).toBe('plain text');
  });
});
