import type Database from 'better-sqlite3';
import { nowNs, type TraceRecorder } from './traceRecorder.js';

// WP-5B 批次三（第五阶段设计 §4.3，D-39）：能力趋势——纯只读时间桶现算。
//
// 定位：可信度状态机的历史维度扩展（「当前状态」→「状态如何演变」）。
// 零存储：不落趋势快照（无第二真相源），每次 CLI 调用现算。
//
// 同谓词机制（A-29 / V0.2 P1-1）：任务面/失败面分母与 report 逐字相同 SQL 谓词——
// 消费落盘列 countedInContractRate = 1 AND t.status != 'cancelled'（写侧常量
// EXCLUDED_FROM_CONTRACT_RATE 单一源物化后的落盘事实）。trend 与 report 是同一落盘
// 谓词的两个读侧切片（report = assignmentSource 分组切片；trend = 时间桶切片），
// 常量任何变更后历史桶与新算桶共享同一落盘事实，两读侧永不分叉——不做同常量现算。
//
// 记忆面（假设 #1）：从 trace_index 按 eventType 定位 + 定向文件读取，严禁整库扫描
// JSONL——只读含 memory_state_changed 事件的 per-task 文件（trace_index 无 agentId 列，
// 经 task_record 连接收敛到该 agent 的 taskId 集，再对命中文件逐一定向读取）。
//
// 诚实边界（P3-5 / A-29）：任务面/失败面自第一阶段有全史（不标注）；
// memory_state_changed 自第二阶段批次才存在——记忆面单独标注 coverage-from-memory
// （首个该类事件时间戳），不低报亦不假装。

export const TREND_BUCKET_UNITS = ['day', 'week'] as const;
export type TrendBucketUnit = (typeof TREND_BUCKET_UNITS)[number];

/** 记忆面消费的事件类型（第二阶段批次起存在——coverage 标注的事实边界） */
export const MEMORY_FACE_EVENT_TYPE = 'memory_state_changed';

export class TrendError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_bound' | 'invalid_bucket',
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TrendError';
  }
}

export interface TrendBucketRow {
  /** day = 'YYYY-MM-DD'；week = ISO 周起始日（周一）'YYYY-MM-DD' */
  key: string;
  tasks: {
    total: number;
    succeeded: number;
    excludedCancelled: number;
    /** 计入契约失败率的任务数（A4 §1 口径物化列——与 report 同落盘谓词分子） */
    contractFailures: number;
    /** 分母（total − cancelled）为 0 → null（无分母不假装，report 先例） */
    contractPassRate: number | null;
  };
  /** 失败 subClass 分布（同排除口径：countedInContractRate=1 AND status != 'cancelled'） */
  failureBySubClass: Record<string, number>;
  /** memory_state_changed 事件按桶计数（trace_index 定位 + 定向文件读取） */
  memoryEvents: number;
  /** 断言面：capability_registry 各状态条目数按 createdAt 列分桶（登记即事实，P3-4） */
  registry: { candidate: number; active: number; retired: number };
}

export interface CapabilityTrend {
  agentId: string;
  bucket: TrendBucketUnit;
  since: string | null;
  until: string;
  buckets: TrendBucketRow[];
  coverage: { memoryFrom: string | null; note: string };
}

/**
 * 边界归一（与 createdAt/timestamp 同为 9 位亚秒 + Z 的字符串比较口径）：
 * 无小数位时下界补 .000000000Z / 上界补 .999999999Z——'...T00:00:00Z' 形态的裸上界
 * 不得静默漏掉当日 .000000001Z 起的全部事件。
 */
function normalizeBound(ts: string, side: 'lo' | 'hi'): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(ts);
  if (!m) {
    throw new TrendError(`时间边界非法（须 RFC3339 UTC：YYYY-MM-DDTHH:mm:ss[.frac]Z）：${ts}`, 'invalid_bound', { value: ts });
  }
  const frac = (m[2] ?? (side === 'lo' ? '000000000' : '999999999')).padEnd(9, '0');
  return `${m[1]}.${frac}Z`;
}

const dayKeyOf = (ts: string): string => ts.slice(0, 10);

/** ISO 周 key = 该日所在周的周一（YYYY-MM-DD） */
function weekKeyOf(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = 周日
  const monday = new Date(d.getTime() + (dow === 0 ? -6 : 1 - dow) * 86400000);
  return monday.toISOString().slice(0, 10);
}

