import type Database from 'better-sqlite3';
import { contentHash, sha256Hex, uuid } from '../hash.js';
import { nowNs } from './traceRecorder.js';
import { AuditRecorder } from './recorders.js';
import type { RedactionPolicy } from './redaction.js';
import { validateRegistration, type ValidationDeps } from './specValidator.js';
import { buildAgentCard } from './agentCard.js';
import type { RiskLevel, VersionStatus } from '../types.js';

// A1 §5/§7：注册与不可变快照；A5 §1–§2：版本状态机 + 指针；A2 附录 A：Tool Registry（挂靠本模块）

export interface SpecRow {
  versionId: string;
  agentId: string;
  version: number;
  specSnapshot: string;
  contentHash: string;
  status: VersionStatus;
  registeredAt: string;
  registeredBy: string;
}

export interface ToolRow {
  toolId: string;
  name: string;
  kind: 'builtin' | 'external';
  riskLevel: RiskLevel;
  implVersion: string;
  paramSchema: string;
  controlledFieldsSchema: string | null;
  status: 'active' | 'retired';
  registeredAt: string;
  /** 第四阶段批次一（§4.1）：来源可追溯（builtin / mcp:<serverName>）；存量行 NULL */
  source?: string | null;
  /** 登记人（external 评级断言留痕；P3-3：辅助留痕，非审计强证据） */
  registeredBy?: string | null;
  /** 人类可读描述（MCP discovery 时取得） */
  description?: string | null;
}

/** registerTool 入参（元数据 3 列可选——builtin 种子登记不携带） */
export type ToolRegistration = Omit<ToolRow, 'registeredAt' | 'source' | 'registeredBy' | 'description'> & {
  source?: string | null;
  registeredBy?: string | null;
  description?: string | null;
};

export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'RegistrationError';
  }
}

/** A5 §1 v1.1：review 检视清单 5 项（顺序冻结，version_reviewed 载荷按此回填） */
export const REVIEW_ITEMS = ['tools', 'budgets', 'mission', 'approvalPolicy', 'contracts'] as const;

export class Registry {
  readonly audit: AuditRecorder;

  constructor(private readonly db: Database.Database, redaction: RedactionPolicy) {
    this.audit = new AuditRecorder(db, redaction); // 批次二（§4.2）：同实例注入（spec 拒绝面 rejectReason 过管道）
  }

  // ---------- Tool Registry（A2 附录 A） ----------

