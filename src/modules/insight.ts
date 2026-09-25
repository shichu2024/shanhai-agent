import type Database from 'better-sqlite3';
import { nowNs, type TraceRecorder } from './traceRecorder.js';
import type { Registry } from './registry.js';
import type { CapabilityManager } from './capabilityRegistry.js';
import { buildCapabilityTrend, type TrendBucketRow } from './trend.js';

// WP-5B 批次三（第五阶段设计 §4.4，D-40 / D-41）：自我认知报告——组合只读制品。
//
// 定位：四层拼合的单一 CLI 输出，只读现算、永不存储（无 insight 快照表/写入——
// 归档是人动作，非系统行为，与 Agent Card 同款）；首期不注入任何任务上下文（§9-2）。
// 与 Agent Card 分权：Card = 点态声明面（单版本 spec 派生）；insight = 时段行为面
// （证据流派生）——「我声明是什么」vs「证据表明我表现如何」。
//
// 声明面冻结字段子集（V0.2 P2-2 / D-41，防不可证伪）：INSIGHT_CARD_FIELD_KEYS 常量
// 导出 + 实现消费同一导出 + 测试逐字段存在性断言（CARD_FIELD_KEYS 纪律同款）——
// 直接取 buildAgentCard 输出对应字段，多字段/少字段/换序均被断言拦下。
//
// derived 接线（§4.2 生成时机）：capability list / agent insight 时惰性重算（同款模式）。
// 「永不存储」指 insight 制品本体零写入；derived 重算的 candidate INSERT 是 §4.2
// 既有语义（登记即事实），不与本条冲突。

/** 声明面冻结字段子集（§4.4 / A-30：常量导出 + 实现消费 + 测试断言，D-41 纪律同款） */
export const INSIGHT_CARD_FIELD_KEYS = [
  'agentId', 'versionId', 'specVersion', 'contentHash', 'mission', 'nonGoals', 'tools',
] as const;
export type InsightCardField = (typeof INSIGHT_CARD_FIELD_KEYS)[number];

/** 行为面缺省窗口（§4.4：趋势缺省近 30 天窗） */
export const INSIGHT_WINDOW_DAYS_DEFAULT = 30;

export interface InsightDeps {
  db: Database.Database;
  trace: TraceRecorder;
  registry: Registry;
  capabilities: CapabilityManager;
}

export interface InsightAssertionEntry {
  capabilityId: string;
  kind: string;
  statement: string;
  origin: string;
  evidenceCount: number;
}

export interface InsightAnswer {
  agentId: string;
  versionId: string;
  generatedAt: string;
  /** 声明面：Agent Card 派生冻结字段子集（键序 = INSIGHT_CARD_FIELD_KEYS） */
  declared: Record<InsightCardField, unknown>;
  /** 断言面：active 条目 + open candidates 摘要计数 */
  assertions: {
    active: { counts: { capability: number; limitation: number }; entries: InsightAssertionEntry[] };
    openCandidates: { total: number; evidencePending: number };
    /** 无 Registry 条目 → 空清单 + 提示（不是错误，§6-5 异常路径） */
    emptyHint: string | null;
  };
  /** 行为面：趋势缺省近 30 天窗（day 桶） */
  behavior: {
    since: string;
    bucket: 'day';
    buckets: TrendBucketRow[];
    status: 'ok' | 'insufficient-sample';
    insufficientNote: string | null;
  };
  /** 限制与证据摘要：limitation 条目 + 各面证据引用计数（不展开 payload） */
  limitations: {
    entries: InsightAssertionEntry[];
    evidenceSummary: Record<string, number>;
  };
}

export function buildAgentInsight(
  deps: InsightDeps,
  agentId: string,
  opts: { versionId?: string; since?: string } = {},
): InsightAnswer {
  // 1. 声明面：复用 Agent Card 派生输出，取冻结子集（registry.agentCard 缺省当前指针版本；
  //    无指针版本 → RegistrationError 结构化上抛，由 CLI 面errors出口呈现）
  const card = deps.registry.agentCard(agentId, opts.versionId);
  const declared = {} as Record<InsightCardField, unknown>;
  for (const key of INSIGHT_CARD_FIELD_KEYS) {
    declared[key] = card[key];
  }

  // derived 惰性重算接线（§4.2 生成时机：capability list / agent insight 同款）
  deps.capabilities.recomputeDerived();

  // 2. 断言面 + 4. 限制与证据摘要（同一查询两用；retired = 已退场不进制品摘要）
  const rows = deps.db
    .prepare(`SELECT * FROM capability_registry WHERE agentId = ? AND status != 'retired' ORDER BY createdAt DESC, capabilityId`)
    .all(agentId) as {
    capabilityId: string;
    kind: string;
    statement: string;
    origin: string;
    evidenceRefs: string;
    status: string;
  }[];
  const entryOf = (r: (typeof rows)[number]): InsightAssertionEntry => ({
    capabilityId: r.capabilityId,
    kind: r.kind,
    statement: r.statement,
    origin: r.origin,
    evidenceCount: (JSON.parse(r.evidenceRefs) as unknown[]).length,
  });
  const activeRows = rows.filter((r) => r.status === 'active');
  const candidateRows = rows.filter((r) => r.status === 'candidate');
  const evidenceSummary: Record<string, number> = {};
  for (const r of rows) {
    for (const ref of JSON.parse(r.evidenceRefs) as { kind: string }[]) {
      evidenceSummary[ref.kind] = (evidenceSummary[ref.kind] ?? 0) + 1; // 引用计数，不展开 payload
    }
  }

  // 3. 行为面：趋势缺省近 30 天窗（day 桶）
  const since =
    opts.since !== undefined
      ? opts.since
      : new Date(Date.now() - INSIGHT_WINDOW_DAYS_DEFAULT * 24 * 3600 * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, '.000000000Z');
  const trend = buildCapabilityTrend(deps.db, deps.trace, agentId, { since, bucket: 'day' });
  const totalTasks = trend.buckets.reduce((s, b) => s + b.tasks.total, 0);
  const insufficient = totalTasks === 0;

  return {
    agentId,
    versionId: card.versionId,
    generatedAt: nowNs(),
    declared,
    assertions: {
      active: {
        counts: {
          capability: activeRows.filter((r) => r.kind === 'capability').length,
          limitation: activeRows.filter((r) => r.kind === 'limitation').length,
        },
        entries: activeRows.map(entryOf),
      },
      openCandidates: {
        total: candidateRows.length,
        evidencePending: candidateRows.filter((r) => (JSON.parse(r.evidenceRefs) as unknown[]).length === 0).length,
      },
      emptyHint:
        rows.length === 0
          ? 'Registry 无该 agent 条目——capability add 人工登记，或等 derived 判据窗口内数据积累（空清单非错误）'
          : null,
    },
    behavior: {
      since,
      bucket: 'day',
      buckets: trend.buckets,
      status: insufficient ? 'insufficient-sample' : 'ok',
      insufficientNote: insufficient
        ? `insufficient-sample：窗口内无任务数据（since=${since}）——系统不假装给了答案`
        : null,
    },
    limitations: {
      entries: rows.filter((r) => r.kind === 'limitation').map(entryOf),
      evidenceSummary,
    },
  };
}
