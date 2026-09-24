import { sha256HexOfObj } from '../hash.js';
import type { SpecRow } from './registry.js';

// WP-4B 批次四（§4.5，D-33）：Agent Card 只读派生制品。
// 字段集为重新设计（原文 §12.2 污染，A0 纪律）——严格按 §4.5 表，不做 A2A 端点、不做网络发布。
// 派生制品永不存储：每次从 AgentVersion 快照现算（零一致性维护）；
// contentHash 字段保留但一致性断言删（V0.2 修剪——只读现算无漂移面）。

/** mission / nonGoals 摘要单项截断上限（注册面 zod 已限 200；此处为派生面防御性截断，防漂移） */
export const CARD_MISSION_MAX_CHARS = 200;

export interface AgentCard {
  /** 身份锚定 4 字段（全部取自 AgentVersion 快照行） */
  agentId: string;
  versionId: string;
  specVersion: string;
  contentHash: string;
  /** 职责边界（截断至安全长度） */
  mission: { responsibilities: string[] };
  nonGoals: string[];
  /** 能力面 + 风险面：toolId / riskLevel / controlledFields 摘要（键名 + 白名单计数，不含值域全文） */
  tools: { toolId: string; riskLevel: string; controlledFields?: { paramRangeKeys: string[]; targetWhitelistCount: number } }[];
  /** 输入输出契约摘要：digest + 类型摘要（不含契约全文） */
  inputContract: { digest: string; type: string };
  outputContract: { digest: string; type: string };
  /** 治理姿态：预算摘要（modelPolicy）+ 审批/演进策略 */
  budgets: Record<string, unknown>;
  approvalPolicy: Record<string, unknown> | null;
  evolutionPolicy: Record<string, unknown> | null;
}

/** §4.5 字段集冻结键序（严格按表；测试断言消费同一导出，防漂移） */
export const CARD_FIELD_KEYS = [
  'agentId', 'versionId', 'specVersion', 'contentHash',
  'mission', 'nonGoals', 'tools', 'inputContract', 'outputContract',
  'budgets', 'approvalPolicy', 'evolutionPolicy',
] as const;

const truncate = (s: string): string => (s.length > CARD_MISSION_MAX_CHARS ? s.slice(0, CARD_MISSION_MAX_CHARS) : s);

function contractSummary(contract: Record<string, unknown>): { digest: string; type: string } {
  return { digest: sha256HexOfObj(contract), type: String(contract.type ?? 'unknown') };
}

/** 从 AgentVersion 快照行现算 Agent Card（纯函数：零 DB 访问、零存储写入） */
export function buildAgentCard(row: SpecRow): AgentCard {
  const spec = JSON.parse(row.specSnapshot) as {
    specVersion: string;
    mission?: { responsibilities?: string[]; nonResponsibilities?: string[] };
    toolPolicy?: { tools?: { toolId: string; riskLevel: string; controlledFields?: { paramRanges?: Record<string, unknown>; targetWhitelist?: string[] } }[] };
    inputContract?: Record<string, unknown>;
    outputContract?: Record<string, unknown>;
    modelPolicy?: Record<string, unknown>;
    approvalPolicy?: Record<string, unknown> | null;
    evolutionPolicy?: Record<string, unknown> | null;
  };
  return {
    agentId: row.agentId,
    versionId: row.versionId,
    specVersion: spec.specVersion,
    contentHash: row.contentHash,
    mission: { responsibilities: (spec.mission?.responsibilities ?? []).map(truncate) },
    nonGoals: (spec.mission?.nonResponsibilities ?? []).map(truncate),
    tools: (spec.toolPolicy?.tools ?? []).map((t) => ({
      toolId: t.toolId,
      riskLevel: t.riskLevel,
      ...(t.controlledFields
        ? {
            controlledFields: {
              paramRangeKeys: Object.keys(t.controlledFields.paramRanges ?? {}),
              targetWhitelistCount: t.controlledFields.targetWhitelist?.length ?? 0,
            },
          }
        : {}),
    })),
    inputContract: contractSummary(spec.inputContract ?? {}),
    outputContract: contractSummary(spec.outputContract ?? {}),
    budgets: { ...(spec.modelPolicy ?? {}) },
    approvalPolicy: spec.approvalPolicy ?? null,
    evolutionPolicy: spec.evolutionPolicy ?? null,
  };
}
