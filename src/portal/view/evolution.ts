// 第六阶段批次二（§4.4 / 假设 5 修订）：evolution 视图纯函数——演进候选行展示变换。

import type { EvolutionCandidateRow } from '../../modules/evolution.js';

const EVOLUTION_STATUS_LABELS: Record<string, string> = {
  open: '待裁决',
  confirmed: '已确认',
  dismissed: '已驳回',
};

export interface EvolutionSummary {
  candidateId: string;
  agentId: string;
  trigger: string;
  statusLabel: string;
  evidenceCount: number;
  decided: boolean;
}

export function evolutionSummary(row: EvolutionCandidateRow): EvolutionSummary {
  let evidenceCount = 0;
  try {
    evidenceCount = (JSON.parse(row.evidenceRefs) as unknown[]).length;
  } catch {
    evidenceCount = 0; // 存量异常形态（防御）：视为空
  }
  return {
    candidateId: row.candidateId,
    agentId: row.agentId,
    trigger: row.trigger,
    statusLabel: EVOLUTION_STATUS_LABELS[row.status] ?? row.status,
    evidenceCount,
    decided: row.decidedAt !== null,
  };
}