  /** external 登记前置校验（§4.3-1/§4.3-2，D-27）：L4 永禁 + paramSchema JSON Schema 合法性。
   *  拒绝 = 结构化（RejectedRequest 审计 + RegistrationError），防坏 schema 入库。 */
  private validateExternalToolDef(def: ToolRegistration, who: string): void {
    if (def.kind !== 'external') return;
    if (def.riskLevel === 'L4') {
      this.toolReject(def.toolId, who, `external 工具 L4 永久拒绝登记（D-8 外推：写安全域/凭据操作不属于「人工可审」范畴——external 实现不受平台审查，D-27）`);
    }
    let schema: unknown;
    try {
      schema = JSON.parse(def.paramSchema);
    } catch {
      this.toolReject(def.toolId, who, `external 工具 ${def.toolId} paramSchema 不是合法 JSON（登记即校验，防坏 schema 入库，§4.3-2）`);
    }
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      this.toolReject(def.toolId, who, `external 工具 ${def.toolId} paramSchema 必须为 JSON 对象（收到 ${Array.isArray(schema) ? '数组' : typeof schema}，§4.3-2）`);
    }
    const type = (schema as { type?: unknown }).type;
    if (type !== undefined && type !== 'object') {
      this.toolReject(def.toolId, who, `external 工具 ${def.toolId} paramSchema.type=${String(type)}——MCP 工具参数为对象，仅接受 object 型 schema（§4.3-2 登记时前置校验）`);
    }
  }

  /** 工具登记结构化拒绝（§4.3：审计留痕 + RegistrationError——外部评级治理拒绝面可审计） */
  private toolReject(toolId: string, who: string, reason: string): never {
    this.audit.rejectedRequest({
      kind: 'tool_registration',
      who,
      target: toolId,
      inputHash: sha256Hex(`${toolId}:${reason}`),
      rejectReason: JSON.stringify([{ path: '$', message: reason }]),
    });
    throw new RegistrationError(reason, [{ path: '$', message: reason }]);
  }

  registerTool(def: ToolRegistration, who: string): void {
    this.validateExternalToolDef(def, who);
    const existing = this.getTool(def.toolId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO tool_registry (toolId, name, kind, riskLevel, implVersion, paramSchema, controlledFieldsSchema, status, registeredAt, source, registeredBy, description)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          def.toolId, def.name, def.kind, def.riskLevel, def.implVersion,
          def.paramSchema, def.controlledFieldsSchema ?? null, def.status, nowNs(),
          def.source ?? null, def.registeredBy ?? null, def.description ?? null,
        );
      this.audit.versionEvent('tool_registered', who, def.toolId, {
        toolId: def.toolId, riskLevel: def.riskLevel, implVersion: def.implVersion,
        ...(def.source !== undefined && def.source !== null ? { source: def.source } : {}),
        ...(def.registeredBy !== undefined && def.registeredBy !== null ? { registeredBy: def.registeredBy } : {}),
      });
      return;
    }
    // 重登记：等级只能升不能降（防降级洗白——低等级重登记走人工库维护，不在 CLI 语义内）
    const order: RiskLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
    if (order.indexOf(def.riskLevel) < order.indexOf(existing.riskLevel)) {
      // §4.3-1（批次二，A-18）：结构化拒绝（审计留痕 + RegistrationError）
      this.toolReject(
        def.toolId, who,
        `工具 ${def.toolId} 等级只能升不能降：${existing.riskLevel} → ${def.riskLevel}（A2 附录 A）`,
      );
    }
    // P3-1（批次一遗留顺手修复）：重登记不携带元数据（undefined）→ 保留已有溯源，不静默清空
    const source = def.source ?? existing.source ?? null;
    const registeredBy = def.registeredBy ?? existing.registeredBy ?? null;
    const description = def.description ?? existing.description ?? null;
    this.db
      .prepare(
        `UPDATE tool_registry SET name=?, kind=?, riskLevel=?, implVersion=?, paramSchema=?, controlledFieldsSchema=?, status=?, source=?, registeredBy=?, description=? WHERE toolId=?`,
      )
      .run(
        def.name, def.kind, def.riskLevel, def.implVersion, def.paramSchema,
        def.controlledFieldsSchema ?? null, def.status, source, registeredBy, description, def.toolId,
      );
    this.audit.versionEvent('tool_reregistered', who, def.toolId, {
      toolId: def.toolId,
      riskLevel: { old: existing.riskLevel, new: def.riskLevel },
      implVersion: { old: existing.implVersion, new: def.implVersion },
      ...(source !== null ? { source } : {}), // P3-1：审计载荷反映实际持久化值（未携带 → 保留值）
      ...(registeredBy !== null ? { registeredBy } : {}),
    });
  }

  /** §4.1 退役：status=retired（在飞调用点按「已退役不可调用」拦截——既有闸门行为）；审计 tool_reregistered 载荷 action=retire */
  retireTool(toolId: string, who: string): void {
    const existing = this.getTool(toolId);
    if (!existing) {
      throw new Error(`工具 ${toolId} 不存在（retire 拒绝：无此登记）`);
    }
    this.db.prepare(`UPDATE tool_registry SET status='retired' WHERE toolId=?`).run(toolId);
    this.audit.versionEvent('tool_reregistered', who, toolId, {
      toolId,
      action: 'retire',
      riskLevel: existing.riskLevel,
      ...(existing.source ? { source: existing.source } : {}),
    });
  }

  getTool(toolId: string): ToolRow | null {
    return (this.db.prepare('SELECT * FROM tool_registry WHERE toolId = ?').get(toolId) as ToolRow | undefined) ?? null;
  }

  /** §4.1 `tool list` 模块面：kind / riskLevel 过滤（CLI 透传） */
  listTools(filter: { kind?: 'builtin' | 'external'; riskLevel?: RiskLevel } = {}): ToolRow[] {
    const rows = this.db.prepare('SELECT * FROM tool_registry ORDER BY toolId').all() as ToolRow[];
    return rows.filter((t) =>
      (filter.kind === undefined || t.kind === filter.kind) && (filter.riskLevel === undefined || t.riskLevel === filter.riskLevel),
    );
  }

  // ---------- Agent Registry（A1 §7 / A5） ----------

  /** A1 §7.1/§7.2 注册。任一校验失败 → 不写 AgentVersion + RejectedRequest + 指名字段路径错误（D-1） */
  registerSpec(spec: unknown, who: string, deps: ValidationDeps): string {
    const validation = validateRegistration(spec, deps);
    const snapshotJson = JSON.stringify(spec);
    const hash = contentHash(spec);
    if (!validation.ok) {
      this.audit.rejectedRequest({
        kind: 'spec_registration',
        who,
        target: (spec as { identity?: { agentId?: string } })?.identity?.agentId ?? '(unparseable)',
        inputHash: sha256Hex(snapshotJson),
        rejectReason: JSON.stringify(validation.issues),
      });
      throw new RegistrationError('Spec 注册被拒（A1 §4 准入校验失败）', validation.issues);
    }
    const agentId = (spec as { identity: { agentId: string } }).identity.agentId;

    // 哈希去重（A1 §5：同 agentId 同 hash 重复注册拒绝；P3-2 处置：写 RejectedRequest，与 C3-① 同源）
    const dup = this.db
      .prepare('SELECT versionId FROM agent_version WHERE agentId = ? AND contentHash = ?')
      .get(agentId, hash) as { versionId: string } | undefined;
    if (dup) {
      const reason = JSON.stringify([{ path: '$', message: `同 agentId 同 contentHash 重复注册（已有 ${dup.versionId}；文件改动必须重新注册生成新版本）` }]);
      this.audit.rejectedRequest({
        kind: 'spec_registration', who, target: agentId, inputHash: sha256Hex(snapshotJson),
        rejectReason: reason, agentVersionId: dup.versionId,
      });
      throw new RegistrationError('重复注册：contentHash 未变化（A1 §5）', JSON.parse(reason));
    }

    const versionId = uuid();
    const version = (this.db.prepare('SELECT COALESCE(MAX(version),0) AS m FROM agent_version WHERE agentId = ?').get(agentId) as { m: number }).m + 1;
    this.db
      .prepare(
        `INSERT INTO agent_version (versionId, agentId, version, specSnapshot, contentHash, status, registeredAt, registeredBy)
         VALUES (?,?,?,?,?,'draft',?,?)`,
      )
      .run(versionId, agentId, version, snapshotJson, hash, nowNs(), who);
    this.db
      .prepare('INSERT INTO agent (agentId, currentVersionId, updatedAt) VALUES (?,?,?) ON CONFLICT(agentId) DO UPDATE SET updatedAt = excluded.updatedAt')
      .run(agentId, null, nowNs());
    this.audit.versionEvent('version_registered', who, agentId, { agentId, versionId, contentHash: hash, version }, versionId);
    return versionId;
  }

  getVersion(versionId: string): SpecRow | null {
    return (this.db.prepare('SELECT * FROM agent_version WHERE versionId = ?').get(versionId) as SpecRow | undefined) ?? null;
  }

  listVersions(agentId: string): SpecRow[] {
    return this.db.prepare('SELECT * FROM agent_version WHERE agentId = ? ORDER BY version').all(agentId) as SpecRow[];
  }

  getPointer(agentId: string): string | null {
    const row = this.db.prepare('SELECT currentVersionId FROM agent WHERE agentId = ?').get(agentId) as { currentVersionId: string | null } | undefined;
    return row?.currentVersionId ?? null;
  }

  /** 批次四（§4.5，D-33）：Agent Card 只读派生——每次从 AgentVersion 快照现算，零存储写入、零审计事件。
   *  versionId 缺省取当前指针；派生面不设版本状态门（draft 快照同样可导出）。 */
  agentCard(agentId: string, versionId?: string): import('./agentCard.js').AgentCard {
    const vid = versionId ?? this.getPointer(agentId);
    if (!vid) {
      throw new RegistrationError(`agentCard：${agentId} 无当前指针版本（card 导出需显式 versionId 或已 release 移指针）`, []);
    }
    const row = this.getVersion(vid);
    if (!row || row.agentId !== agentId) {
      throw new RegistrationError(`agentCard：版本 ${vid} 不存在或不属于 agent ${agentId}`, []);
    }
    return buildAgentCard(row);
  }

  private setPointer(agentId: string, versionId: string): void {
    this.db
      .prepare('INSERT INTO agent (agentId, currentVersionId, updatedAt) VALUES (?,?,?) ON CONFLICT(agentId) DO UPDATE SET currentVersionId = excluded.currentVersionId, updatedAt = excluded.updatedAt')
      .run(agentId, versionId, nowNs());
  }

  /** A5 §1/§2 v1.1（D-10/D-12）：release 允许 draft→released（直发保留）或 reviewed→released；--no-pointer 发布不移指针（canary 入口） */
  release(agentId: string, versionId: string, who: string, opts: { noPointer?: boolean } = {}): void {
    const row = this.requireVersion(agentId, versionId);
    if (row.status !== 'draft' && row.status !== 'reviewed') {
      this.cliReject(agentId, versionId, `release 仅允许 draft→released（直发保留）或 reviewed→released，当前 ${row.status}`, who);
    }
    this.db.prepare(`UPDATE agent_version SET status='released' WHERE versionId=?`).run(versionId);
    if (opts.noPointer) {
      this.audit.versionEvent('version_released', who, agentId, { agentId, versionId, noPointer: true, pointer: { old: this.getPointer(agentId), new: this.getPointer(agentId) } }, versionId);
      return;
    }
    const oldPointer = this.getPointer(agentId);
    this.setPointer(agentId, versionId);
    this.audit.versionEvent('version_released', who, agentId, { agentId, versionId, noPointer: false, pointer: { old: oldPointer, new: versionId } }, versionId);
  }

  // ---------- A5 §1 v1.1：Reviewed 环（diff 驱动最小检视清单，D-10） ----------

  /** 检视清单 5 项（A5 §1：自动标注 diff，人工逐项确认） */
  buildReviewDiff(agentId: string, versionId: string): { diffAgainst: string | null; items: { item: string; changed: boolean; detail: string; flag: 'red' | 'yellow' | null }[] } {
    const row = this.requireVersion(agentId, versionId);
    const prev = this.db
      .prepare(
        `SELECT versionId, specSnapshot FROM agent_version
         WHERE agentId = ? AND versionId != ? AND status = 'released' ORDER BY version DESC LIMIT 1`,
      )
      .get(agentId, versionId) as { versionId: string; specSnapshot: string } | undefined;
    const next = JSON.parse(row.specSnapshot) as Record<string, Record<string, unknown>>;
    if (!prev) {
      return {
        diffAgainst: null,
        items: REVIEW_ITEMS.map((item) => ({ item, changed: false, detail: '无上一 Released 版本（首个发布，无 diff 基线）', flag: null })),
      };
    }
    const old = JSON.parse(prev.specSnapshot) as Record<string, Record<string, unknown>>;

    // ① 工具集变化（新增/移除；风险等级上调重点标红）
    const toolsOf = (s: Record<string, Record<string, unknown>>) =>
      new Map(((s.toolPolicy?.tools ?? []) as { toolId: string; riskLevel: string }[]).map((t) => [t.toolId, t.riskLevel]));
    const oldTools = toolsOf(old);
    const newTools = toolsOf(next);
    const added = [...newTools.keys()].filter((t) => !oldTools.has(t));
    const removed = [...oldTools.keys()].filter((t) => !newTools.has(t));
    const order = ['L0', 'L1', 'L2', 'L3', 'L4'];
    const upgraded = [...newTools.keys()].filter((t) => oldTools.has(t) && order.indexOf(newTools.get(t)!) > order.indexOf(oldTools.get(t)!));
    const toolChanged = added.length + removed.length + upgraded.length > 0;
    const toolDetail = `新增 [${added.join(', ') || '—'}]；移除 [${removed.join(', ') || '—'}]；等级上调 [${upgraded.map((t) => `${t}:${oldTools.get(t)}→${newTools.get(t)}`).join(', ') || '—'}]`;

    // ② 预算变化（maxModelCalls / maxTokens，增幅 >50% 标黄）
    const budgetOf = (s: Record<string, Record<string, unknown>>, key: string) => Number(s.modelPolicy?.[key] ?? 0);
    const budgetDeltas = (['maxModelCalls', 'maxTokens'] as const).map((k) => {
      const o = budgetOf(old, k);
      const n = budgetOf(next, k);
      const delta = o > 0 ? Math.round(((n - o) / o) * 100) : null;
      return { k, o, n, delta };
    });
    const budgetChanged = budgetDeltas.some((d) => d.o !== d.n);
    const budgetFlag = budgetDeltas.some((d) => d.delta !== null && d.delta > 50) ? ('yellow' as const) : null;
    const budgetDetail = budgetDeltas.map((d) => `${d.k}: ${d.o}→${d.n}${d.delta !== null ? `（${d.delta >= 0 ? '+' : ''}${d.delta}%）` : ''}`).join('；');

    // ③ mission 职责/非职责边界变化
    const missionChanged = JSON.stringify(old.mission) !== JSON.stringify(next.mission);
    // ④ approvalPolicy 变化（新高风险工具准入）
    const approvalChanged = JSON.stringify(old.approvalPolicy ?? null) !== JSON.stringify(next.approvalPolicy ?? null);
    // ⑤ input/outputContract 结构变化
    const inputChanged = JSON.stringify(old.inputContract) !== JSON.stringify(next.inputContract);
    const outputChanged = JSON.stringify(old.outputContract) !== JSON.stringify(next.outputContract);

    return {
      diffAgainst: prev.versionId,
      items: [
        {
          item: REVIEW_ITEMS[0], changed: toolChanged, detail: toolDetail,
          flag: upgraded.length > 0 ? ('red' as const) : null,
        },
        { item: REVIEW_ITEMS[1], changed: budgetChanged, detail: budgetDetail, flag: budgetFlag },
        {
          item: REVIEW_ITEMS[2], changed: missionChanged,
          detail: missionChanged ? 'mission 职责/非职责边界发生变化（对照旧版逐条核对）' : '无变化', flag: null,
        },
        {
          item: REVIEW_ITEMS[3], changed: approvalChanged,
          detail: approvalChanged
            ? `approvalPolicy 变化：${JSON.stringify(old.approvalPolicy ?? null)} → ${JSON.stringify(next.approvalPolicy ?? null)}（新高风险工具准入须复核）`
            : '无变化', flag: approvalChanged ? ('red' as const) : null,
        },
        {
          item: REVIEW_ITEMS[4], changed: inputChanged || outputChanged,
          detail: `inputContract ${inputChanged ? '变化' : '无变化'}；outputContract ${outputChanged ? '变化' : '无变化'}`,
          flag: null,
        },
      ],
    };
  }

  /** A5 §1 v1.1：Draft→Reviewed 检视门——5 项清单逐项确认（任一 false → 拒绝迁移 + RejectedRequest 审计） */
  review(
    agentId: string,
    versionId: string,
    who: string,
    checklist: { item: string; verdict: boolean; note?: string }[],
    evalId?: string,
  ): { diffAgainst: string | null } {
    const row = this.requireVersion(agentId, versionId);
    if (row.status !== 'draft') {
      this.cliReject(agentId, versionId, `review 仅允许 draft→reviewed，当前 ${row.status}（无回退边——质量门判定不可撤销，只能重新注册新版本）`, who);
    }
    const diff = this.buildReviewDiff(agentId, versionId);
    const byItem = new Map(checklist.map((c) => [c.item, c]));
    const missing = REVIEW_ITEMS.filter((item) => !byItem.has(item));
    if (missing.length > 0) {
      this.cliReject(agentId, versionId, `检视清单不完整（缺 ${missing.join(', ')}；5 项须逐项确认）`, who);
    }
    const unknown = checklist.filter((c) => !(REVIEW_ITEMS as readonly string[]).includes(c.item));
    if (unknown.length > 0) {
      this.cliReject(agentId, versionId, `检视清单含未知项（${unknown.map((c) => c.item).join(', ')}；合法项 = ${REVIEW_ITEMS.join(', ')}）`, who);
    }
    const failed = REVIEW_ITEMS.filter((item) => byItem.get(item)!.verdict !== true);
    if (failed.length > 0) {
      this.cliReject(agentId, versionId, `检视清单存在未通过项（${failed.join(', ')}）——拒绝迁移 Draft→Reviewed（A5 §1）`, who);
    }
    this.db.prepare(`UPDATE agent_version SET status='reviewed' WHERE versionId=?`).run(versionId);
    this.audit.versionEvent('version_reviewed', who, agentId, {
      agentId, versionId,
      evalId: evalId ?? null,
      checklist: REVIEW_ITEMS.map((item) => ({ item, verdict: true, note: byItem.get(item)?.note })),
      diffAgainst: diff.diffAgainst, // 检视内容可追溯（A6 §5 v1.1）
    }, versionId);
    return { diffAgainst: diff.diffAgainst };
  }

  // ---------- A5 §3a/§4a v1.1：灰度双指针 + 权重分派（D-12） ----------

  getCanary(agentId: string): { canaryVersionId: string | null; canaryWeight: number } {
    const row = this.db
      .prepare('SELECT canaryVersionId, canaryWeight FROM agent WHERE agentId = ?')
      .get(agentId) as { canaryVersionId: string | null; canaryWeight: number } | undefined;
    return { canaryVersionId: row?.canaryVersionId ?? null, canaryWeight: row?.canaryWeight ?? 0 };
  }

  /** canary set：目标须 Released 且 ≠ current（结构入口 = release --no-pointer + canary set，P1-2 修复） */
  canarySet(agentId: string, versionId: string, weight: number, who: string): void {
    const row = this.requireVersion(agentId, versionId);
    if (row.status !== 'released') {
      this.cliReject(agentId, versionId, `canary 目标必须为 Released（当前 ${row.status}；正确入口：release --no-pointer → canary set）`, who);
    }
    if (this.getPointer(agentId) === versionId) {
      this.cliReject(agentId, versionId, 'canary 目标不得等于 current 指针目标（先 release --no-pointer 发布，或 rollback current）', who);
    }
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      this.cliReject(agentId, versionId, `canaryWeight 必须为 0-100 整数（收到 ${weight}）`, who);
    }
    this.db
      .prepare('UPDATE agent SET canaryVersionId = ?, canaryWeight = ?, updatedAt = ? WHERE agentId = ?')
      .run(versionId, weight, nowNs(), agentId);
    this.audit.versionEvent('canary_configured', who, agentId, { agentId, versionId, weight, op: 'set' }, versionId);
  }

  /** canary clear：灰度归零（立即，审计）——回退判据路径 */
  canaryClear(agentId: string, who: string): void {
    const before = this.getCanary(agentId);
    this.db
      .prepare('UPDATE agent SET canaryVersionId = NULL, canaryWeight = 0, updatedAt = ? WHERE agentId = ?')
      .run(nowNs(), agentId);
    this.audit.versionEvent('canary_configured', who, agentId, { agentId, op: 'clear', previous: before }, before.canaryVersionId);
  }

  /** promote：canary→current 晋升 + canary 清零（report 判据为建议，决定权留人，A5 §2） */
  promote(agentId: string, who: string): string {
    const canary = this.getCanary(agentId);
    if (!canary.canaryVersionId || canary.canaryWeight === 0) {
      this.cliReject(agentId, '-', `无有效灰度可晋升（canaryVersionId=${canary.canaryVersionId ?? 'NULL'}，weight=${canary.canaryWeight}）`, who);
    }
    const oldPointer = this.getPointer(agentId);
    this.setPointer(agentId, canary.canaryVersionId);
    this.db
      .prepare('UPDATE agent SET canaryVersionId = NULL, canaryWeight = 0, updatedAt = ? WHERE agentId = ?')
      .run(nowNs(), agentId);
    this.audit.versionEvent('version_promoted', who, agentId, { agentId, versionId: canary.canaryVersionId, pointer: { old: oldPointer, new: canary.canaryVersionId } }, canary.canaryVersionId);
    return canary.canaryVersionId;
  }

  /** A5 §1-6 deprecate：禁止 deprecate 当前指针目标版（P2-6） */
  deprecate(agentId: string, versionId: string, who: string): void {
    const row = this.requireVersion(agentId, versionId);
    if (row.status !== 'released') {
      this.cliReject(agentId, versionId, `deprecate 仅允许 released→deprecated，当前 ${row.status}`, who);
    }
    if (this.getPointer(agentId) === versionId) {
      this.cliReject(
        agentId, versionId,
        '禁止 deprecate 当前指针目标版：先 rollback 到其他 Released 版本，或 release 新版本（A5 §1-6，P2-6）',
        who,
      );
    }
    if (this.getCanary(agentId).canaryVersionId === versionId) {
      this.cliReject(
        agentId, versionId,
        '禁止 deprecate canary 指针目标版：先 canary clear 或换目标（A5 §1-6 v1.1，P2-6 同规则）',
        who,
      );
    }
    this.db.prepare(`UPDATE agent_version SET status='deprecated' WHERE versionId=?`).run(versionId);
    this.audit.versionEvent('version_deprecated', who, agentId, { agentId, versionId, pointer: { old: this.getPointer(agentId), new: this.getPointer(agentId) } }, versionId);
  }

  /** A5 §2 rollback：仅指针移动，不产生新版本、不改快照；目标必须为 Released 且非当前指针 */
  rollback(agentId: string, versionId: string, who: string): void {
    const row = this.requireVersion(agentId, versionId);
    if (row.status !== 'released') {
      this.cliReject(agentId, versionId, `rollback 目标必须为 Released（当前 ${row.status}，Draft/Deprecated 不可为目标）`, who);
    }
    const current = this.getPointer(agentId);
    if (current === versionId) {
      this.cliReject(agentId, versionId, 'rollback 目标即当前指针目标，无迁移发生', who);
    }
    // §4.5-1（批次三，A-7）：rollback×canary 互斥——防 current==canary 非法态（与 deprecate P2-6 防护对称、消息口径同款）
    if (this.getCanary(agentId).canaryVersionId === versionId) {
      this.cliReject(
        agentId, versionId,
        '禁止 rollback 至 canary 指针目标版：先 canary clear 或换目标（A5 §1-6 v1.1，P2-6 同规则）',
        who,
      );
    }
    this.setPointer(agentId, versionId);
    this.audit.versionEvent('version_rollback', who, agentId, { agentId, versionId, pointer: { old: current, new: versionId }, operator: who }, versionId);
  }

  /** §4.5-5/6（批次三，D-24）：evolutionPolicy 回溯解析单一实现——CLI 与测试两处消费本导出。
   * 回溯遍历 listVersions 全量倒序（版本号从新到旧），不按指针位置、不按版本状态：
   * 已弃用（Deprecated）版本的 evolutionPolicy 声明仍统治现行策略（Evolution 是 Agent 级资产，
   * 与 D-14 聚合键=agentId 同向；仅看指针反而会在回滚后静默失效）。
   * 未声明且无可回溯声明 → null（行为等同不产生候选，并非缺省写入 false）。 */
  evolutionPolicyOf(agentId: string): import('./evolution.js').EvolutionPolicy | null {
    for (const v of this.listVersions(agentId).slice().reverse()) {
      try {
        const spec = JSON.parse(v.specSnapshot) as { evolutionPolicy?: import('./evolution.js').EvolutionPolicy };
        if (spec.evolutionPolicy) return spec.evolutionPolicy;
      } catch { /* 快照损坏跳过（AgentVersion 不可变——防御） */ }
    }
    return null;
  }

  private requireVersion(agentId: string, versionId: string): SpecRow {
    const row = this.getVersion(versionId);
    if (!row || row.agentId !== agentId) {
      this.cliReject(agentId, versionId, '版本不存在或不属于该 agentId', 'cli');
    }
    return row;
  }

  private cliReject(agentId: string, versionId: string, reason: string, who: string): never {
    this.audit.rejectedRequest({
      kind: 'cli_operation', who, target: `${agentId}/${versionId}`,
      inputHash: sha256Hex(`${agentId}:${versionId}`), rejectReason: JSON.stringify([{ path: '$', message: reason }]),
      agentVersionId: versionId,
    });
    throw new RegistrationError(reason, [{ path: '$', message: reason }]);
  }
}
