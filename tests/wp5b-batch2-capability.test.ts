import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, type Harness } from './helpers.js';
import {
  CapabilityManager,
  CapabilityError,
  R1_STATEMENT_TEMPLATE,
  R2_STATEMENT_TEMPLATE,
  normalizeStatement,
  statementDigest,
  CAPABILITY_STATEMENT_MAX_CHARS,
} from '../src/modules/capabilityRegistry.js';

// WP-5B 批次二（§4.2，D-37/D-38）：Capability/Limitation Registry。
// A-26 add/confirm 语义（无证据不激活 + 假证据整单拒 + statement 上限）
// A-27 derived 幂等（R1/R2 判据 + 部分唯一索引 retired 不阻挡/不复活 + 冻结模板）
// A-28 状态机三态 + 审计 ×2 载荷 + memory_record 分权（Registry 全操作不触碰）

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function caps(h: Harness): CapabilityManager {
  return h.rt.capabilities;
}

const versionCache = new Map<string, string>();
function versionOf(h: Harness, agentId: string): string {
  let v = versionCache.get(agentId);
  if (!v) {
    v = registerAndRelease(h.rt, sampleSpec({ agentId }));
    versionCache.set(agentId, v);
  }
  return v;
}

/** 造一条「已发布 agent + 任务 + failure_record」并返回引用（R1 判据 / 证据 ref 基座） */
function seedFailure(
  h: Harness,
  agentId: string,
  subClass: 'schema_violation' | 'unparseable_output' | 'provider_infra' | 'provider_error',
  opts: { taskStatus?: string } = {},
): { taskId: string; recordId: string; versionId: string } {
  const versionId = versionOf(h, agentId);
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  if (opts.taskStatus) {
    dbOf(h.rt).prepare('UPDATE task_record SET status = ? WHERE taskId = ?').run(opts.taskStatus, taskId);
  }
  const recordId = h.rt.failures.record({
    taskId, agentId, agentVersionId: versionId, attemptNo: 1,
    failureClass: 'Model', subClass,
    message: `失败演示（${subClass}）`, expectedVsActual: { expected: 'ok', actual: subClass },
  });
  return { taskId, recordId, versionId };
}

/** R2 基座：向任务 trace 写一对 requested/attempt_failed（terminal）或 requested/executed */
function seedToolCall(
  h: Harness,
  agentId: string,
  callNo: number,
  toolId: string,
  outcome: 'fail' | 'ok',
): { taskId: string; versionId: string } {
  const versionId = versionOf(h, agentId);
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const specHash = (
    dbOf(h.rt).prepare('SELECT specContentHash FROM task_record WHERE taskId = ?').get(taskId) as { specContentHash: string }
  ).specContentHash;
  const base = { taskId, agentId, agentVersionId: versionId, specContentHash: specHash };
  h.rt.trace.recordCallEvent(base, 'tool_call_requested', 'tool', callNo, 1, { toolId, argsDigest: 'd' });
  if (outcome === 'fail') {
    h.rt.trace.recordCallEvent(base, 'attempt_failed', 'tool', callNo, 1, {
      failureClass: 'Tool', subClass: 'execution_failed', message: '工具失败演示', willRetry: false,
    });
  } else {
    h.rt.trace.recordCallEvent(base, 'tool_call_executed', 'tool', callNo, 1, {
      toolId, latencyMs: 1, resultDigest: 'd', riskLevel: 'L0', audited: false,
    });
  }
  return { taskId, versionId };
}

