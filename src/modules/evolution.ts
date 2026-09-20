import type Database from 'better-sqlite3';
import { uuid } from '../hash.js';
import { nowNs } from './traceRecorder.js';
import { EXCLUDED_FROM_CONTRACT_RATE, evolutionNotInPlaceholders } from './subclassRegistry.js';

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
  /** §4.4-3（批次三，D-22）：候选确认后人工起草注册新版本时 CLI --from-candidate 显式回填（JSON 数组，默认 []；不自动关联） */
  derivedVersionIds: string;
  /** §4.5-4（批次三，D-25）：dismiss 落库时间——冷却窗（默认 7 天，可配）内同 agentId+trigger 不重生候选 */
  dismissedAt: string | null;
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

/** A4 §4 C2 排除口径同源：infra 类失败不计入 Evolution 聚合（失败模式归因不可信）——
 * §4.4-1（批次三）：单一常量源 subclassRegistry（消费点①常量 + ②SQL 参数化，无本地双份） */
const EXCLUDED_SUBCLASSES = EXCLUDED_FROM_CONTRACT_RATE;

export class EvolutionError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'already_decided' | 'not_open') {
    super(message);
    this.name = 'EvolutionError';
  }
}

export interface EvolutionDeps {
  db: Database.Database;
  /** §4.5-4（D-25）：dismiss 冷却窗天数（config.local.json evolution.dismissCooldownDays；缺省 7） */
  dismissCooldownDays?: number;
}

export class EvolutionManager {
  constructor(private readonly deps: EvolutionDeps) {}

  /**
   * 惰性聚合（list 时执行，与审批超时惰性判定同一模式）：
   * repeated_failure 按 agentId 聚类——同 subClass 失败 ≥ failureThreshold（默认 3，infra 类不计入）
   * → 生成 EvolutionCandidate，并回填 failure_record.evolutionCandidateId（激活预留列）。
   *
   * D-14 冻结口径（§4.4-2 批次三成文）：聚合键 = agentId（跨版本），幂等键 = agentId + trigger。
   * 多 subClass 同超阈值时，第一个子类创建候选，第二个子类证据回填进既有 open 候选
   * （evidenceRefs 追加）——这是设计语义而非缺陷：候选是 agentId 级演进 backlog，不按 subClass 拆分。
   *
   * §4.5-4（批次三，D-25）：dismiss 冷却——同 agentId+trigger 的 dismissed 候选 dismissedAt 在
   * 冷却窗内（默认 7 天，可配）→ 不重生；到期恢复生成（候选可再出，不静默吞）。
   */
  aggregateRepeatedFailures(policiesOf: (agentId: string) => EvolutionPolicy | null): string[] {
    const { db } = this.deps;
    const cooldownDays = this.deps.dismissCooldownDays ?? 7;
    const cooldownCutoff = new Date(Date.now() - cooldownDays * 24 * 3600 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '.000000000Z');
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
           WHERE agentId = ? AND subClass NOT IN (${evolutionNotInPlaceholders()})
           GROUP BY subClass HAVING tasks >= ?`,
        )
        .all(agentId, ...EXCLUDED_FROM_CONTRACT_RATE, threshold) as { subClass: string; tasks: number }[];
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
        ).filter((r) => !(EXCLUDED_SUBCLASSES as readonly string[]).includes(r.subClass));
        if (existingOpen) {
          // 幂等：open 候选存在 → 只同步 evidenceRefs（追加新证据）与回填
          this.backfill(existingOpen.candidateId, refs);
          continue;
        }
        // §4.5-4 dismiss 冷却：同 agentId+trigger 窗内已 dismissed → 跳过（到期自然恢复生成）；
        // cooldownDays = 0 → 冷却关闭（即时允许重生——运行时配置边界）
        const inCooldown =
          cooldownDays > 0
            ? db
                .prepare(
                  `SELECT 1 FROM evolution_candidate
                   WHERE agentId = ? AND trigger = 'repeated_failure' AND status = 'dismissed' AND dismissedAt > ?`,
                )
                .get(agentId, cooldownCutoff)
            : undefined;
        if (inCooldown) continue;
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

  /** 人工驳回（演进 backlog 管理，与 confirm 对称）；§4.5-4：dismissedAt 落库（冷却窗起算点） */
  dismiss(candidateId: string, who: string): EvolutionCandidateRow {
    const row = this.requireOpen(candidateId);
    const at = nowNs();
    this.deps.db
      .prepare(`UPDATE evolution_candidate SET status='dismissed', dismissedAt = ?, decidedAt = ?, decidedBy = ? WHERE candidateId = ?`)
      .run(at, at, who, candidateId);
    return this.get(candidateId)!;
  }

  /** §4.4-3（D-22）：候选↔版本关联显式回填——人工起草注册新版本时 CLI --from-candidate 调用（幂等，不自动关联） */
  attachDerivedVersion(candidateId: string, versionId: string): EvolutionCandidateRow {
    const row = this.get(candidateId);
    if (!row) throw new EvolutionError(`演进候选不存在：${candidateId}`, 'not_found');
    let ids: string[];
    try {
      ids = JSON.parse(row.derivedVersionIds ?? '[]') as string[];
      if (!Array.isArray(ids)) ids = [];
    } catch {
      ids = []; // 存量异常形态（防御）：视为空数组，不炸回填
    }
    if (!ids.includes(versionId)) {
      this.deps.db
        .prepare(`UPDATE evolution_candidate SET derivedVersionIds = ? WHERE candidateId = ?`)
        .run(JSON.stringify([...ids, versionId]), candidateId);
    }
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
