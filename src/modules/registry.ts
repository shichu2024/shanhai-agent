import type Database from 'better-sqlite3';
import { contentHash, sha256Hex, uuid } from '../hash.js';
import { nowNs } from './traceRecorder.js';
import { AuditRecorder } from './recorders.js';
import { validateRegistration, type ValidationDeps } from './specValidator.js';
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
}

export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'RegistrationError';
  }
}

export class Registry {
  readonly audit: AuditRecorder;

  constructor(private readonly db: Database.Database) {
    this.audit = new AuditRecorder(db);
  }

  // ---------- Tool Registry（A2 附录 A） ----------

  registerTool(def: Omit<ToolRow, 'registeredAt'>, who: string): void {
    const existing = this.getTool(def.toolId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO tool_registry (toolId, name, kind, riskLevel, implVersion, paramSchema, controlledFieldsSchema, status, registeredAt)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          def.toolId, def.name, def.kind, def.riskLevel, def.implVersion,
          def.paramSchema, def.controlledFieldsSchema ?? null, def.status, nowNs(),
        );
      this.audit.versionEvent('tool_registered', who, def.toolId, {
        toolId: def.toolId, riskLevel: def.riskLevel, implVersion: def.implVersion,
      });
      return;
    }
    // 重登记：等级只能升不能降（防降级洗白——低等级重登记走人工库维护，不在 CLI 语义内）
    const order: RiskLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
    if (order.indexOf(def.riskLevel) < order.indexOf(existing.riskLevel)) {
      throw new Error(`工具 ${def.toolId} 等级只能升不能降：${existing.riskLevel} → ${def.riskLevel}（A2 附录 A）`);
    }
    this.db
      .prepare(
        `UPDATE tool_registry SET name=?, kind=?, riskLevel=?, implVersion=?, paramSchema=?, controlledFieldsSchema=?, status=? WHERE toolId=?`,
      )
      .run(def.name, def.kind, def.riskLevel, def.implVersion, def.paramSchema, def.controlledFieldsSchema ?? null, def.status, def.toolId);
    this.audit.versionEvent('tool_reregistered', who, def.toolId, {
      toolId: def.toolId,
      riskLevel: { old: existing.riskLevel, new: def.riskLevel },
      implVersion: { old: existing.implVersion, new: def.implVersion },
    });
  }

  getTool(toolId: string): ToolRow | null {
    return (this.db.prepare('SELECT * FROM tool_registry WHERE toolId = ?').get(toolId) as ToolRow | undefined) ?? null;
  }

  listTools(): ToolRow[] {
    return this.db.prepare('SELECT * FROM tool_registry ORDER BY toolId').all() as ToolRow[];
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

  private setPointer(agentId: string, versionId: string): void {
    this.db
      .prepare('INSERT INTO agent (agentId, currentVersionId, updatedAt) VALUES (?,?,?) ON CONFLICT(agentId) DO UPDATE SET currentVersionId = excluded.currentVersionId, updatedAt = excluded.updatedAt')
      .run(agentId, versionId, nowNs());
  }

  /** A5 §2 release：draft→released + 指针移动 + 审计 */
  release(agentId: string, versionId: string, who: string): void {
    const row = this.requireVersion(agentId, versionId);
    if (row.status !== 'draft') {
      this.cliReject(agentId, versionId, `release 仅允许 draft→released，当前 ${row.status}`, who);
    }
    this.db.prepare(`UPDATE agent_version SET status='released' WHERE versionId=?`).run(versionId);
    const oldPointer = this.getPointer(agentId);
    this.setPointer(agentId, versionId);
    this.audit.versionEvent('version_released', who, agentId, { agentId, versionId, pointer: { old: oldPointer, new: versionId } }, versionId);
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
    this.setPointer(agentId, versionId);
    this.audit.versionEvent('version_rollback', who, agentId, { agentId, versionId, pointer: { old: current, new: versionId }, operator: who }, versionId);
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