function countRows(h: Harness, table: string): number {
  return (dbOf(h.rt).prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function auditPayloads(h: Harness, eventType: string): Record<string, unknown>[] {
  return (
    dbOf(h.rt).prepare('SELECT payload FROM audit_events WHERE eventType = ?').all(eventType) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

// ============================================================
// 迁移与表结构（§4.2：唯一新表 + 部分唯一索引，零 ADD COLUMN、零回填）
// ============================================================

describe('WP-5B 批次二迁移：capability_registry 新表 + 部分唯一索引', () => {
  it('表存在；idx_capability_dedup 为部分唯一索引（WHERE status != retired）；idx_capability_agent 在', () => {
    const h = makeHarness([]);
    const idx = dbOf(h.rt)
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN ('idx_capability_agent','idx_capability_dedup')`)
      .all() as { name: string; sql: string }[];
    const byName = new Map(idx.map((i) => [i.name, i.sql]));
    expect(byName.get('idx_capability_agent')).toContain('ON capability_registry');
    const dedup = byName.get('idx_capability_dedup') ?? '';
    expect(dedup).toContain('UNIQUE');
    expect(dedup).toContain("WHERE status != 'retired'");
    expect(() => dbOf(h.rt).prepare('SELECT capabilityId FROM capability_registry LIMIT 1').get()).not.toThrow();
  });

  it('部分唯一索引直接效果：非 retired 同义行被拦；retired 后同义新行可入（P1-2）', () => {
    const h = makeHarness([]);
    const db = dbOf(h.rt);
    const ins = (id: string, status: string, digest: string) =>
      db
        .prepare(
          `INSERT INTO capability_registry (capabilityId, agentId, kind, statement, origin, evidenceRefs, statementDigest, status, createdAt, lastUpdatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, 'a-x', 'limitation', '同义断言', 'manual', '[]', digest, status, '2026-09-26T00:00:00.000000000Z', '2026-09-26T00:00:00.000000000Z');
    expect(() => ins('c-1', 'candidate', 'dg-1')).not.toThrow();
    expect(() => ins('c-2', 'candidate', 'dg-1')).toThrow(); // 非 retired 同义 → 唯一索引拦
    expect(() => ins('c-3', 'active', 'dg-1')).toThrow(); // active 同义 → 同拦
    // retired 后：同义新行（非 retired）可入——retired 行不在索引内
    db.prepare(`UPDATE capability_registry SET status='retired' WHERE capabilityId='c-1'`).run();
    expect(() => ins('c-4', 'candidate', 'dg-1')).not.toThrow();
  });
});

// ============================================================
// statementDigest 单一导出 + 冻结模板（P3-3 / A-27 机械防线）
// ============================================================

describe('WP-5B 批次二：statementDigest 规范化单一导出 + 冻结模板', () => {
  it('normalizeStatement = NFC + trim + 内部连续空白折叠单空格 + 小写化', () => {
    expect(normalizeStatement('  Foo   Bar\n')).toBe('foo bar');
    expect(normalizeStatement('ＡＢ')).toBe('ａｂ'); // NFC 保持全角形态，仅小写化
    expect(statementDigest('Foo  Bar')).toBe(statementDigest('  foo bar '));
    expect(statementDigest('foo bar')).not.toBe(statementDigest('foo baz'));
  });

  it('冻结模板为常量导出且不含数字字符（A-27 机械防线：计数值不进 statement）', () => {
    expect(R1_STATEMENT_TEMPLATE).toContain('{subClass}');
    expect(R2_STATEMENT_TEMPLATE).toContain('{toolId}');
    expect(R1_STATEMENT_TEMPLATE).not.toMatch(/\d/);
    expect(R2_STATEMENT_TEMPLATE).not.toMatch(/\d/);
    expect(CAPABILITY_STATEMENT_MAX_CHARS).toBe(2000);
  });
});

// ============================================================
// A-26：add / confirm 语义
// ============================================================

describe('WP-5B 批次二 A-26：add 与 confirm（无证据不激活，D-38）', () => {
  it('add 证据全解析 → candidate 行 + capability_registered 审计（载荷含 origin=manual）', () => {
    const h = makeHarness([]);
    const { recordId } = seedFailure(h, 'cap-a1', 'schema_violation');
    const row = caps(h).add({
      agentId: 'cap-a1', kind: 'limitation', statement: '长任务输出常截断，需分段产出',
      evidence: [`failure:${recordId}`], by: 'tester',
    });
    expect(row.status).toBe('candidate');
    expect(row.origin).toBe('manual');
    expect(JSON.parse(row.evidenceRefs)).toEqual([
      { kind: 'failure', id: recordId, occurredAt: expect.any(String) },
    ]);
    expect(row.decidedAt).toBeNull();
    const audits = auditPayloads(h, 'capability_registered');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ origin: 'manual', agentId: 'cap-a1', kind: 'limitation', evidencePending: false });
  });

  it('add 证据为空 → candidate 行 + evidencePending: true 标注（草稿形态成立）', () => {
    const h = makeHarness([]);
    const row = caps(h).add({ agentId: 'cap-a2', kind: 'capability', statement: '可稳定产出结构化摘要' });
    expect(row.status).toBe('candidate');
    expect(JSON.parse(row.evidenceRefs)).toEqual([]);
    expect(auditPayloads(h, 'capability_registered')[0]).toMatchObject({ evidencePending: true });
  });

  it('add 假证据（不可解析 ref）→ 整单拒绝（草稿可以无证据，不可以假证据）：零行零审计', () => {
    const h = makeHarness([]);
    const { recordId } = seedFailure(h, 'cap-a3', 'schema_violation');
    for (const bad of ['failure:ghost', 'ghostref', 'eval:some-id']) {
      expect(() => caps(h).add({ agentId: 'cap-a3', kind: 'limitation', statement: '假证据演示', evidence: [`failure:${recordId}`, bad] }))
        .toThrow(CapabilityError);
    }
    expect(countRows(h, 'capability_registry')).toBe(0);
    expect(auditPayloads(h, 'capability_registered')).toHaveLength(0);
  });

  it('add 非法 kind / 空 statement / statement >2000 字符 → 结构化 fail-fast 拒绝（P3-1，不截断）', () => {
    const h = makeHarness([]);
    const add = (statement: string, kind = 'limitation') =>
      () => caps(h).add({ agentId: 'cap-a4', kind, statement });
    expect(add('ok', 'wrong-kind')).toThrow(CapabilityError);
    expect(add('ok', '')).toThrow(CapabilityError);
    expect(add('   ')).toThrow(CapabilityError);
    const tooLong = '长'.repeat(CAPABILITY_STATEMENT_MAX_CHARS + 1);
    try {
      add(tooLong)();
      expect.unreachable('应抛 statement_too_long');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe('statement_too_long');
    }
    expect(add('长'.repeat(CAPABILITY_STATEMENT_MAX_CHARS))).not.toThrow(); // 边界值 = 恰好 2000 可入
    expect(countRows(h, 'capability_registry')).toBe(1);
  });

  it('add 同义断言（仅大小写/空白差异 → 同 digest）→ 重复拒绝（部分唯一索引）', () => {
    const h = makeHarness([]);
    caps(h).add({ agentId: 'cap-a5', kind: 'limitation', statement: 'Foo  Bar 限制' });
    expect(() => caps(h).add({ agentId: 'cap-a5', kind: 'limitation', statement: '  foo bar 限制 ' })).toThrow(CapabilityError);
    // kind 不同 → 不算同义（dedup 键含 kind）
    expect(() => caps(h).add({ agentId: 'cap-a5', kind: 'capability', statement: 'foo bar 限制' })).not.toThrow();
    // agentId 不同 → 不算同义
    expect(() => caps(h).add({ agentId: 'cap-a5b', kind: 'limitation', statement: 'foo bar 限制' })).not.toThrow();
  });

  it('confirm 证据为空 → 结构化拒绝（evidence_pending），草稿保留 candidate', () => {
    const h = makeHarness([]);
    const row = caps(h).add({ agentId: 'cap-a6', kind: 'capability', statement: '暂无证据的草稿' });
    try {
      caps(h).confirm(row.capabilityId);
      expect.unreachable('应抛 evidence_pending');
    } catch (err) {
      expect((err as CapabilityError).code).toBe('evidence_pending');
    }
    const after = caps(h).list().find((r) => r.capabilityId === row.capabilityId)!;
    expect(after.status).toBe('candidate');
  });

  it('confirm 证据不可解析（登记后证据被删）→ 结构化拒绝（无证据不激活）', () => {
    const h = makeHarness([]);
    const { recordId } = seedFailure(h, 'cap-a7', 'schema_violation');
    const row = caps(h).add({ agentId: 'cap-a7', kind: 'limitation', statement: '证据漂移演示', evidence: [`failure:${recordId}`] });
    dbOf(h.rt).prepare('DELETE FROM failure_record WHERE recordId = ?').run(recordId);
    try {
      caps(h).confirm(row.capabilityId);
      expect.unreachable('应抛 evidence_unresolvable');
    } catch (err) {
      expect((err as CapabilityError).code).toBe('evidence_unresolvable');
    }
  });

  it('confirm 证据齐且全解析 → active + decidedAt/decidedBy 留痕 + capability_decided(decision=confirm)', () => {
    const h = makeHarness([]);
    const { recordId } = seedFailure(h, 'cap-a8', 'schema_violation');
    const row = caps(h).add({ agentId: 'cap-a8', kind: 'limitation', statement: '可确认的限制', evidence: [`failure:${recordId}`] });
    const active = caps(h).confirm(row.capabilityId, 'human-1');
    expect(active.status).toBe('active');
    expect(active.decidedAt).toEqual(expect.any(String));
    expect(active.decidedBy).toBe('human-1');
    expect(auditPayloads(h, 'capability_decided')[0]).toMatchObject({ decision: 'confirm', agentId: 'cap-a8' });
    // 已决断不可再 confirm（无出边自 active）
    expect(() => caps(h).confirm(row.capabilityId)).toThrow(CapabilityError);
  });

  it('confirm 不存在 id → not_found 结构化错误', () => {
    const h = makeHarness([]);
    expect(() => caps(h).confirm('ghost')).toThrow(CapabilityError);
  });
});

// ============================================================
// A-27：derived 惰性重算（R1/R2）+ 幂等 + retired 语义
// ============================================================

describe('WP-5B 批次二 A-27：R1 失败集中度 derived 生成', () => {
  it('窗口内同 subClass 计数 =3 且占失败总数 100% → limitation candidate（模板 statement + 证据可解析 + derived 审计）', () => {
    const h = makeHarness([]);
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-r1a', 'schema_violation');
    const rows = caps(h).list();
    const derived = rows.filter((r) => r.origin === 'derived');
    expect(derived).toHaveLength(1);
    const d = derived[0];
    expect(d.kind).toBe('limitation');
    expect(d.status).toBe('candidate');
    expect(d.agentId).toBe('cap-r1a');
    expect(d.statement).toBe(R1_STATEMENT_TEMPLATE.split('{subClass}').join('schema_violation'));
    expect(d.statementDigest).toBe(statementDigest(d.statement));
    expect(d.statement).not.toMatch(/\d/); // derived statement 不含数字字符（A-27 回归断言）
    const refs = JSON.parse(d.evidenceRefs) as { kind: string; id: string }[];
    expect(refs).toHaveLength(3);
    for (const r of refs) {
      expect(h.rt.evidence.show(`${r.kind}:${r.id}`).ok).toBe(true); // derived 证据可解析
    }
    expect(auditPayloads(h, 'capability_registered').some((p) => p.origin === 'derived')).toBe(true);
  });

  it('同数据二次 list 零新增（幂等口径 = 非 retired 同义行存在即跳过）', () => {
    const h = makeHarness([]);
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-r1b', 'schema_violation');
    caps(h).list();
    const afterFirst = countRows(h, 'capability_registry');
    const auditsAfterFirst = countRows(h, 'audit_events');
    caps(h).list();
    caps(h).list();
    expect(countRows(h, 'capability_registry')).toBe(afterFirst);
    expect(countRows(h, 'audit_events')).toBe(auditsAfterFirst); // 重算零审计新增
  });

  it('R1 阈值边界逐档：计数 =2 不生成；=3 生成', () => {
    const h2 = makeHarness([]);
    for (let i = 0; i < 2; i++) seedFailure(h2, 'cap-r1c', 'unparseable_output');
    expect(caps(h2).list().filter((r) => r.origin === 'derived')).toHaveLength(0);

    const h3 = makeHarness([]);
    for (let i = 0; i < 3; i++) seedFailure(h3, 'cap-r1c-b', 'unparseable_output');
    expect(caps(h3).list().filter((r) => r.origin === 'derived')).toHaveLength(1);
  });

  it('R1 占比 <50% 不生成：3+4 两条 counted 子类 → 仅占比达标（4/7）方生成', () => {
    const h = makeHarness([]);
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-r1d', 'schema_violation');
    for (let i = 0; i < 4; i++) seedFailure(h, 'cap-r1d', 'unparseable_output');
    const derived = caps(h).list().filter((r) => r.origin === 'derived');
    expect(derived).toHaveLength(1);
    expect(derived[0].statement).toContain('unparseable_output');
    expect(derived[0].statement).not.toContain('schema_violation');
  });

  it('R1 分母与 trend/report 同谓词（P3-2）：cancelled 任务失败与 countedInContractRate=0（infra/非白名单）不进分子分母', () => {
    const h = makeHarness([]);
    // 子类 A ×3（正常任务）＋子类 A ×3（cancelled 任务）＋infra ×5：A 分子=3、分母=3 → 生成 A；
    // cancelled 面与 infra 面全部被谓词排除，不产生第二个候选、不稀释占比
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-r1e', 'schema_violation');
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-r1e', 'schema_violation', { taskStatus: 'cancelled' });
    for (let i = 0; i < 5; i++) seedFailure(h, 'cap-r1e', 'provider_infra');
    const derived = caps(h).list().filter((r) => r.origin === 'derived');
    expect(derived).toHaveLength(1);
    expect(derived[0].statement).toContain('schema_violation');
    expect(JSON.parse(derived[0].evidenceRefs)).toHaveLength(3); // cancelled/infra 的 ref 不进证据
  });

  it('R1 窗口过滤：窗口外（40 天前）失败不参与判据', () => {
    const h = makeHarness([]);
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-r1f', 'schema_violation');
    dbOf(h.rt).prepare(`UPDATE failure_record SET occurredAt = '2020-01-01T00:00:00.000000000Z'`).run();
    expect(caps(h).list().filter((r) => r.origin === 'derived')).toHaveLength(0);
  });

  it('R1 同义非 retired 行存在（含 manual origin）→ derived 跳过不重复入行', () => {
    const h = makeHarness([]);
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-r1g', 'schema_violation');
    // 人工先登记与模板完全同义的 statement（同 digest）
    caps(h).add({ agentId: 'cap-r1g', kind: 'limitation', statement: R1_STATEMENT_TEMPLATE.split('{subClass}').join('schema_violation') });
    const before = countRows(h, 'capability_registry');
    caps(h).list();
    expect(countRows(h, 'capability_registry')).toBe(before); // derived 被幂等跳过
  });
});

describe('WP-5B 批次二 A-27：R2 工具失败集中 derived 生成', () => {
  it('窗口内 toolId 调用失败率 ≥50% 且样本 ≥3 → limitation candidate（模板 + trace_event 证据可解析）', () => {
    const h = makeHarness([]);
    for (let i = 0; i < 2; i++) seedToolCall(h, 'cap-r2a', i + 1, 'flaky-tool', 'fail');
    seedToolCall(h, 'cap-r2a', 3, 'flaky-tool', 'ok');
    const derived = caps(h).list().filter((r) => r.origin === 'derived');
    expect(derived).toHaveLength(1);
    const d = derived[0];
    expect(d.kind).toBe('limitation');
    expect(d.agentId).toBe('cap-r2a');
    expect(d.statement).toBe(R2_STATEMENT_TEMPLATE.split('{toolId}').join('flaky-tool'));
    expect(d.statement).not.toMatch(/\d/);
    const refs = JSON.parse(d.evidenceRefs) as { kind: string; id: string }[];
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.kind === 'trace_event')).toBe(true);
    for (const r of refs) expect(h.rt.evidence.show(`${r.kind}:${r.id}`).ok).toBe(true);
    // 同数据二次 list 零新增
    const n = countRows(h, 'capability_registry');
    caps(h).list();
    expect(countRows(h, 'capability_registry')).toBe(n);
  });

  it('R2 边界：样本 =3 但失败率 <50%（1/3）→ 不生成；样本 <3 全失败 → 不生成', () => {
    const h = makeHarness([]);
    seedToolCall(h, 'cap-r2b', 1, 'weak-tool', 'fail');
    seedToolCall(h, 'cap-r2b', 2, 'weak-tool', 'ok');
    seedToolCall(h, 'cap-r2b', 3, 'weak-tool', 'ok');
    seedToolCall(h, 'cap-r2b', 4, 'tiny-tool', 'fail');
    seedToolCall(h, 'cap-r2b', 5, 'tiny-tool', 'fail');
    expect(caps(h).list().filter((r) => r.origin === 'derived')).toHaveLength(0);
  });
});

