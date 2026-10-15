// 第六阶段批次二（§4.4 / 假设 5 修订）：evolution 视图纯函数——演进候选行展示变换。

import type { EvolutionCandidateRow } from '../../modules/evolution.js';
import { parseEvidenceRefs } from './evidenceRefs.js';

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
  // TASK-157：统一解析辅助——malformed 与合法 JSON 非数组形态（如标量字符串曾取字符数）一律计 0
  const evidenceCount = parseEvidenceRefs(row.evidenceRefs).length;
  return {
    candidateId: row.candidateId,
    agentId: row.agentId,
    trigger: row.trigger,
    statusLabel: EVOLUTION_STATUS_LABELS[row.status] ?? row.status,
    evidenceCount,
    decided: row.decidedAt !== null,
  };
}
