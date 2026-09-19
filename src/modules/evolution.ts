import type Database from 'better-sqlite3';
import { uuid } from '../hash.js';
import { nowNs } from './traceRecorder.js';

// 设计 §4.5 v1.1（D-14）：Evolution Policy（女娲最小形态）——人工确认制。
// 硬边界（冻结）：系统永不自动注册、自动发布——自动化上限 = 产生带证据链接的候选；
// 聚合键 = agentId（跨版本，失败模式是 Agent 级资产），evidenceRefs 回链具体 agentVersionId。
// 候选不指向「谁的下一版」，指向 agentId 的演进 backlog（版本不可变 → 产物新版本由人工起草）。
// 举证载体 = EvolutionCandidate 表 + failure_record.evolutionCandidateId 回填 + 既有版本审计事件
//（A6 v1.1 未为 Evolution 定义 Trace 事件——封闭集纪律，不现场即造）。

export interface EvolutionCandidateRow {
  candidateId: string;
  agentId: string;
  trigger: 'repeated_failure' | 'capability_degradation';
  evidenceRefs: string; // JSON [{taskId, agentVersionId, subClass, occurredAt}]
  status: 'open' | 'confirmed' | 'dismissed';
  proposedChange: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface EvidenceRef {
  taskId: string;
  agentVersionId: string;
  subClass: string;
  occurredAt: string;
}

export interface EvolutionPolicy {
  allowed: boolean;
  triggers?: ('repeated_failure' | 'capability_degradation')[];
  failureThreshold?: number;
  guardrails?: { requireReviewed?: true };
}

/** A4 §4 C2 排除口径同源：infra 类失败不计入 Evolution 聚合（失败模式归因不可信） */
const EXCLUDED_SUBCLASSES = new Set(['provider_infra', 'provider_rejected_schema']);

export class EvolutionError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'already_decided' | 'not_open') {
    super(message);
    this.name = 'EvolutionError';
  }
}

export interface EvolutionDeps {
  db: Database.Database;
}

export class EvolutionManager {
  constructor(private readonly deps: EvolutionDeps) {}

  /**
   * 惰性聚合（list 时执行，与审批超时惰性判定同一模式）：
   * repeated_failure 按 agentId 聚类——同 subClass 失败 ≥ failureThreshold（默认 3，infra 类不计入）
   * → 生成 EvolutionCandidate（幂等：同 agentId 同 subClass 已有 open 候选不重复生成），
   * 并回填 failure_record.evolutionCandidateId（激活预留列）。
   */
  aggregateRepeatedFailures(policiesOf: (agentId: string) => EvolutionPolicy | null): string[] {
    const { db } = this.deps;
    const created: string[] = [];
    const agents = db.prepare('SELECT DISTINCT agentId FROM failure_record').all() as { agentId: string }[];
    for (const { agentId } of agents) {
      const policy = policiesOf(agentId);
      if (!policy || policy.allowed !== true) continue;
      if (!(policy.triggers ?? ['repeated_failure']).includes('repeated_failure')) continue;
      const threshold = policy.failureThreshold ?? 3;
      const groups = db
        .prepare(
          `SELECT subClass, COUNT(DISTINCT taskId) AS tasks FROM failure_record
           WHERE agentId = ? AND subClass NOT IN ('provider_infra','provider_rejected_schema')
           GROUP BY subClass HAVING tasks >= ?`,
        )
        .all(agentId, threshold) as { subClass: string; tasks: number }[];
      for (const group of groups) {
        const existingOpen = db
          .prepare(`SELECT candidateId FROM evolution_candidate WHERE agentId = ? AND trigger = 'repeated_failure' AND status = 'open'`)
          .get(agentId) as { candidateId: string } | undefined;
        const refs = (
          db
            .prepare(
              `SELECT taskId, agentVersionId, subClass, occurredAt FROM failure_record
               WHERE agentId = ? AND subClass = ? ORDER BY occurredAt LIMIT 50`,
            )
            .all(agentId, group.subClass) as EvidenceRef[]
        ).filter((r) => !EXCLUDED_SUBCLASSES.has(r.subClass));
        if (existingOpen) {
          // 幂等：open 候选存在 → 只同步 evidenceRefs（追加新证据）与回填
          this.backfill(existingOpen.candidateId, refs);
          continue;
        }
        const candidateId = uuid();
        const tx = db.transaction(() => {
          db.prepare(
            `INSERT INTO evolution_candidate (candidateId, agentId, trigger, evidenceRefs, status, createdAt)
             VALUES (?,?, 'repeated_failure', ?, 'open', ?)`,
          ).run(candidateId, agentId, JSON.stringify(refs), nowNs());
          this.backfill(candidateId, refs);
        });
        tx();
        created.push(candidateId);
      }
    }
    return created;
  }

  /** 预留列激活回填（A3 §4）：evidenceRefs 对应 failure_record.evolutionCandidateId */
  private backfill(candidateId: string, refs: EvidenceRef[]): void {
    const stmt = this.deps.db.prepare(
      `UPDATE failure_record SET evolutionCandidateId = ? WHERE taskId = ? AND subClass = ? AND evolutionCandidateId IS NULL`,
    );
    for (const r of refs) stmt.run(candidateId, r.taskId, r.subClass);
  }

  list(): EvolutionCandidateRow[] {
    return this.deps.db.prepare('SELECT * FROM evolution_candidate ORDER BY createdAt DESC').all() as EvolutionCandidateRow[];
  }

  get(candidateId: string): EvolutionCandidateRow | null {
    return (this.deps.db.prepare('SELECT * FROM evolution_candidate WHERE candidateId = ?').get(candidateId) as EvolutionCandidateRow | undefined) ?? null;
  }

  /** 人工确认（D-14 人工确认制）：open → confirmed——产物新版本由人工起草（register → review → release --no-pointer → canary） */
  confirm(candidateId: string, who: string, proposedChange?: string): EvolutionCandidateRow {
    const row = this.requireOpen(candidateId);
    this.deps.db
      .prepare(`UPDATE evolution_candidate SET status='confirmed', proposedChange = ?, decidedAt = ?, decidedBy = ? WHERE candidateId = ?`)
      .run(proposedChange ?? row.proposedChange ?? null, nowNs(), who, candidateId);
    return this.get(candidateId)!;
  }

  /** 人工驳回（演进 backlog 管理，与 confirm 对称） */
  dismiss(candidateId: string, who: string): EvolutionCandidateRow {
    const row = this.requireOpen(candidateId);
    this.deps.db
      .prepare(`UPDATE evolution_candidate SET status='dismissed', decidedAt = ?, decidedBy = ? WHERE candidateId = ?`)
      .run(nowNs(), who, candidateId);
    return this.get(candidateId)!;
  }

  private requireOpen(candidateId: string): EvolutionCandidateRow {
    const row = this.get(candidateId);
    if (!row) throw new EvolutionError(`演进候选不存在：${candidateId}`, 'not_found');
    if (row.status !== 'open') {
      throw new EvolutionError(`候选已裁决（status=${row.status}${row.decidedBy ? ` by ${row.decidedBy}` : ''}）`, 'already_decided');
    }
    return row;
  }
}
