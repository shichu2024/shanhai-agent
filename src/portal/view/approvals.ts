// 第六阶段批次一（§4.4 / 假设 5 修订）：审批视图纯函数——渲染数据变换 + 决议/超时文案。

export interface ApprovalViewRow {
  requestId: string;
  taskId: string;
  toolId: string;
  decision: string;
  taskStatus: string;
  timeoutRemainingMs: number;
}

export interface ApprovalSummary {
  requestId: string;
  taskId: string;
  toolId: string;
  decisionLabel: string;
  blocked: boolean;
  timeoutLabel: string;
}

const DECISION_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  denied: '已拒绝',
  superseded: '已作废',
};

/** 剩余时间展示（>2 分钟 → 「N 分钟内」粒度；0 → 已超时——惰性判定将在下次读取时落地） */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '已超时';
  if (ms < 60_000) return '<1 分钟';
  return `${Math.ceil(ms / 60_000)} 分钟内`;
}

export function approvalSummary(row: ApprovalViewRow): ApprovalSummary {
  return {
    requestId: row.requestId,
    taskId: row.taskId,
    toolId: row.toolId,
    decisionLabel: DECISION_LABELS[row.decision] ?? row.decision,
    blocked: row.decision === 'pending' && row.taskStatus === 'paused',
    timeoutLabel: row.decision === 'pending' ? formatDuration(row.timeoutRemainingMs) : '—',
  };
}
