// 第七阶段批次四（7-4/4）：Agent 目录与详情纯逻辑（设计 V0.3 §7.5 FR-AG-1..5）。
// 实测形状锚点：insight.ts InsightAnswer（insight.ts:46-72）/ trend.ts TrendBucketRow
// （tasks 五键 + contractPassRate: number|null）/ report.ts ReportAnswer / agentCard.ts AgentCard。
// V0.3 删除项零出现：反思族（reflection）与趋势 attempts 字段（src/ 全库本就无此键——此处按设计明示）。
// 全部纯函数（node 环境直测）；报告摘要/趋势摘要复用 view 层既有口径
// （view/agent.ts reportSummary / view/capability.ts trendSummary——单一事实源）。

import { prettyJson } from './observeData.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ---------- Agent 目录聚合（§7.5：复用 FR-O-2 双源口径） ----------

export interface AgentCatalogRow {
  agentId: string;
  candidate: number;
  active: number;
  retired: number;
}

/** 双源（tasks + capabilities）agentId 去重排序 + 能力 status 三枚举计数（未知 status 忽略） */
export function agentCatalogRows(
  tasks: ReadonlyArray<{ agentId: string }>,
  capabilities: ReadonlyArray<{ agentId: string; status: string }>,
): AgentCatalogRow[] {
  const counts = new Map<string, AgentCatalogRow>();
  const rowOf = (agentId: string): AgentCatalogRow => {
    let row = counts.get(agentId);
    if (!row) {
      row = { agentId, candidate: 0, active: 0, retired: 0 };
      counts.set(agentId, row);
    }
    return row;
  };
  for (const t of tasks) rowOf(t.agentId);
  for (const c of capabilities) {
    const row = rowOf(c.agentId);
    if (c.status === 'candidate' || c.status === 'active' || c.status === 'retired') row[c.status] += 1;
  }
  return [...counts.values()].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

// ---------- FR-AG-1 能力卡 UI 模型 ----------

export interface CardToolUi {
  toolId: string;
  riskLevel: string;
}

export interface CardUi {
  agentId: string;
  versionId: string;
  specVersion: string;
  contentHash: string;
  mission: string[];
  nonGoals: string[];
  tools: CardToolUi[];
  inputContract: { digest: string; type: string };
  outputContract: { digest: string; type: string };
  budgetsJson: string;
  approvalJson: string;
  evolutionJson: string;
}

function stringArrayOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function contractOf(v: unknown): { digest: string; type: string } | null {
  if (!isRecord(v) || typeof v.digest !== 'string' || typeof v.type !== 'string') return null;
  return { digest: v.digest, type: v.type };
}

function jsonOrDash(v: unknown): string {
  return v === null || v === undefined ? '—' : prettyJson(JSON.stringify(v));
}

/** AgentCard 实测形状（agentCard.ts AgentCard）→ UI 模型；形状异常 → null（显错误条，不假装渲染） */
export function cardUiOf(data: unknown): CardUi | null {
  if (!isRecord(data)) return null;
  if (typeof data.agentId !== 'string' || typeof data.versionId !== 'string') return null;
  if (!Array.isArray(data.tools)) return null;
  const input = contractOf(data.inputContract);
  const output = contractOf(data.outputContract);
  if (input === null || output === null) return null;
  const mission = isRecord(data.mission) ? stringArrayOf(data.mission.responsibilities) : [];
  const tools: CardToolUi[] = data.tools.filter(
    (t): t is CardToolUi => isRecord(t) && typeof t.toolId === 'string' && typeof t.riskLevel === 'string',
  );
  return {
    agentId: data.agentId,
    versionId: data.versionId,
    specVersion: typeof data.specVersion === 'string' ? data.specVersion : '',
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : '',
    mission,
    nonGoals: stringArrayOf(data.nonGoals),
    tools,
    inputContract: input,
    outputContract: output,
    budgetsJson: jsonOrDash(data.budgets),
    approvalJson: jsonOrDash(data.approvalPolicy),
    evolutionJson: jsonOrDash(data.evolutionPolicy),
  };
}

// ---------- FR-AG-2 认知洞察 UI 模型 ----------

export interface InsightEntryUi {
  capabilityId: string;
  kind: string;
  statement: string;
  origin: string;
  evidenceCount: number;
}

export interface InsightUi {
  generatedAt: string;
  versionId: string;
  /** 声明面：Agent Card 冻结字段子集七键（INSIGHT_CARD_FIELD_KEYS）原始呈现 */
  declared: Record<string, unknown>;
  activeCounts: { capability: number; limitation: number };
  activeEntries: InsightEntryUi[];
  openCandidates: { total: number; evidencePending: number };
  emptyHint: string | null;
  behaviorSince: string;
  behaviorStatus: string;
  behaviorInsufficientNote: string | null;
}

function entryOf(v: unknown): InsightEntryUi | null {
  if (!isRecord(v) || typeof v.capabilityId !== 'string' || typeof v.kind !== 'string') return null;
  if (typeof v.statement !== 'string' || typeof v.origin !== 'string') return null;
  return {
    capabilityId: v.capabilityId,
    kind: v.kind,
    statement: v.statement,
    origin: v.origin,
    evidenceCount: typeof v.evidenceCount === 'number' ? v.evidenceCount : 0,
  };
}

/** InsightAnswer 实测形状 → UI 模型；形状异常 → null */
export function insightUiOf(data: unknown): InsightUi | null {
  if (!isRecord(data) || !isRecord(data.assertions) || !isRecord(data.behavior)) return null;
  if (!isRecord(data.declared) || typeof data.generatedAt !== 'string') return null;
  const active = data.assertions.active;
  if (!isRecord(active) || !isRecord(active.counts) || !Array.isArray(active.entries)) return null;
  const open = data.assertions.openCandidates;
  if (!isRecord(open) || typeof open.total !== 'number' || typeof open.evidencePending !== 'number') return null;
  return {
    generatedAt: data.generatedAt,
    versionId: typeof data.versionId === 'string' ? data.versionId : '',
    declared: data.declared,
    activeCounts: {
      capability: typeof active.counts.capability === 'number' ? active.counts.capability : 0,
      limitation: typeof active.counts.limitation === 'number' ? active.counts.limitation : 0,
    },
    activeEntries: active.entries.map(entryOf).filter((e): e is InsightEntryUi => e !== null),
    openCandidates: { total: open.total, evidencePending: open.evidencePending },
    emptyHint: typeof data.assertions.emptyHint === 'string' ? data.assertions.emptyHint : null,
    behaviorSince: typeof data.behavior.since === 'string' ? data.behavior.since : '',
    behaviorStatus: typeof data.behavior.status === 'string' ? data.behavior.status : '',
    behaviorInsufficientNote: typeof data.behavior.insufficientNote === 'string' ? data.behavior.insufficientNote : null,
  };
}

// ---------- FR-AG-3 趋势摘要（TrendSummary 同款口径锚点：view/capability.ts trendSummary——
// ui 树不得跨 rootDir 引 view 面（view/capability.ts 依赖 src/modules），故同口径复刻） ----------

export interface TrendSummaryUi {
  agentId: string;
  bucket: string;
  bucketCount: number;
  hasData: boolean;
  latestKey: string | null;
  /** 最新桶通过率展示（null 分母 → 「无分母不假装」文案） */
  latestRateLabel: string;
}

export function trendSummaryOf(trend: { agentId: string; bucket: string; buckets: ReadonlyArray<Record<string, unknown>> }): TrendSummaryUi {
  const latest = trend.buckets.length > 0 ? trend.buckets[trend.buckets.length - 1] : null;
  const latestTasks = latest !== null && isRecord(latest.tasks) ? latest.tasks : null;
  const rate = latestTasks !== null ? latestTasks.contractPassRate : undefined;
  return {
    agentId: trend.agentId,
    bucket: trend.bucket,
    bucketCount: trend.buckets.length,
    hasData: trend.buckets.length > 0,
    latestKey: latest !== null && typeof latest.key === 'string' ? latest.key : null,
    latestRateLabel: latest === null ? '—' : typeof rate === 'number' ? rate.toFixed(3) : '—（无分母不假装）',
  };
}

// ---------- FR-AG-3 趋势 bar 模型（tasks 五键直通；attempts 零出现） ----------

export interface TrendBarUi {
  key: string;
  total: number;
  succeeded: number;
  excludedCancelled: number;
  contractFailures: number;
  /** contractPassRate 展示：null → 「—」（无分母不假装）；数值 → toFixed(3)（trendSummary 同口径） */
  rateLabel: string;
  /** bar 高度百分比：total / max(total)，0..100 整数 */
  heightPct: number;
}

/** 每桶 tasks 五键（trend.ts TrendBucketRow.tasks 实测）→ bar 行；高度按 total 最大值归一 */
export function trendBarsOf(buckets: ReadonlyArray<Record<string, unknown>>): TrendBarUi[] {
  const rows = buckets.filter(isRecord).map((b) => {
    const tasks = isRecord(b.tasks) ? b.tasks : {};
    return {
      key: typeof b.key === 'string' ? b.key : '',
      total: typeof tasks.total === 'number' ? tasks.total : 0,
      succeeded: typeof tasks.succeeded === 'number' ? tasks.succeeded : 0,
      excludedCancelled: typeof tasks.excludedCancelled === 'number' ? tasks.excludedCancelled : 0,
      contractFailures: typeof tasks.contractFailures === 'number' ? tasks.contractFailures : 0,
      rate: tasks.contractPassRate,
    };
  });
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0);
  return rows.map((r) => ({
    key: r.key,
    total: r.total,
    succeeded: r.succeeded,
    excludedCancelled: r.excludedCancelled,
    contractFailures: r.contractFailures,
    rateLabel: typeof r.rate === 'number' ? r.rate.toFixed(3) : '—',
    heightPct: max > 0 ? Math.round((r.total / max) * 100) : 0,
  }));
}

