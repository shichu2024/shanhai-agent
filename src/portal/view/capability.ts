// 第六阶段批次二（§4.4 / 假设 5 修订）：capability/trend 视图纯函数——断言行与趋势摘要变换。

import type { CapabilityRow } from '../../modules/capabilityRegistry.js';
import type { CapabilityTrend } from '../../modules/trend.js';

const CAPABILITY_STATUS_LABELS: Record<string, string> = {
  candidate: '待确认',
  active: '已生效',
  retired: '已退场',
};

export interface CapabilitySummary {
  capabilityId: string;
  agentId: string;
  kind: string;
  statusLabel: string;
  evidenceCount: number;
  evidencePending: boolean;
}

export function capabilitySummary(row: CapabilityRow): CapabilitySummary {
  const evidenceCount = (JSON.parse(row.evidenceRefs) as unknown[]).length;
  return {
    capabilityId: row.capabilityId,
    agentId: row.agentId,
    kind: row.kind,
    statusLabel: CAPABILITY_STATUS_LABELS[row.status] ?? row.status,
    evidenceCount,
    evidencePending: evidenceCount === 0,
  };
}

export interface TrendSummary {
  agentId: string;
  bucket: string;
  bucketCount: number;
  hasData: boolean;
  latestKey: string | null;
  /** 最新桶通过率展示（null 分母 → 「无分母不假装」文案） */
  latestRateLabel: string;
}

export function trendSummary(trend: CapabilityTrend): TrendSummary {
  const latest = trend.buckets.length > 0 ? trend.buckets[trend.buckets.length - 1] : null;
  return {
    agentId: trend.agentId,
    bucket: trend.bucket,
    bucketCount: trend.buckets.length,
    hasData: trend.buckets.length > 0,
    latestKey: latest ? latest.key : null,
    latestRateLabel: latest === null ? '—' : latest.tasks.contractPassRate === null ? '—（无分母不假装）' : latest.tasks.contractPassRate.toFixed(3),
  };
}
