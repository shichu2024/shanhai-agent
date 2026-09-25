import type Database from 'better-sqlite3';
import { uuid, sha256Hex } from '../hash.js';
import { nowNs, type TraceRecorder } from './traceRecorder.js';
import { parseEvidenceRef, EvidenceRefError, type EvidenceStore } from './evidenceStore.js';
import { EXCLUDED_FROM_CONTRACT_RATE, evolutionNotInPlaceholders } from './subclassRegistry.js';
import type { AuditRecorder } from './recorders.js';

// WP-5B 批次二（第五阶段设计 §4.2，D-37/D-38）：Capability/Limitation Registry。
//
// 定位：结构化断言登记（statement + 证据引用 + 状态 + 确认留痕）——从第一阶段「只读能力快照」
// 升级为独立载体。三分权（成文）：memory_record = episodic 内容记忆（注入上下文，管内容可信度）；
// evolution_candidate = 变更建议（proposedChange，回答「该改什么」）；capability_registry = 状态断言
// （statement，回答「现在是什么样」）。互链不互改：本模块永不触碰 memory 状态机（A-28 分权断言）。
//
// 状态机（最小三态）：candidate --confirm--> active --retire--> retired（无出边）；
// dismiss = 从 candidate 退场 retired + decidedAt/decidedBy 留痕（decision 区分记在审计载荷——
// 表内同为 retired，语义差异由 capability_decided 的 decision=retire/dismiss 承载）。
//
// 去重（V0.2 P1-2 部分唯一索引）：仅对非 retired 行生效——retired 只表示「本条断言已退场」，
// 同义新断言（人工重加，或未来证据再触发 derived）按新行登记不被阻挡；
// 「derived 不复活 retired 行」由重算逻辑的跨全状态同义查询保证（遇同义行——任何状态——
// 不再 INSERT），部分唯一索引本身只拦非 retired 新 INSERT，两层语义不可混同（批次一验收沉淀）。
//
// derived 候选生成（惰性、幂等、机械判据）：R1 失败集中度 / R2 工具失败集中，
// 生成时机 = capability list 时惰性重算（agent insight 侧接线属批次三）；
// statement = 冻结模板常量（计数值不进 statement——含计数会使 digest 随窗口推移漂移）。
// 系统机械动作无任务上下文 → 审计流是正确落点（derived 生成亦留审计，§4.2 成文）。

