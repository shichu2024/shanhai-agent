// 第七阶段批次三（7-3/4）：观测面纯逻辑（设计 V0.3 §7.1–7.4）——
// 中文词表（与 view 层既有词表同款口径）、三卡聚合、合并时间线、agentId 双源去重、
// 文本截断、演进 evidenceRefs 解析、证据呈现口径。全部纯函数（node 环境直测）。
// 词表锚点：CAPABILITY_STATUS_LABELS（view/capability.ts:6 同款）；
// 演进/触发器/kind/origin 枚举锚点 = db.ts CHECK（evolution_candidate / capability_registry）。

import { relativeTime } from './format.js';

// ---------- 词表 ----------

/** 能力 status 三枚举（view/capability.ts:6 CAPABILITY_STATUS_LABELS 同款） */
export const CAPABILITY_STATUS_LABELS: Record<string, string> = {
  candidate: '待确认',
  active: '已生效',
  retired: '已退场',
};

/** 能力 kind 两枚举（db.ts capability_registry CHECK） */
export const CAPABILITY_KIND_LABELS: Record<string, string> = {
  capability: '能力',
  limitation: '局限',
};

/** 能力 origin 两枚举（db.ts capability_registry CHECK） */
export const CAPABILITY_ORIGIN_LABELS: Record<string, string> = {
  derived: '派生',
  manual: '人工',
};

/** 演进 status 三枚举分组顺序（db.ts evolution_candidate CHECK） */
export const EVOLUTION_STATUSES = ['open', 'confirmed', 'dismissed'] as const;
export type EvolutionStatus = (typeof EVOLUTION_STATUSES)[number];

/** 演进 status 中文（TASK-103 派发口径：open 待决策 / confirmed 已确认 / dismissed 已驳回） */
export const EVOLUTION_STATUS_LABELS: Record<string, string> = {
  open: '待决策',
  confirmed: '已确认',
  dismissed: '已驳回',
};

/** 演进 trigger 两枚举（db.ts evolution_candidate CHECK） */
export const EVOLUTION_TRIGGER_LABELS: Record<string, string> = {
  repeated_failure: '重复失败',
  capability_degradation: '能力退化',
};

// ---------- FR-O-1 三卡聚合 ----------

/** 任务卡成功率：succeeded / (total − cancelled)；分母 ≤0 → null（无分母不假装） */
export function taskSuccessRate(counts: Record<string, number>): number | null {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const denominator = total - (counts.cancelled ?? 0);
  if (denominator <= 0) return null;
  return counts.succeeded / denominator;
}

/** 能力卡三枚举聚合计数（未知 status 忽略） */
export function capabilityStatusCounts(rows: ReadonlyArray<{ status: string }>): { candidate: number; active: number; retired: number } {
  const counts = { candidate: 0, active: 0, retired: 0 };
  for (const r of rows) {
    if (r.status === 'candidate' || r.status === 'active' || r.status === 'retired') counts[r.status] += 1;
  }
  return counts;
}

// ---------- FR-O-1 合并时间线 ----------

export interface TimelineTaskLike {
  taskId: string;
  status: string;
  createdAt: string;
}

export interface TimelineApprovalLike {
  requestId: string;
  toolId: string;
  requestedAt: string;
}

export type TimelineEntry =
  | { kind: 'task'; at: string; taskId: string; status: string }
  | { kind: 'approval'; at: string; requestId: string; toolId: string };

/** 任务（createdAt desc 前 10）与 pending 审批（requestedAt desc）按时间倒序交错合并；同刻任务在前（稳定序） */
export function mergeTimeline(tasks: ReadonlyArray<TimelineTaskLike>, approvals: ReadonlyArray<TimelineApprovalLike>, maxTasks = 10): TimelineEntry[] {
  const topTasks = [...tasks]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, maxTasks)
    .map<TimelineEntry>((t) => ({ kind: 'task', at: t.createdAt, taskId: t.taskId, status: t.status }));
  const topApprovals = [...approvals]
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
    .map<TimelineEntry>((a) => ({ kind: 'approval', at: a.requestedAt, requestId: a.requestId, toolId: a.toolId }));
  return [...topTasks, ...topApprovals].sort((a, b) => {
    const d = Date.parse(b.at) - Date.parse(a.at);
    if (d !== 0) return d;
    return a.kind === b.kind ? 0 : a.kind === 'task' ? -1 : 1; // 同刻任务在前
  });
}

/** 待办卡最老一条相对时间（「最老待办 x 分钟前」）；无待办 → 空串 */
export function oldestPendingRel(approvals: ReadonlyArray<{ requestedAt: string }>, now: number): string {
  if (approvals.length === 0) return '';
  let oldest = approvals[0].requestedAt;
  for (const a of approvals) {
    if (Date.parse(a.requestedAt) < Date.parse(oldest)) oldest = a.requestedAt;
  }
  return `最老待办 ${relativeTime(oldest, now)}`;
}

// ---------- FR-O-2 Agent 选择器 ----------

/** 双源（tasks + capabilities）agentId 去重 + 字典序排序 */
export function collectAgentIds(tasks: ReadonlyArray<{ agentId: string }>, capabilities: ReadonlyArray<{ agentId: string }>): string[] {
  return [...new Set([...tasks.map((t) => t.agentId), ...capabilities.map((c) => c.agentId)])].sort();
}

// ---------- 文本处理 ----------

/** 截断：≤max 原样；>max 截断加省略号 */
export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 取首行（proposedChange 摘要口径）；null → 空串 */
export function firstLine(text: string | null): string {
  if (!text) return '';
  const i = text.indexOf('\n');
  return i < 0 ? text : text.slice(0, i);
}

// ---------- FR-O-3 evidenceRefs 解析 ----------

export interface EvolutionEvidenceRefEntry {
  taskId: string;
  agentVersionId: string;
  subClass: string;
  occurredAt: string;
}

/** 演进候选 evidenceRefs 解析（EvolutionCandidateRow.evidenceRefs 为 JSON 字符串数组）；异常形态防御 → 空数组 */
export function parseEvolutionEvidenceRefs(raw: string | null): EvolutionEvidenceRefEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is EvolutionEvidenceRefEntry =>
      typeof e === 'object' && e !== null && typeof (e as EvolutionEvidenceRefEntry).taskId === 'string');
  } catch {
    return [];
  }
}

/** 任务 → 证据 ref 映射（evidenceStore ref 形态 kind:id，kind 封闭枚举含 task） */
export function taskEvidenceRef(taskId: string): string {
  return `task:${taskId}`;
}

// ---------- FR-O-4 证据呈现口径 ----------

/** payload 折叠阈值（与 view/evidence.ts EVIDENCE_PAYLOAD_COLLAPSE_CHARS 同口径） */
export const EVIDENCE_PAYLOAD_COLLAPSE_CHARS = 2048;

/** digest 前 12 位（悬停 title 显全文） */
export function digestHead(digest: string): string {
  return digest.slice(0, 12);
}

/** payload JSON 美化（缩进 2）；非 JSON 原样返回 */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
