// 第六阶段批次二（§4.4 / 假设 5 修订）：agent 视图纯函数——insight 四层摘要 + report 健康面板摘要。

import type { InsightAnswer } from '../../modules/insight.js';
import type { ReportAnswer } from '../../modules/report.js';

export interface InsightSummary {
  agentId: string;
  versionId: string;
  behaviorLabel: string;
  activeLabel: string;
  openCandidates: number;
  limitationCount: number;
  emptyRegistryHint: string | null;
}

export function insightSummary(insight: InsightAnswer): InsightSummary {
  return {
    agentId: insight.agentId,
    versionId: insight.versionId,
    behaviorLabel: insight.behavior.status === 'ok' ? '正常' : '样本不足',
    activeLabel: `capability ${insight.assertions.active.counts.capability} / limitation ${insight.assertions.active.counts.limitation}`,
    openCandidates: insight.assertions.openCandidates.total,
    limitationCount: insight.limitations.entries.length,
    emptyRegistryHint: insight.assertions.emptyHint,
  };
}

const PROMOTE_LABELS: Record<string, string> = {
  'promote-recommended': '建议晋级',
  'insufficient-sample': '样本不足',
  'below-threshold': '低于阈值',
  'no-canary': '无灰度',
};

export interface ReportSummary {
  agentId: string;
  groupCount: number;
  promoteLabel: string;
  approvalTimeoutCount: number;
  healthTriggered: boolean;
}

export function reportSummary(report: ReportAnswer): ReportSummary {
  return {
    agentId: report.agentId,
    groupCount: report.groups.length,
    promoteLabel: PROMOTE_LABELS[report.promoteCriteria.status] ?? report.promoteCriteria.status,
    approvalTimeoutCount: report.sideColumns.approvalTimeoutCount,
    healthTriggered: report.healthPanel.triggered,
  };
}
