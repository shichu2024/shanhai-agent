// 第六阶段批次二（§4.4 / 假设 5 修订）：evidence 视图纯函数——ref 前端预检 + 证据摘要变换。

import { EVIDENCE_REF_KINDS } from '../../modules/evidenceStore.js';

/** 长证据折叠阈值（§12-3：payload >2KB 摘要展示，递归渲染器折叠纪律） */
export const EVIDENCE_PAYLOAD_COLLAPSE_CHARS = 2048;

/** ref 输入框前端预检（格式与封闭枚举——与 parseEvidenceRef 同口径；服务端仍强校验） */
export function parseRefInput(raw: string): { ok: true; ref: string } | { ok: false; reason: string } {
  const parts = raw.trim().split(':');
  if (parts.length !== 2) return { ok: false, reason: '格式须为 <kind>:<id>（恰一个冒号）' };
  const [kind, id] = parts as [string, string];
  if (!(EVIDENCE_REF_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `kind 未知（封闭枚举 ${EVIDENCE_REF_KINDS.join('/')}）` };
  }
  if (id.length === 0) return { ok: false, reason: 'id 为空' };
  return { ok: true, ref: `${kind}:${id}` };
}

export interface EvidenceViewRow {
  ref: string;
  kind: string;
  status: string;
  occurredAt: string;
  digest: string;
  payload: string;
}

export interface EvidenceSummary {
  ref: string;
  kind: string;
  status: string;
  occurredAt: string;
  digestShort: string;
  payloadCollapsed: boolean;
}

export function evidenceSummary(row: EvidenceViewRow): EvidenceSummary {
  return {
    ref: row.ref,
    kind: row.kind,
    status: row.status,
    occurredAt: row.occurredAt,
    digestShort: row.digest.slice(0, 12),
    payloadCollapsed: row.payload.length > EVIDENCE_PAYLOAD_COLLAPSE_CHARS,
  };
}
