import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validationDepsOf, type Harness } from './helpers.js';
import { buildAgentReport } from '../src/modules/report.js';
import { EXCLUDED_FROM_CONTRACT_RATE } from '../src/modules/subclassRegistry.js';
import { buildAgentCard } from '../src/modules/agentCard.js';
import { scanForRelease } from '../src/scripts/releaseScan.js';
import {
  buildCapabilityTrend,
  type TrendBucketRow,
} from '../src/modules/trend.js';
import {
  buildAgentInsight,
  INSIGHT_CARD_FIELD_KEYS,
} from '../src/modules/insight.js';

// WP-5B 批次三（§4.3 / §4.4，D-39 / D-40 / D-41）：
// A-29 趋势逐桶手工会算对拍 + 同落盘谓词回归（常量变更后 trend 与 report 逐桶/聚合相等）
//      + 空桶 null + coverage-from-memory 按面标注
// A-30 insight 四层拼合 + INSIGHT_CARD_FIELD_KEYS 冻结清单逐字段存在性 + 永不存储（dbDump 零变化）
//      + T3 新面（insight 导出 JSON / Registry statement）零命中 + 无数据 insufficient-sample
// A-31 探针实测（假设 #1 trace_index 定向读取耗时 / #6 insight 组合延迟）随测试成文

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function dbDump(db: Database.Database): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    parts.push(`${t}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
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

/** 造一个回dated 任务（status/createdAt 可控），返回 taskId */
function seedTask(h: Harness, agentId: string, createdAt: string, status: string): string {
  versionOf(h, agentId);
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  dbOf(h.rt).prepare('UPDATE task_record SET status = ?, createdAt = ? WHERE taskId = ?').run(status, createdAt, taskId);
  return taskId;
}

/** 在任务上记一条 failure_record（subClass 决定 countedInContractRate 白名单口径） */
function seedFailure(h: Harness, agentId: string, taskId: string, subClass: 'schema_violation' | 'provider_infra'): string {
  const versionId = versionOf(h, agentId);
  return h.rt.failures.record({
    taskId, agentId, agentVersionId: versionId, attemptNo: 1,
    failureClass: 'Model', subClass,
    message: `趋势失败演示（${subClass}）`, expectedVsActual: { expected: 'ok', actual: subClass },
  });
}

/** 向任务 trace 记 N 条 memory_state_changed 任务级事件（真实写侧路径：JSONL + trace_index 双写） */
function seedMemoryEvents(h: Harness, agentId: string, taskId: string, count: number): void {
  const row = dbOf(h.rt).prepare('SELECT agentVersionId, specContentHash FROM task_record WHERE taskId = ?').get(taskId) as { agentVersionId: string; specContentHash: string };
  for (let i = 0; i < count; i++) {
    h.rt.trace.recordTaskEvent(
      { taskId, agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash },
      'memory_state_changed',
      { memoryId: `m-${i}`, from: 'candidate', to: 'active', evidenceCount: 1, contradictionCount: 0, evidenceCountAtLastTransition: 1 },
    );
  }
}

function bucketOf(trend: { buckets: TrendBucketRow[] }, key: string): TrendBucketRow | undefined {
  return trend.buckets.find((b) => b.key === key);
}

// ============================================================
// A-29：任务面 / 失败面 逐桶手工会算对拍 + 空桶 null + 同谓词
// ============================================================

describe('WP-5B 批次三 A-29：能力趋势任务面/失败面（手工会算对拍）', () => {
  it('day 桶逐项对拍：任务量/契约通过率/失败 subClass 分布与手工会算相等；同排除口径生效', () => {
    const h = makeHarness([]);
    const A = 'trend-a';
    // —— 2026-09-20 桶 ——
    seedTask(h, A, '2026-09-20T10:00:00.000000000Z', 'succeeded');
    seedTask(h, A, '2026-09-20T10:01:00.000000000Z', 'succeeded');
    const cancelled = seedTask(h, A, '2026-09-20T10:02:00.000000000Z', 'cancelled');
    const failed = seedTask(h, A, '2026-09-20T10:03:00.000000000Z', 'failed');
    seedFailure(h, A, failed, 'schema_violation');        // counted=1 → 契约失败分子
    seedFailure(h, A, cancelled, 'schema_violation');     // cancelled 任务 → 谓词排除
    const okTask0920 = seedTask(h, A, '2026-09-20T10:04:00.000000000Z', 'succeeded');
    seedFailure(h, A, okTask0920, 'provider_infra');      // counted=0（infra）→ 谓词排除
    // —— 2026-09-22 桶（留 09-21 空桶）——
    seedTask(h, A, '2026-09-22T08:00:00.000000000Z', 'succeeded');

    const trend = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'day' });
    expect(trend.bucket).toBe('day');
    const d20 = bucketOf(trend, '2026-09-20')!;
    expect(d20.tasks).toEqual({ total: 5, succeeded: 3, excludedCancelled: 1, contractFailures: 1, contractPassRate: 3 / 4 });
    // 失败面（同排除口径）：仅 counted=1 且任务非 cancelled 的 schema_violation ×1
    expect(d20.failureBySubClass).toEqual({ schema_violation: 1 });
    // 空桶（09-21）：连续桶存在，计数零，通过率 null（无分母不假装）
    const d21 = bucketOf(trend, '2026-09-21')!;
    expect(d21.tasks).toEqual({ total: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, contractPassRate: null });
    expect(d21.failureBySubClass).toEqual({});
    const d22 = bucketOf(trend, '2026-09-22')!;
    expect(d22.tasks).toEqual({ total: 1, succeeded: 1, excludedCancelled: 0, contractFailures: 0, contractPassRate: 1 });
    // 桶序列连续（09-20 → 今日，含空桶）
    expect(trend.buckets.length).toBeGreaterThanOrEqual(3);
    expect(trend.buckets.map((b) => b.key)).toEqual(expect.arrayContaining(['2026-09-20', '2026-09-21', '2026-09-22']));
  });

  it('全 cancelled 桶 → 分母 0 → contractPassRate null（report 先例：无分母不假装）', () => {
    const h = makeHarness([]);
    const A = 'trend-null';
    seedTask(h, A, '2026-09-20T10:00:00.000000000Z', 'cancelled');
    seedTask(h, A, '2026-09-20T11:00:00.000000000Z', 'cancelled');
    const trend = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { since: '2026-09-20T00:00:00Z', until: '2026-09-21T00:00:00Z', bucket: 'day' });
    const d20 = bucketOf(trend, '2026-09-20')!;
    expect(d20.tasks.total).toBe(2);
    expect(d20.tasks.excludedCancelled).toBe(2);
    expect(d20.tasks.contractPassRate).toBeNull();
  });

  it('week 桶：同数据按 ISO 周聚合相等（09-21 周一与 09-23 周三同桶 09-21；09-20 周日归上一周 09-14）', () => {
    const h = makeHarness([]);
    const A = 'trend-w';
    seedTask(h, A, '2026-09-20T10:00:00.000000000Z', 'succeeded'); // 周日 → 上一周桶 2026-09-14
    const failed = seedTask(h, A, '2026-09-21T10:00:00.000000000Z', 'failed'); // 周一
    seedFailure(h, A, failed, 'schema_violation');
    seedTask(h, A, '2026-09-23T10:00:00.000000000Z', 'succeeded'); // 周三 → 同桶 2026-09-21
    const trend = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'week' });
    const w = bucketOf(trend, '2026-09-21')!;
    expect(w.tasks).toEqual({ total: 2, succeeded: 1, excludedCancelled: 0, contractFailures: 1, contractPassRate: 1 / 2 });
    expect(w.failureBySubClass).toEqual({ schema_violation: 1 });
    const prev = bucketOf(trend, '2026-09-14')!;
    expect(prev.tasks.total).toBe(1); // 周日任务归上一周，不串桶
  });

  it('since/until 窗口过滤：窗口外任务不进任何桶；until 上界含当日（.999999999 补齐口径）', () => {
    const h = makeHarness([]);
    const A = 'trend-win';
    seedTask(h, A, '2026-09-18T10:00:00.000000000Z', 'succeeded'); // 窗口外
    seedTask(h, A, '2026-09-20T10:00:00.000000000Z', 'succeeded');
    const trend = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, {
      since: '2026-09-20T00:00:00Z', until: '2026-09-20T23:59:59Z', bucket: 'day',
    });
    expect(trend.buckets.map((b) => b.key)).toEqual(['2026-09-20']);
    expect(trend.buckets[0].tasks.total).toBe(1);
  });
});

// ============================================================
// A-29 回归断言：写侧常量变更后 trend 与 report 逐桶/聚合相等（落盘谓词）
// ============================================================

describe('WP-5B 批次三 A-29：同落盘谓词回归（EXCLUDED_FROM_CONTRACT_RATE 变更后两读侧不漂移）', () => {
  it('测试内改 EXCLUDED_FROM_CONTRACT_RATE → trend 历史桶逐桶不变，且聚合与 report 相等', () => {
    const h = makeHarness([]);
    const A = 'trend-pred';
    const t1 = seedTask(h, A, '2026-09-20T10:00:00.000000000Z', 'succeeded');
    const t2 = seedTask(h, A, '2026-09-21T10:00:00.000000000Z', 'failed');
    const t3 = seedTask(h, A, '2026-09-21T11:00:00.000000000Z', 'cancelled');
    seedFailure(h, A, t1, 'provider_infra');
    seedFailure(h, A, t2, 'schema_violation');
    seedFailure(h, A, t3, 'schema_violation');
    dbOf(h.rt).prepare(`UPDATE task_record SET assignmentSource = 'stable'`).run();

    const trendBefore = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'day' });
    const reportBefore = buildAgentReport(dbOf(h.rt), A, {});
    // 聚合对拍：trend 全史聚合 = report stable 组（两读侧同一落盘谓词、同一时间列 t.createdAt）
    const totalTasks = trendBefore.buckets.reduce((s, b) => s + b.tasks.total, 0);
    const totalCancelled = trendBefore.buckets.reduce((s, b) => s + b.tasks.excludedCancelled, 0);
    const totalCF = trendBefore.buckets.reduce((s, b) => s + b.tasks.contractFailures, 0);
    const stable = reportBefore.groups.find((g) => g.assignmentSource === 'stable')!;
    expect(totalTasks).toBe(stable.tasks);
    expect(totalCancelled).toBe(stable.excludedCancelled);
    expect(totalCF).toBe(stable.contractFailures);

    // 写侧常量变更（模拟清单演进——读侧不受影响才是同谓词机制的正确形态）
    (EXCLUDED_FROM_CONTRACT_RATE as unknown as string[]).push('schema_violation');
    try {
      const trendAfter = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'day' });
      expect(trendAfter.buckets).toEqual(trendBefore.buckets); // 逐桶相等（落盘谓词，非同常量现算）
      const reportAfter = buildAgentReport(dbOf(h.rt), A, {});
      expect(reportAfter.groups).toEqual(reportBefore.groups); // report 同不漂移
    } finally {
      (EXCLUDED_FROM_CONTRACT_RATE as unknown as string[]).pop(); // 还原（防污染其他用例）
    }
  });
});

// ============================================================
// A-29：记忆面（trace_index 定位 + 定向文件读取）+ 断言面（createdAt 列）+ coverage 按面标注
// ============================================================

describe('WP-5B 批次三 A-29：记忆面 / 断言面 / coverage 标注', () => {
  it('memory_state_changed 按桶计数：仅该 agent 的事件计数，其他 agent 不串桶', () => {
    const h = makeHarness([]);
    const A = 'trend-mem-a';
    const B = 'trend-mem-b';
    const taskA = seedTask(h, A, '2026-09-20T10:00:00.000000000Z', 'succeeded');
    const taskA2 = seedTask(h, A, '2026-09-20T11:00:00.000000000Z', 'succeeded');
    const taskB = seedTask(h, B, '2026-09-20T12:00:00.000000000Z', 'succeeded');
    seedMemoryEvents(h, A, taskA, 2);
    seedMemoryEvents(h, A, taskA2, 1);
    seedMemoryEvents(h, B, taskB, 5); // 他 agent 事件不得计入 A

    const trendA = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'day' });
    const todayKey = new Date().toISOString().slice(0, 10); // recordTaskEvent 用真实时钟（事件落今日桶）
    const today = bucketOf(trendA, todayKey)!;
    expect(today.memoryEvents).toBe(3);
    const trendB = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, B, { bucket: 'day' });
    expect(bucketOf(trendB, todayKey)!.memoryEvents).toBe(5);
  });

  it('断言面按桶：capability_registry 各状态条目数按 createdAt 列分桶（登记即事实）', () => {
    const h = makeHarness([]);
    const A = 'trend-reg';
    const task = seedTask(h, A, '2026-09-19T10:00:00.000000000Z', 'failed');
    const recordId = seedFailure(h, A, task, 'schema_violation');
    const c1 = h.rt.capabilities.add({ agentId: A, kind: 'limitation', statement: '断言一' });
    const c2 = h.rt.capabilities.add({ agentId: A, kind: 'capability', statement: '断言二', evidence: [`failure:${recordId}`] });
    dbOf(h.rt).prepare('UPDATE capability_registry SET createdAt = ? WHERE capabilityId = ?').run('2026-09-20T10:00:00.000000000Z', c1.capabilityId);
    dbOf(h.rt).prepare('UPDATE capability_registry SET createdAt = ? WHERE capabilityId = ?').run('2026-09-21T10:00:00.000000000Z', c2.capabilityId);
    h.rt.capabilities.confirm(c2.capabilityId, 'h');
    h.rt.capabilities.retire(c1.capabilityId, 'h');

    const trend = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'day' });
    expect(bucketOf(trend, '2026-09-20')!.registry).toEqual({ candidate: 0, active: 0, retired: 1 });
    expect(bucketOf(trend, '2026-09-21')!.registry).toEqual({ candidate: 0, active: 1, retired: 0 });
  });

  it('coverage 按面标注：有 memory 事件 → memoryFrom=首个该类事件时间戳；无 → null；任务/失败面不标注', () => {
    const h = makeHarness([]);
    const A = 'trend-cov-a';
    const task = seedTask(h, A, '2026-09-20T10:00:00.000000000Z', 'succeeded');
    seedMemoryEvents(h, A, task, 1);
    const trend = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'day' });
    expect(trend.coverage.memoryFrom).toEqual(expect.any(String));
    expect(trend.coverage.memoryFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 任务/失败面全史 → coverage 无对应标注字段（仅 memoryFrom 单独标注，P3-5）
    expect(Object.keys(trend.coverage)).toEqual(expect.arrayContaining(['memoryFrom', 'note']));
    expect(Object.keys(trend.coverage).some((k) => k.toLowerCase().includes('task'))).toBe(false);

    const h2 = makeHarness([]);
    seedTask(h2, 'trend-cov-b', '2026-09-20T10:00:00.000000000Z', 'succeeded');
    const trend2 = buildCapabilityTrend(dbOf(h2.rt), h2.rt.trace, 'trend-cov-b', { bucket: 'day' });
    expect(trend2.coverage.memoryFrom).toBeNull();
    expect(trend2.coverage.note).toContain('coverage-from-memory');
  });
});

// ============================================================
// A-30：insight 四层拼合 + 冻结清单 + 永不存储 + 异常路径
// ============================================================

function insightDeps(h: Harness) {
  return {
    db: dbOf(h.rt),
    trace: h.rt.trace,
    registry: h.rt.registry,
    capabilities: h.rt.capabilities,
  };
}

describe('WP-5B 批次三 A-30：agent insight 声明面（冻结字段子集）', () => {
  it('INSIGHT_CARD_FIELD_KEYS 冻结清单 = 七字段常量，声明面逐字段存在且与 buildAgentCard 输出相等', () => {
    expect([...INSIGHT_CARD_FIELD_KEYS]).toEqual([
      'agentId', 'versionId', 'specVersion', 'contentHash', 'mission', 'nonGoals', 'tools',
    ]);
    const h = makeHarness([]);
    const versionId = registerAndRelease(h.rt, sampleSpec({ agentId: 'ins-card' }));
    const insight = buildAgentInsight(insightDeps(h), 'ins-card', {});
    const card = buildAgentCard(
      h.rt.registry.getVersion(versionId),
    );
    // 键序 = 冻结清单（可证伪：多字段/少字段/换序均失败）
    expect(Object.keys(insight.declared)).toEqual([...INSIGHT_CARD_FIELD_KEYS]);
    for (const key of INSIGHT_CARD_FIELD_KEYS) {
      expect(insight.declared[key]).toEqual(card[key]); // 逐字段存在性 + 值相等
    }
    expect(insight.versionId).toBe(versionId);
  });

  it('显式 versionId 参数生效（缺省当前指针版本）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ins-ver' }));
    const vid2 = h.rt.registry.registerSpec(
      sampleSpec({ agentId: 'ins-ver', outputContract: { type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 400 } }, required: ['summary'], additionalProperties: false } }),
      'test',
      validationDepsOf(h.rt),
    );
    const insight = buildAgentInsight(insightDeps(h), 'ins-ver', { versionId: vid2 });
    expect(insight.versionId).toBe(vid2);
  });
});

describe('WP-5B 批次三 A-30：断言面 / 行为面 / 限制与证据摘要', () => {
  it('断言面：active 条目 + open candidates 摘要计数；行为面：缺省近 30 天窗', () => {
    const h = makeHarness([]);
    const A = 'ins-full';
    versionOf(h, A);
    // R1 数据 ×3（触发 derived limitation candidate）
    for (let i = 0; i < 3; i++) {
      const taskId = h.rt.tasks.createTask(A, validInput, 't');
      h.rt.failures.record({
        taskId, agentId: A, agentVersionId: versionOf(h, A), attemptNo: 1,
        failureClass: 'Model', subClass: 'schema_violation',
        message: 'insight 失败演示', expectedVsActual: { expected: 'ok', actual: 'x' },
      });
    }
    // 手工 capability（带证据 → confirm → active）
    const fr = (dbOf(h.rt).prepare('SELECT recordId FROM failure_record LIMIT 1').get() as { recordId: string }).recordId;
    const cap = h.rt.capabilities.add({ agentId: A, kind: 'capability', statement: '可稳定产出摘要', evidence: [`failure:${fr}`] });
    h.rt.capabilities.confirm(cap.capabilityId, 'human');
    // 手工 limitation 草稿（evidencePending）
    h.rt.capabilities.add({ agentId: A, kind: 'limitation', statement: '长文截断风险草稿' });

    const insight = buildAgentInsight(insightDeps(h), A, {});
    expect(insight.assertions.active.counts).toEqual({ capability: 1, limitation: 0 });
    expect(insight.assertions.active.entries).toHaveLength(1);
    expect(insight.assertions.active.entries[0]).toMatchObject({ capabilityId: cap.capabilityId, statement: '可稳定产出摘要', origin: 'manual' });
    // open candidates：derived limitation ×1 + manual limitation 草稿 ×1（active 不计）
    expect(insight.assertions.openCandidates.total).toBe(2);
    expect(insight.assertions.openCandidates.evidencePending).toBe(1);
    expect(insight.assertions.emptyHint).toBeNull();
    // 行为面：缺省近 30 天窗 + day 桶（本次种子的任务全落今日桶）
    expect(insight.behavior.bucket).toBe('day');
    expect(insight.behavior.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const sinceMs = Date.parse(insight.behavior.since);
    expect(sinceMs).toBeGreaterThan(Date.now() - 31 * 24 * 3600 * 1000);
    expect(insight.behavior.status).toBe('ok');
    expect(insight.behavior.buckets.length).toBeGreaterThanOrEqual(1);
    // 限制与证据摘要：limitation 条目 + 各面证据引用计数（不展开 payload）
    const limitStmts = insight.limitations.entries.map((e: { statement: string }) => e.statement);
    expect(limitStmts).toContain('长文截断风险草稿');
    expect(insight.limitations.evidenceSummary).toEqual({ failure: expect.any(Number) });
    expect(Object.keys(insight.limitations.evidenceSummary)).not.toContain('payload');
  });

  it('insight 触发 derived 惰性重算（§4.2 生成时机：capability list / agent insight 同款接线）', () => {
    const h = makeHarness([]);
    const A = 'ins-derive';
    versionOf(h, A);
    for (let i = 0; i < 3; i++) {
      const taskId = h.rt.tasks.createTask(A, validInput, 't');
      h.rt.failures.record({
        taskId, agentId: A, agentVersionId: versionOf(h, A), attemptNo: 1,
        failureClass: 'Model', subClass: 'schema_violation',
        message: 'derived 接线演示', expectedVsActual: { expected: 'ok', actual: 'x' },
      });
    }
    const before = (dbOf(h.rt).prepare(`SELECT COUNT(*) AS c FROM capability_registry`).get() as { c: number }).c;
    expect(before).toBe(0); // 尚未 list 过 → derived 未生成
    buildAgentInsight(insightDeps(h), A, {});
    const after = (dbOf(h.rt).prepare(`SELECT COUNT(*) AS c FROM capability_registry WHERE origin='derived'`).get() as { c: number }).c;
    expect(after).toBe(1); // insight 侧接线成文
  });

  it('异常路径：无任务数据 → 行为面 insufficient-sample；无 Registry 条目 → 断言面空清单+提示（不是错误）', () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ins-empty' }));
    const insight = buildAgentInsight(insightDeps(h), 'ins-empty', {});
    expect(insight.behavior.status).toBe('insufficient-sample');
    expect(insight.behavior.insufficientNote).toContain('insufficient-sample');
    expect(insight.assertions.active.entries).toEqual([]);
    expect(insight.assertions.openCandidates.total).toBe(0);
    expect(insight.assertions.emptyHint).toEqual(expect.any(String)); // 提示非错误
  });

  it('永不存储（D-40）：settle derived 后 dbDump 全库快照零变化', () => {
    const h = makeHarness([]);
    const A = 'ins-readonly';
    versionOf(h, A);
    const taskId = h.rt.tasks.createTask(A, validInput, 't');
    h.rt.failures.record({
      taskId, agentId: A, agentVersionId: versionOf(h, A), attemptNo: 1,
      failureClass: 'Model', subClass: 'schema_violation',
      message: '只读演示', expectedVsActual: { expected: 'ok', actual: 'x' },
    });
    h.rt.capabilities.list(); // settle derived（§4.2 惰性重算先例：list 顺带重算）
    const before = dbDump(dbOf(h.rt));
    buildAgentInsight(insightDeps(h), A, {});
    buildAgentInsight(insightDeps(h), A, { since: '2026-01-01T00:00:00Z' });
    const after = dbDump(dbOf(h.rt));
    expect(after).toBe(before); // insight 制品本体零写入（声明面/趋势/断言面全现算）
  });
});

// ============================================================
// A-30：T3 新面（insight 导出 JSON + Registry statement）零命中
// ============================================================

describe('WP-5B 批次三 A-30：T3 新面零命中（§9-3）', () => {
  it('insight 导出 JSON 与 Registry statement 落盘后 scanForRelease 零命中（规则族不削弱前提下的新面断言）', () => {
    const h = makeHarness([]);
    const A = 'ins-t3';
    versionOf(h, A);
    const taskId = h.rt.tasks.createTask(A, validInput, 't');
    const recordId = h.rt.failures.record({
      taskId, agentId: A, agentVersionId: versionOf(h, A), attemptNo: 1,
      failureClass: 'Model', subClass: 'schema_violation',
      message: 'T3 面演示', expectedVsActual: { expected: 'ok', actual: 'x' },
    });
    h.rt.capabilities.add({
      agentId: A, kind: 'limitation', statement: '对外部高噪声源需二次核对（T3 statement 新面演示）',
      evidence: [`failure:${recordId}`],
    });
    const insight = buildAgentInsight(insightDeps(h), A, {});

    const dir = mkdtempSync(path.join(tmpdir(), 'wp5b3-t3-'));
    try {
      mkdirSync(path.join(dir, 'export'), { recursive: true });
      writeFileSync(path.join(dir, 'export', `insight-${A}.json`), JSON.stringify(insight, null, 2), 'utf8');
      const stmts = (dbOf(h.rt).prepare('SELECT statement FROM capability_registry').all() as { statement: string }[])
        .map((r, i) => `#${i}: ${r.statement}`).join('\n');
      writeFileSync(path.join(dir, 'export', 'statements.txt'), stmts, 'utf8');
      const findings = scanForRelease(dir);
      expect(findings).toEqual([]); // 新面零命中（A-30 硬条款）
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// A-31 探针实测（假设 #1 / #6）：trace_index 定向读取耗时 + insight 组合延迟
// ============================================================

describe('WP-5B 批次三 A-31：探针实测（假设 #1/#6，随批成文）', () => {
  it('趋势定向读取与 insight 组合延迟实测 < OTel T1 触发线 500ms（数值随测试输出归档）', () => {
    const h = makeHarness([]);
    const A = 'ins-probe';
    versionOf(h, A);
    // 种子：20 任务 ×（2 工具调用事件 + 1 记忆事件 + 1 失败）
    for (let i = 0; i < 20; i++) {
      const taskId = h.rt.tasks.createTask(A, validInput, 't');
      const row = dbOf(h.rt).prepare('SELECT agentVersionId, specContentHash FROM task_record WHERE taskId = ?').get(taskId) as { agentVersionId: string; specContentHash: string };
      const base = { taskId, agentId: A, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash };
      h.rt.trace.recordCallEvent(base, 'tool_call_requested', 'tool', 1, 1, { toolId: 'docs-list', argsDigest: 'd' });
      h.rt.trace.recordCallEvent(base, 'tool_call_executed', 'tool', 1, 1, { toolId: 'docs-list', latencyMs: 1, resultDigest: 'd', riskLevel: 'L0', audited: false });
      h.rt.trace.recordTaskEvent(base, 'memory_state_changed', { memoryId: `m-${i}`, from: 'candidate', to: 'active', evidenceCount: 1, contradictionCount: 0, evidenceCountAtLastTransition: 1 });
      h.rt.failures.record({
        taskId, agentId: A, agentVersionId: row.agentVersionId, attemptNo: 1,
        failureClass: 'Model', subClass: 'schema_violation',
        message: '探针失败演示', expectedVsActual: { expected: 'ok', actual: 'x' },
      });
    }
    const t0 = process.hrtime.bigint();
    buildCapabilityTrend(dbOf(h.rt), h.rt.trace, A, { bucket: 'day' });
    const trendMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    buildAgentInsight(insightDeps(h), A, {});
    const insightMs = Number(process.hrtime.bigint() - t1) / 1e6;
    // eslint-disable-next-line no-console
    console.log(`[wp5b-batch3 探针] trend=${trendMs.toFixed(1)}ms insight=${insightMs.toFixed(1)}ms（种子 20 任务/60 trace 事件/20 失败；OTel T1 触发线 500ms）`);
    expect(trendMs).toBeLessThan(500); // 假设 #1：定向读取不整库扫
    expect(insightMs).toBeLessThan(500); // 假设 #6：组合延迟可接受
  });
});

// ============================================================
// CLI 面（机械断言：形态不变）
// ============================================================

describe('WP-5B 批次三 CLI 面', () => {
  it('usage 含 capability trend / agent insight 命令行（源文本机械断言）', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
    expect(src).toContain('shanhai capability trend');
    expect(src).toContain('shanhai agent insight');
  });
});