function bucketKeyOf(ts: string, unit: TrendBucketUnit): string {
  return unit === 'day' ? dayKeyOf(ts) : weekKeyOf(ts.slice(0, 10));
}

export function buildCapabilityTrend(
  db: Database.Database,
  trace: TraceRecorder,
  agentId: string,
  opts: { since?: string; until?: string; bucket?: TrendBucketUnit } = {},
): CapabilityTrend {
  if (opts.bucket !== undefined && !(TREND_BUCKET_UNITS as readonly string[]).includes(opts.bucket)) {
    throw new TrendError(`bucket 非法（封闭枚举 ${TREND_BUCKET_UNITS.join('/')}）：${opts.bucket}`, 'invalid_bucket', { bucket: opts.bucket });
  }
  const unit: TrendBucketUnit = opts.bucket ?? 'day';
  const lo = opts.since !== undefined ? normalizeBound(opts.since, 'lo') : null;
  const hi = normalizeBound(opts.until ?? nowNs(), 'hi');

  // ---------- 任务面（与 report 同落盘谓词 / 同时间列 t.createdAt） ----------
  const taskRange = lo !== null ? 'AND createdAt >= ? AND createdAt <= ?' : 'AND createdAt <= ?';
  const taskRows = db
    .prepare(
      `SELECT substr(createdAt, 1, 10) AS d, COUNT(*) AS total,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM task_record WHERE agentId = ? ${taskRange} GROUP BY d`,
    )
    .all(...(lo !== null ? [agentId, lo, hi] : [agentId, hi])) as { d: string; total: number; succeeded: number | null; cancelled: number | null }[];

  // 契约失败分子（A-29 谓词逐字同 report：countedInContractRate = 1 AND t.status != 'cancelled'）
  const cfRange = lo !== null ? 'AND t.createdAt >= ? AND t.createdAt <= ?' : 'AND t.createdAt <= ?';
  const cfRows = db
    .prepare(
      `SELECT substr(t.createdAt, 1, 10) AS d, COUNT(DISTINCT f.taskId) AS c
       FROM failure_record f JOIN task_record t ON t.taskId = f.taskId
       WHERE t.agentId = ? AND f.countedInContractRate = 1 AND t.status != 'cancelled' ${cfRange}
       GROUP BY d`,
    )
    .all(...(lo !== null ? [agentId, lo, hi] : [agentId, hi])) as { d: string; c: number }[];

  // ---------- 失败面（同排除口径；时间列同任务面 t.createdAt——桶切片一致） ----------
  const failRows = db
    .prepare(
      `SELECT substr(t.createdAt, 1, 10) AS d, f.subClass AS subClass, COUNT(*) AS c
       FROM failure_record f JOIN task_record t ON t.taskId = f.taskId
       WHERE t.agentId = ? AND f.countedInContractRate = 1 AND t.status != 'cancelled' ${cfRange}
       GROUP BY d, f.subClass`,
    )
    .all(...(lo !== null ? [agentId, lo, hi] : [agentId, hi])) as { d: string; subClass: string; c: number }[];

  // ---------- 记忆面（trace_index 按 eventType 定位 → 定向文件读取；不整库扫描 JSONL） ----------
  // trace_index 无 agentId 列：经 task_record 连接把候选文件收敛到该 agent 的 taskId 集。
  const memTaskIds = db
    .prepare(
      `SELECT DISTINCT ti.taskId AS taskId, MIN(ti.timestamp) AS firstTs, MAX(ti.timestamp) AS lastTs
       FROM trace_index ti JOIN task_record t ON t.taskId = ti.taskId
       WHERE ti.eventType = ? AND t.agentId = ?
         ${lo !== null ? 'AND ti.timestamp >= ?' : ''} AND ti.timestamp <= ?
       GROUP BY ti.taskId`,
    )
    .all(...(lo !== null ? [MEMORY_FACE_EVENT_TYPE, agentId, lo, hi] : [MEMORY_FACE_EVENT_TYPE, agentId, hi])) as { taskId: string; firstTs: string; lastTs: string }[];
  const memoryCounts = new Map<string, number>();
  for (const { taskId } of memTaskIds) {
    // 定向读取：只读命中文件（readEvents 既有读取路径，零新事件）
    for (const e of trace.readEvents(taskId)) {
      if (e.eventType !== MEMORY_FACE_EVENT_TYPE || e.agentId !== agentId) continue;
      if (lo !== null && e.timestamp < lo) continue;
      if (e.timestamp > hi) continue;
      const key = bucketKeyOf(e.timestamp, unit);
      memoryCounts.set(key, (memoryCounts.get(key) ?? 0) + 1);
    }
  }
  const memoryFrom = (
    db
      .prepare(
        `SELECT MIN(ti.timestamp) AS m FROM trace_index ti JOIN task_record t ON t.taskId = ti.taskId
         WHERE ti.eventType = ? AND t.agentId = ?`,
      )
      .get(MEMORY_FACE_EVENT_TYPE, agentId) as { m: string | null }
  ).m; // 首个该类事件时间戳（全史，不受窗口裁剪——coverage 是事实边界不是窗口属性）

  // ---------- 断言面（createdAt 列——登记即事实，P3-4 钉死） ----------
  const regRange = lo !== null ? 'AND createdAt >= ? AND createdAt <= ?' : 'AND createdAt <= ?';
  const regRows = db
    .prepare(
      `SELECT substr(createdAt, 1, 10) AS d, status, COUNT(*) AS c
       FROM capability_registry WHERE agentId = ? ${regRange} GROUP BY d, status`,
    )
    .all(...(lo !== null ? [agentId, lo, hi] : [agentId, hi])) as { d: string; status: 'candidate' | 'active' | 'retired'; c: number }[];

  // ---------- 分桶拼合 ----------
  const byKey = new Map<string, TrendBucketRow>();
  const rowOf = (key: string): TrendBucketRow => {
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        tasks: { total: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, contractPassRate: null },
        failureBySubClass: {},
        memoryEvents: 0,
        registry: { candidate: 0, active: 0, retired: 0 },
      };
      byKey.set(key, row);
    }
    return row;
  };
  const dataDays = new Set<string>();
  for (const r of taskRows) {
    dataDays.add(r.d);
    const row = rowOf(bucketKeyOf(`${r.d}T00:00:00.000000000Z`, unit));
    row.tasks.total += r.total;
    row.tasks.succeeded += r.succeeded ?? 0;
    row.tasks.excludedCancelled += r.cancelled ?? 0;
  }
  for (const r of cfRows) {
    rowOf(bucketKeyOf(`${r.d}T00:00:00.000000000Z`, unit)).tasks.contractFailures += r.c;
  }
  for (const r of failRows) {
    const row = rowOf(bucketKeyOf(`${r.d}T00:00:00.000000000Z`, unit));
    row.failureBySubClass[r.subClass] = (row.failureBySubClass[r.subClass] ?? 0) + r.c;
    dataDays.add(r.d);
  }
  for (const r of regRows) {
    rowOf(bucketKeyOf(`${r.d}T00:00:00.000000000Z`, unit)).registry[r.status] += r.c;
    dataDays.add(r.d);
  }
  for (const [key, count] of memoryCounts) {
    rowOf(key).memoryEvents += count;
  }
  if (memoryFrom !== null) dataDays.add(memoryFrom.slice(0, 10));

  // 通过率后置计算（分母 0 → null：无分母不假装）
  for (const row of byKey.values()) {
    const denominator = row.tasks.total - row.tasks.excludedCancelled;
    row.tasks.contractPassRate = denominator > 0 ? (denominator - row.tasks.contractFailures) / denominator : null;
  }

  // ---------- 连续桶（空桶显式存在，rate=null；起点 = since 或最早数据日，终点 = until） ----------
  const endDay = hi.slice(0, 10);
  const startDay =
    lo !== null
      ? lo.slice(0, 10)
      : dataDays.size > 0
        ? [...dataDays].sort()[0]
        : null;
  const buckets: TrendBucketRow[] = [];
  if (startDay !== null) {
    const stepMs = unit === 'day' ? 86400000 : 7 * 86400000;
    const startAligned = unit === 'week' ? weekKeyOf(startDay) : startDay;
    for (let t = Date.parse(`${startAligned}T00:00:00Z`); t <= Date.parse(`${endDay}T00:00:00Z`); t += stepMs) {
      buckets.push(rowOf(new Date(t).toISOString().slice(0, 10)));
    }
  }

  return {
    agentId,
    bucket: unit,
    since: lo,
    until: hi,
    buckets,
    coverage: {
      memoryFrom,
      note:
        memoryFrom !== null
          ? `coverage-from-memory:${memoryFrom}——记忆面自此时间戳起可观测；任务面/失败面为全史口径（不标注）`
          : 'coverage-from-memory:尚无 memory_state_changed 事件（记忆面无前史，计数恒 0）；任务面/失败面为全史口径（不标注）',
    },
  };
}