export const CAPABILITY_KINDS = ['capability', 'limitation'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const CAPABILITY_STATUSES = ['candidate', 'active', 'retired'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** A-26 / P3-1：statement 超 2000 字符 fail-fast 拒绝（不截断——截断腐蚀去重键：
 * 两条同前缀长断言 digest 碰撞被误并；resultMaxChars P3-2 先例同款） */
export const CAPABILITY_STATEMENT_MAX_CHARS = 2000;

/** R1 阈值（§4.2）：窗口内 agentId × 非 infra 失败 subClass 计数 ≥3 且占同期失败总数 ≥50%。
 * 分母与 trend/report 同谓词（V0.2 P3-2，逐字相同 SQL 谓词）：
 * countedInContractRate=1 AND task.status != 'cancelled'——杜绝第三口径。 */
export const R1_COUNT_THRESHOLD = 3;
export const R1_SHARE_THRESHOLD = 0.5;
/** R2 阈值（§4.2）：窗口内 toolId 调用失败率 ≥50% 且样本 ≥3（样本 = 终态调用数：成功 + 终局失败） */
export const R2_SAMPLE_MIN = 3;
export const R2_FAILURE_RATE_THRESHOLD = 0.5;
/** 判据窗口缺省 30 天（§4.2） */
export const CAPABILITY_WINDOW_DAYS_DEFAULT = 30;

/**
 * 冻结模板常量（§4.2 / A-27）：statement 只用 subClass/toolId 等稳定键，计数值不进 statement。
 * 机械防线：模板本身不含数字字符（回归断言锚定——模板一旦混入计数/阈值即测试失败）。
 */
export const R1_STATEMENT_TEMPLATE =
  '失败集中：近期窗口内同类失败（子类 {subClass}）反复出现——该代理在此类失败上存在能力限制';
export const R2_STATEMENT_TEMPLATE =
  '工具限制：近期窗口内工具 {toolId} 调用反复失败——该代理对此工具的可用性受限';

/** statementDigest 规范化（§4.2 / P3-3）：单一导出函数 manual/derived 共用，防双算漂移。
 * 口径 = NFC → trim → 内部连续空白折叠单空格 → 小写化 → sha256。 */
export function normalizeStatement(statement: string): string {
  return statement.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function statementDigest(statement: string): string {
  return sha256Hex(normalizeStatement(statement));
}

export interface StoredEvidenceRef {
  kind: string;
  id: string;
  occurredAt: string;
}

export interface CapabilityRow {
  capabilityId: string;
  agentId: string;
  kind: CapabilityKind;
  statement: string;
  origin: 'derived' | 'manual';
  evidenceRefs: string; // JSON [{kind,id,occurredAt}]
  statementDigest: string;
  status: CapabilityStatus;
  createdAt: string;
  lastUpdatedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** evidencePending = 草稿形态派生标注（无列——由 evidenceRefs 空与否现算；「人类知道但暂无运行证据」） */
export function isEvidencePending(row: CapabilityRow): boolean {
  return (JSON.parse(row.evidenceRefs) as StoredEvidenceRef[]).length === 0;
}

export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_kind'
      | 'invalid_statement'
      | 'statement_too_long'
      | 'invalid_ref'
      | 'evidence_unresolvable'
      | 'duplicate'
      | 'not_found'
      | 'invalid_transition'
      | 'evidence_pending',
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export interface CapabilityDeps {
  db: Database.Database;
  trace: TraceRecorder;
  evidence: EvidenceStore;
  audit: AuditRecorder;
  /** 判据窗口天数（缺省 30） */
  windowDays?: number;
}

interface R1Group {
  agentId: string;
  subClass: string;
  count: number;
}

interface ToolStat {
  agentId: string;
  toolId: string;
  ok: number;
  fail: number;
  failEventIds: { eventId: string; occurredAt: string }[];
}

export class CapabilityManager {
  constructor(private readonly deps: CapabilityDeps) {}

  /**
   * `capability add`（A-26 / D-38）：人工登记 → candidate 行 + capability_registered 审计。
   * - 证据可空（candidate 落库 + evidencePending 标注——草稿形态）；
   * - 提供了 ref 但任一不可解析（含 eval 预留位）→ 整单拒绝（草稿可以无证据，不可以假证据）；
   * - statement >2000 字符 fail-fast 拒绝（P3-1，不截断）；
   * - 同义非 retired 行存在 → duplicate 拒绝（部分唯一索引）。
   */
  add(input: {
    agentId: string;
    kind: string;
    statement: string;
    evidence?: string[];
    by?: string;
  }): CapabilityRow {
    if (!(CAPABILITY_KINDS as readonly string[]).includes(input.kind)) {
      throw new CapabilityError(`kind 非法（封闭枚举 ${CAPABILITY_KINDS.join('/')}）：${input.kind}`, 'invalid_kind', { kind: input.kind });
    }
    if (input.statement.trim().length === 0) {
      throw new CapabilityError('statement 不可为空', 'invalid_statement');
    }
    if (input.statement.length > CAPABILITY_STATEMENT_MAX_CHARS) {
      throw new CapabilityError(
        `statement ${input.statement.length} 字符超上限 ${CAPABILITY_STATEMENT_MAX_CHARS}——fail-fast 拒绝（不截断：截断腐蚀去重键，P3-1）`,
        'statement_too_long',
        { length: input.statement.length, max: CAPABILITY_STATEMENT_MAX_CHARS },
      );
    }
    // 证据 ref 全量前置解析（先全部验证再落库——整单拒绝零部分写入）
    const refs: StoredEvidenceRef[] = [];
    for (const raw of input.evidence ?? []) {
      const ref = this.resolveRefOrReject(raw);
      refs.push(ref);
    }
    return this.insertRow({
      agentId: input.agentId,
      kind: input.kind as CapabilityKind,
      statement: input.statement,
      origin: 'manual',
      evidenceRefs: refs,
      who: input.by ?? 'cli',
    });
  }

  /** `capability confirm`（D-38 修订 V0.2 P2-1）：candidate → active。
   * 强制证据 ≥1 且全部可解析——无证据不激活（真正要保的不变量在 confirm 端，
   * 与「derived 只生成不激活」对称；add 侧仅拒假证据）。 */
  confirm(capabilityId: string, by?: string): CapabilityRow {
    const row = this.requireRow(capabilityId);
    if (row.status !== 'candidate') {
      throw new CapabilityError(
        `不可 confirm：status=${row.status}（状态机唯一迁移边 candidate --confirm--> active）`,
        'invalid_transition',
        { status: row.status },
      );
    }
    const refs = JSON.parse(row.evidenceRefs) as StoredEvidenceRef[];
    if (refs.length === 0) {
      throw new CapabilityError(
        'confirm 被拒：证据为空（evidencePending 草稿不可激活——无证据不激活，D-38；证据到达后再 confirm）',
        'evidence_pending',
        { capabilityId },
      );
    }
    for (const ref of refs) {
      this.requireResolvable(ref);
    }
    const at = nowNs();
    this.deps.db
      .prepare(`UPDATE capability_registry SET status='active', lastUpdatedAt=?, decidedAt=?, decidedBy=? WHERE capabilityId=?`)
      .run(at, at, by ?? 'cli', capabilityId);
    this.deps.audit.versionEvent('capability_decided', by ?? 'cli', capabilityId, {
      decision: 'confirm', agentId: row.agentId, kind: row.kind, origin: row.origin,
    });
    return this.requireRow(capabilityId);
  }

  /** `capability retire`：→ retired（无出边）。active 退场 decision=retire；
   * candidate 退场 = dismiss（§4.2 状态机——dismiss 即 candidate 的退场路径，decidedAt/decidedBy 留痕，
   * decision 区分记在审计载荷）。 */
  retire(capabilityId: string, by?: string): CapabilityRow {
    const row = this.requireRow(capabilityId);
    if (row.status !== 'candidate' && row.status !== 'active') {
      throw new CapabilityError(`不可退场：status=${row.status}（retired 无出边）`, 'invalid_transition', { status: row.status });
    }
    const decision = row.status === 'candidate' ? 'dismiss' : 'retire';
    const at = nowNs();
    this.deps.db
      .prepare(`UPDATE capability_registry SET status='retired', lastUpdatedAt=?, decidedAt=?, decidedBy=? WHERE capabilityId=?`)
      .run(at, at, by ?? 'cli', capabilityId);
    this.deps.audit.versionEvent('capability_decided', by ?? 'cli', capabilityId, {
      decision, agentId: row.agentId, kind: row.kind, origin: row.origin,
    });
    return this.requireRow(capabilityId);
  }

  /** `capability list [--agent] [--kind] [--status]`：先惰性重算 derived 候选（R1/R2），再按条件返回 */
  list(filter: { agent?: string; kind?: string; status?: string } = {}): CapabilityRow[] {
    this.recomputeDerived();
    const conds: string[] = [];
    const args: unknown[] = [];
    if (filter.agent) {
      conds.push('agentId = ?');
      args.push(filter.agent);
    }
    if (filter.kind) {
      conds.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.status) {
      conds.push('status = ?');
      args.push(filter.status);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    return this.deps.db
      .prepare(`SELECT * FROM capability_registry ${where} ORDER BY createdAt DESC, capabilityId`)
      .all(...args) as CapabilityRow[];
  }

  /**
   * derived 惰性重算（§4.2；list 时执行，与 evolution 聚合 / memory 校正同一模式）：
   * R1 失败集中度 + R2 工具失败集中 → 新 limitation candidate INSERT + capability_registered 审计。
   * 幂等口径 = 跨全状态同义查询：同义行存在（candidate/active/retired 任何状态）→ 跳过——
   * 非 retired 同义行存在即不重开；同义 retired 行不复活、不阻挡（P1-2：人工可重加，
   * derived 自身不回潮）。返回新建 capabilityId 列表（同数据重算恒为空）。
   */
  recomputeDerived(): string[] {
    const created: string[] = [];
    for (const candidate of [...this.deriveR1(), ...this.deriveR2()]) {
      const exists = this.deps.db
        .prepare('SELECT 1 FROM capability_registry WHERE agentId = ? AND kind = ? AND statementDigest = ?')
        .get(candidate.agentId, 'limitation', candidate.digest);
      if (exists) continue; // 跨全状态同义查询：含 retired——不复活也不阻挡，由人工决定是否重加
      const capabilityId = this.insertRow({
        agentId: candidate.agentId,
        kind: 'limitation',
        statement: candidate.statement,
        origin: 'derived',
        evidenceRefs: candidate.refs,
        who: 'system:capability-derive',
      }).capabilityId;
      created.push(capabilityId);
    }
    return created;
  }

  // ---------- derived 判据 ----------

  /** R1 失败集中度：窗口内 agentId × 非 infra 失败 subClass 计数 ≥3 且占同期失败总数 ≥50%。
   * 分子分母同一谓词（P3-2 逐字相同）：countedInContractRate=1 AND t.status != 'cancelled'。 */
  private deriveR1(): { agentId: string; statement: string; digest: string; refs: StoredEvidenceRef[] }[] {
    const cutoff = this.windowCutoff();
    const { db } = this.deps;
    const groups = db
      .prepare(
        `SELECT f.agentId AS agentId, f.subClass AS subClass, COUNT(*) AS count
         FROM failure_record f JOIN task_record t ON t.taskId = f.taskId
         WHERE f.countedInContractRate = 1 AND t.status != 'cancelled'
           AND f.occurredAt >= ? AND f.subClass NOT IN (${evolutionNotInPlaceholders()})
         GROUP BY f.agentId, f.subClass HAVING count >= ?`,
      )
      .all(cutoff, ...EXCLUDED_FROM_CONTRACT_RATE, R1_COUNT_THRESHOLD) as R1Group[];
    const out: { agentId: string; statement: string; digest: string; refs: StoredEvidenceRef[] }[] = [];
    for (const g of groups) {
      const denominator = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM failure_record f JOIN task_record t ON t.taskId = f.taskId
             WHERE f.agentId = ? AND f.countedInContractRate = 1 AND t.status != 'cancelled'
               AND f.occurredAt >= ? AND f.subClass NOT IN (${evolutionNotInPlaceholders()})`,
          )
          .get(g.agentId, cutoff, ...EXCLUDED_FROM_CONTRACT_RATE) as { c: number }
      ).c;
      if (denominator === 0 || g.count / denominator < R1_SHARE_THRESHOLD) continue;
      const statement = R1_STATEMENT_TEMPLATE.split('{subClass}').join(g.subClass);
      const refs = (
        db
          .prepare(
            `SELECT recordId, occurredAt FROM failure_record f JOIN task_record t ON t.taskId = f.taskId
             WHERE f.agentId = ? AND f.subClass = ? AND f.countedInContractRate = 1 AND t.status != 'cancelled'
               AND f.occurredAt >= ?
             ORDER BY f.occurredAt LIMIT 50`,
          )
          .all(g.agentId, g.subClass, cutoff) as { recordId: string; occurredAt: string }[]
      ).map((r) => ({ kind: 'failure', id: r.recordId, occurredAt: r.occurredAt }));
      out.push({ agentId: g.agentId, statement, digest: statementDigest(statement), refs });
    }
    return out;
  }

  /** R2 工具失败集中：窗口内 toolId 调用失败率 ≥50% 且样本 ≥3。
   * 数据源 = trace JSONL（唯一带 toolId 的调用面）：样本 = tool_call_executed（成功）+
   * terminal attempt_failed（willRetry=false，failureClass=Tool）；toolId 关联自同 callNo 的
   * tool_call_requested。只读扫描（readEvents 既有读取路径，零新事件）。 */
  private deriveR2(): { agentId: string; statement: string; digest: string; refs: StoredEvidenceRef[] }[] {
    const cutoff = this.windowCutoff();
    const taskIds = this.deps.db
      .prepare(`SELECT DISTINCT taskId FROM trace_index WHERE eventType = 'tool_call_requested'`)
      .all() as { taskId: string }[];
    const stats = new Map<string, ToolStat>();
    for (const { taskId } of taskIds) {
      const events = this.deps.trace.readEvents(taskId);
      const callTool = new Map<number, string>();
      for (const e of events) {
        if (e.callKind !== 'tool' || e.timestamp < cutoff) continue;
        if (e.eventType === 'tool_call_requested') {
          callTool.set(e.callNo, String(e.toolId ?? ''));
        } else if (e.eventType === 'tool_call_executed') {
          this.bump(stats, String(e.agentId), String(e.toolId ?? '')).ok += 1;
        } else if (e.eventType === 'attempt_failed') {
          const toolId = String(e.toolId ?? callTool.get(e.callNo) ?? '');
          if (toolId === '' || e.failureClass !== 'Tool' || e.willRetry === true) continue;
          const stat = this.bump(stats, String(e.agentId), toolId);
          stat.fail += 1;
          stat.failEventIds.push({ eventId: e.eventId, occurredAt: e.timestamp });
        }
      }
    }
    const out: { agentId: string; statement: string; digest: string; refs: StoredEvidenceRef[] }[] = [];
    for (const stat of stats.values()) {
      const sample = stat.ok + stat.fail;
      if (sample < R2_SAMPLE_MIN || stat.fail / sample < R2_FAILURE_RATE_THRESHOLD) continue;
      const statement = R2_STATEMENT_TEMPLATE.split('{toolId}').join(stat.toolId);
      out.push({
        agentId: stat.agentId,
        statement,
        digest: statementDigest(statement),
        refs: stat.failEventIds.slice(0, 50).map((x) => ({ kind: 'trace_event', id: x.eventId, occurredAt: x.occurredAt })),
      });
    }
    return out;
  }

  private bump(stats: Map<string, ToolStat>, agentId: string, toolId: string): ToolStat {
    const key = `${agentId} ${toolId}`;
    let stat = stats.get(key);
    if (!stat) {
      stat = { agentId, toolId, ok: 0, fail: 0, failEventIds: [] };
      stats.set(key, stat);
    }
    return stat;
  }

  // ---------- 共用底层 ----------

  private insertRow(input: {
    agentId: string;
    kind: CapabilityKind;
    statement: string;
    origin: 'derived' | 'manual';
    evidenceRefs: StoredEvidenceRef[];
    who: string;
  }): CapabilityRow {
    const capabilityId = uuid();
    const at = nowNs();
    const digest = statementDigest(input.statement); // P3-3：manual/derived 共用同一导出函数
    try {
      this.deps.db
        .prepare(
          `INSERT INTO capability_registry
           (capabilityId, agentId, kind, statement, origin, evidenceRefs, statementDigest, status, createdAt, lastUpdatedAt)
           VALUES (?,?,?,?,?,?,?,'candidate',?,?)`,
        )
        .run(capabilityId, input.agentId, input.kind, input.statement, input.origin, JSON.stringify(input.evidenceRefs), digest, at, at);
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new CapabilityError(
          `同义断言已登记（agentId × kind × statementDigest 去重，仅对非 retired 行生效）：${input.agentId}/${input.kind}`,
          'duplicate',
          { agentId: input.agentId, kind: input.kind, statementDigest: digest },
        );
      }
      throw err;
    }
    this.deps.audit.versionEvent('capability_registered', input.who, capabilityId, {
      origin: input.origin,
      agentId: input.agentId,
      kind: input.kind,
      statementDigest: digest,
      evidencePending: input.evidenceRefs.length === 0,
      evidenceCount: input.evidenceRefs.length,
    });
    return this.requireRow(capabilityId);
  }

  /** ref 解析 + 现库可解析（add 侧整单拒绝口径：格式非法 / 不存在 / eval 预留位均拒） */
  private resolveRefOrReject(raw: string): StoredEvidenceRef {
    let parsed;
    try {
      parsed = parseEvidenceRef(raw);
    } catch (err) {
      if (err instanceof EvidenceRefError) {
        throw new CapabilityError(`证据 ref 格式非法：${err.message}`, 'invalid_ref', { ref: raw });
      }
      throw err;
    }
    const shown = this.deps.evidence.show(raw);
    if (!shown.ok) {
      throw new CapabilityError(
        `证据 ref 不可解析（${shown.code}）——整单拒绝（草稿可以无证据，不可以假证据）：${raw}`,
        'evidence_unresolvable',
        { ref: raw, evidenceCode: shown.code },
      );
    }
    return { kind: parsed.kind, id: parsed.id, occurredAt: shown.occurredAt };
  }

  /** confirm 侧强校验：已登记 ref 必须仍然全部可解析（引用不存在的证据不得进入 active，§9-4） */
  private requireResolvable(ref: StoredEvidenceRef): void {
    const shown = this.deps.evidence.show(`${ref.kind}:${ref.id}`);
    if (!shown.ok) {
      throw new CapabilityError(
        `confirm 被拒：证据不可解析（${shown.code}）——无证据不激活（D-38）：${ref.kind}:${ref.id}`,
        'evidence_unresolvable',
        { ref: `${ref.kind}:${ref.id}`, evidenceCode: shown.code },
      );
    }
  }

  private requireRow(capabilityId: string): CapabilityRow {
    const row = this.deps.db
      .prepare('SELECT * FROM capability_registry WHERE capabilityId = ?')
      .get(capabilityId) as CapabilityRow | undefined;
    if (!row) throw new CapabilityError(`能力断言不存在：${capabilityId}`, 'not_found', { capabilityId });
    return row;
  }

  /** 窗口起点（与 evolution 冷却窗同款格式：亚秒 9 位，字符串比较与落盘口径对齐） */
  private windowCutoff(): string {
    const days = this.deps.windowDays ?? CAPABILITY_WINDOW_DAYS_DEFAULT;
    return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '.000000000Z');
  }
}