// ---------- FR-AG-4 报告摘要 UI 模型 ----------

export interface ReportUi {
  agentId: string;
  groupCount: number;
  promoteLabel: string;
  approvalTimeoutCount: number;
  healthTriggered: boolean;
  /** 健康提示条正文（healthPanel.note 原样；未触发时也渲染为口径注记） */
  healthNote: string;
}

/** ReportAnswer → 视图模型（promoteLabel 词表 = view/agent.ts PROMOTE_LABELS 同款口径，经 reportSummary 单一源） */
export function reportUiOf(data: unknown): ReportUi | null {
  if (!isRecord(data)) return null;
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const promote = isRecord(data.promoteCriteria) ? data.promoteCriteria : null;
  const side = isRecord(data.sideColumns) ? data.sideColumns : {};
  const health = isRecord(data.healthPanel) ? data.healthPanel : {};
  const labels: Record<string, string> = {
    'promote-recommended': '建议晋级',
    'insufficient-sample': '样本不足',
    'below-threshold': '低于阈值',
    'no-canary': '无灰度',
  };
  const status = promote !== null && typeof promote.status === 'string' ? promote.status : '';
  return {
    agentId: typeof data.agentId === 'string' ? data.agentId : '',
    groupCount: groups.length,
    promoteLabel: labels[status] ?? status,
    approvalTimeoutCount: typeof side.approvalTimeoutCount === 'number' ? side.approvalTimeoutCount : 0,
    healthTriggered: health.triggered === true,
    healthNote: typeof health.note === 'string' ? health.note : '',
  };
}
