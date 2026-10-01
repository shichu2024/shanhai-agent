// 第七阶段批次二（7-2/4）：任务筛选纯逻辑（设计 V0.3 §5 FR-T-1/2/3/4）。
// 服务端筛选 = status 六枚举 + agentId（api.ts:33/72-90 实测参数面）；
// created 不可服务端筛选（传即 400）→ 前端本地过滤，卡片 tooltip 明示；
// 时间范围为前端过滤（服务端无时间参数，不虚构）；搜索 = taskId 前缀匹配（task_record 无标题列）。

export const SERVER_STATUSES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const SEVEN_STATUSES = ['created', ...SERVER_STATUSES] as const;
export type SevenStatus = (typeof SEVEN_STATUSES)[number];

export type RangeKey = 'today' | '7d' | '30d' | 'all';

export const RANGE_OPTIONS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' },
];

export const DEFAULT_RANGE: RangeKey = '7d';

/** running 滞留阈值（FR-T-4「运行时长超过阈值」——与 runningWarning 同口径的量化常量：10 分钟） */
export const RUNNING_STALE_MS = 10 * 60_000;

export interface TaskFilters {
  /** null = 全部；六枚举走服务端参数；created 走前端本地过滤 */
  status: string | null;
  /** null = 全部（服务端 agentId 参数） */
  agent: string | null;
  range: RangeKey;
}

export function parseTaskFilters(query: Record<string, string>): TaskFilters {
  const status = query.status ?? '';
  const range = query.range ?? DEFAULT_RANGE;
  return {
    status: (SEVEN_STATUSES as readonly string[]).includes(status) ? status : null,
    agent: query.agent && query.agent.length > 0 ? query.agent : null,
    range: (RANGE_OPTIONS.some((o) => o.key === range) ? range : DEFAULT_RANGE) as RangeKey,
  };
}

/** URL 同步序列化（FR-T-2）：默认值省略，非默认逐项写入 hash 查询串 */
export function taskFiltersQuery(f: TaskFilters): string {
  const parts: string[] = [];
  if (f.status !== null) parts.push(`status=${encodeURIComponent(f.status)}`);
  if (f.agent !== null) parts.push(`agent=${encodeURIComponent(f.agent)}`);
  if (f.range !== DEFAULT_RANGE) parts.push(`range=${f.range}`);
  return parts.join('&');
}

/** 时间范围起点（ms 时间戳；all → null 不过滤） */
export function rangeStartMs(range: RangeKey, now: number): number | null {
  if (range === 'all') return null;
  if (range === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (range === '7d' ? 7 : 30) * 86_400_000;
}

export interface TaskListRowLike {
  taskId: string;
  agentId: string;
  status: string;
  createdAt: string;
}

/** 前端本地过滤：状态（created 及服务端枚举同口径）+ 时间范围 + taskId 前缀搜索 */
export function localTaskPass(row: TaskListRowLike, filters: TaskFilters, searchPrefix: string, now: number): boolean {
  if (filters.status !== null && row.status !== filters.status) return false;
  const start = rangeStartMs(filters.range, now);
  if (start !== null) {
    const t = Date.parse(row.createdAt);
    if (!Number.isNaN(t) && t < start) return false;
  }
  if (searchPrefix && !row.taskId.startsWith(searchPrefix)) return false;
  return true;
}

export interface RunningLike {
  status: string;
  endedAt: string | null;
  createdAt: string;
}

/** running 滞留判定（FR-T-4）：running 且未结束且运行超阈值 */
export function isRunningStale(row: RunningLike, now: number): boolean {
  if (row.status !== 'running' || row.endedAt !== null) return false;
  const t = Date.parse(row.createdAt);
  if (Number.isNaN(t)) return false;
  return now - t > RUNNING_STALE_MS;
}

/** 七状态聚合计数（FR-T-1：缺省状态计 0，保持八格稳定） */
export function countByStatus(rows: ReadonlyArray<{ status: string }>): Record<SevenStatus, number> {
  const counts = { created: 0, queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0 } as Record<SevenStatus, number>;
  for (const r of rows) {
    if ((SEVEN_STATUSES as readonly string[]).includes(r.status)) counts[r.status as SevenStatus] += 1;
  }
  return counts;
}

/** 分页数学（FR-T-3：page size 20，页码夹取，页数向上取整，空表 1 页） */
export function paginate<T>(rows: readonly T[], page: number, size: number): { rows: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const clamped = Math.min(Math.max(0, page), pageCount - 1);
  return { rows: rows.slice(clamped * size, clamped * size + size), page: clamped, pageCount };
}