describe('WP-5B 批次二 A-27：retired 不复活、不阻挡（P1-2 两半）', () => {
  it('derived 重算不复活 retired 行：retire 后再次 list 零新增', () => {
    const h = makeHarness([]);
    for (let i = 0; i < 3; i++) seedFailure(h, 'cap-rp', 'schema_violation');
    const derived = caps(h).list().find((r) => r.origin === 'derived')!;
    caps(h).retire(derived.capabilityId, 'human'); // 人为 dismiss 该 derived 候选
    const n = countRows(h, 'capability_registry');
    caps(h).list(); // 重算：同判据数据仍在，但同义行 retired → 不复活、不阻挡也不重生
    expect(countRows(h, 'capability_registry')).toBe(n);
    const row = caps(h).list().find((r) => r.capabilityId === derived.capabilityId)!;
    expect(row.status).toBe('retired');
  });

  it('人工重加同义断言成功入行（retired 不阻挡——部分唯一索引直接效果）', () => {
    const h = makeHarness([]);
    const first = caps(h).add({ agentId: 'cap-rq', kind: 'limitation', statement: '重加演示断言' });
    caps(h).retire(first.capabilityId);
    const second = caps(h).add({ agentId: 'cap-rq', kind: 'limitation', statement: '重加演示断言' });
    expect(second.capabilityId).not.toBe(first.capabilityId);
    expect(second.status).toBe('candidate');
    expect(caps(h).list().filter((r) => r.statement === '重加演示断言')).toHaveLength(2); // retired + 新 candidate 并存
  });
});

// ============================================================
// A-28：状态机 + 审计载荷 + memory_record 分权
// ============================================================

describe('WP-5B 批次二 A-28：状态机三态与审计 ×2', () => {
  it('全生命周期：candidate --confirm--> active --retire--> retired（无出边）；retire 再退 → invalid_transition', () => {
    const h = makeHarness([]);
    const { recordId } = seedFailure(h, 'cap-sm', 'schema_violation');
    const row = caps(h).add({ agentId: 'cap-sm', kind: 'limitation', statement: '状态机演示', evidence: [`failure:${recordId}`] });
    expect(caps(h).confirm(row.capabilityId, 'h1').status).toBe('active');
    const retired = caps(h).retire(row.capabilityId, 'h2');
    expect(retired.status).toBe('retired');
    expect(retired.decidedAt).toEqual(expect.any(String));
    expect(retired.decidedBy).toBe('h2');
    try {
      caps(h).retire(row.capabilityId, 'h3');
      expect.unreachable('retired 无出边');
    } catch (err) {
      expect((err as CapabilityError).code).toBe('invalid_transition');
    }
    expect(() => caps(h).confirm(row.capabilityId)).toThrow(CapabilityError);
    expect(auditPayloads(h, 'capability_decided').map((p) => p.decision)).toEqual(['confirm', 'retire']);
  });

  it('dismiss = candidate 退场 retired + decidedAt/decidedBy 留痕（capability_decided decision=dismiss）', () => {
    const h = makeHarness([]);
    const row = caps(h).add({ agentId: 'cap-dm', kind: 'capability', statement: '待驳回草稿' });
    const dismissed = caps(h).retire(row.capabilityId, 'human-d');
    expect(dismissed.status).toBe('retired');
    expect(dismissed.decidedAt).toEqual(expect.any(String));
    expect(dismissed.decidedBy).toBe('human-d');
    const decisions = auditPayloads(h, 'capability_decided').map((p) => p.decision);
    expect(decisions).toContain('dismiss');
  });

  it('审计 ×2 类型载荷齐：capability_registered（origin/kind/agentId/evidencePending）与 capability_decided（decision/kind/agentId）', () => {
    const h = makeHarness([]);
    const { recordId } = seedFailure(h, 'cap-au', 'schema_violation');
    caps(h).add({ agentId: 'cap-au', kind: 'limitation', statement: '载荷演示', evidence: [`failure:${recordId}`] });
    const reg = auditPayloads(h, 'capability_registered')[0];
    expect(reg).toMatchObject({ origin: 'manual', kind: 'limitation', agentId: 'cap-au', evidencePending: false, statementDigest: expect.any(String) });
    expect(reg.decision).toBeUndefined(); // registered 不带 decision
  });

  it('分权断言：add/list/confirm/retire/derived 全操作不触碰 memory_record 任何行', () => {
    const h = makeHarness([]);
    const { taskId, versionId } = seedFailure(h, 'cap-mw', 'schema_violation');
    // 造两条 memory 行（分权断言基座：Registry 操作前后逐行不变）
    const db = dbOf(h.rt);
    const memIns = db.prepare(
      `INSERT INTO memory_record (memoryId, agentId, agentVersionId, taskId, kind, content, contentDigest, evidenceCount, evidenceCountAtLastTransition, contradictionCount, status, createdAt, lastUpdatedAt)
       VALUES (?,?,?,?,?,?,?,0,0,0,'active',?,?)`,
    );
    memIns.run('m-1', 'cap-mw', versionId, taskId, 'episodic', '记忆甲', 'dg-a', '2026-09-26T00:00:00.000000000Z', '2026-09-26T00:00:00.000000000Z');
    memIns.run('m-2', 'cap-mw', versionId, taskId, 'episodic', '记忆乙', 'dg-b', '2026-09-26T00:00:00.000000000Z', '2026-09-26T00:00:00.000000000Z');
    const before = JSON.stringify(db.prepare('SELECT * FROM memory_record ORDER BY memoryId').all());

    const row = caps(h).add({ agentId: 'cap-mw', kind: 'limitation', statement: '分权演示', evidence: ['failure:' + (db.prepare('SELECT recordId FROM failure_record LIMIT 1').get() as { recordId: string }).recordId] });
    caps(h).list();
    caps(h).confirm(row.capabilityId, 'h');
    caps(h).retire(row.capabilityId, 'h');
    for (let i = 0; i < 2; i++) seedFailure(h, 'cap-mw2', 'schema_violation');
    seedFailure(h, 'cap-mw2', 'schema_violation');
    caps(h).list(); // derived 重算也不触碰

    const after = JSON.stringify(db.prepare('SELECT * FROM memory_record ORDER BY memoryId').all());
    expect(after).toBe(before);
  });

  it('list 过滤：--agent/--kind/--status 三过滤器组合生效', () => {
    const h = makeHarness([]);
    const { recordId } = seedFailure(h, 'cap-lf', 'schema_violation');
    const a = caps(h).add({ agentId: 'cap-lf', kind: 'limitation', statement: '过滤演示一', evidence: [`failure:${recordId}`] });
    caps(h).add({ agentId: 'cap-lf', kind: 'capability', statement: '过滤演示二' });
    caps(h).confirm(a.capabilityId, 'h');
    const list = (f: Parameters<CapabilityManager['list']>[0]) => caps(h).list(f);
    expect(list({ agent: 'cap-lf' })).toHaveLength(2);
    expect(list({ agent: 'cap-lf', kind: 'limitation' }).map((r) => r.statement)).toEqual(['过滤演示一']);
    expect(list({ status: 'active' }).map((r) => r.statement)).toEqual(['过滤演示一']);
    expect(list({ agent: 'ghost-agent' })).toHaveLength([]);
  });
});

// ============================================================
// CLI 面（机械断言：形态不变）
// ============================================================

describe('WP-5B 批次二 CLI 面', () => {
  it('usage 含 capability list/add/confirm/retire 命令行（源文本机械断言）', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
    expect(src).toContain('shanhai capability list');
    expect(src).toContain('shanhai capability add');
    expect(src).toContain('shanhai capability confirm');
    expect(src).toContain('shanhai capability retire');
  });
});
