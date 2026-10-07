// 第七阶段批次三（7-3/4）：观测·总控控制器（设计 V0.3 §7.1 FR-O-1）。
// 三端点客户端聚合：/api/tasks?limit=100 + /api/approvals?pending=true + /api/capabilities
// （无 /api/stats 端点，如实口径）；轮询 5s、不可见暂停（FR-G-4）；
// 本页三端点经全局缓存（5s 内页面切换回来不重复拉取，FR-O-1 本批新增设计）；
// 读面 401 → 认证失效提示并停轮询（§11-2）。

import { apiGet, type ApiResult } from './client.js';
import { AUTH_EXPIRED_TEXT } from './errors.js';
import type { PortalCache } from './cache.js';
import { sharedObserveCache } from './observeCache.js';
import {
  capabilityStatusCounts,
  mergeTimeline,
  oldestPendingRel,
  taskSuccessRate,
  type TimelineApprovalLike,
  type TimelineTaskLike,
} from './observeData.js';
import { observeOverviewHtml } from './observeOverviewView.js';
import { countByStatus } from './taskFilters.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { createPoller } from './poll.js';
import { loadToken } from './token.js';

const POLL_INTERVAL_MS = 5_000;
const STATS_LIMIT = 100;

const TASKS_PATH = `/api/tasks?limit=${STATS_LIMIT}`;
const PENDING_PATH = '/api/approvals?pending=true';
const CAPABILITIES_PATH = '/api/capabilities';

export interface OverviewMountOptions {
  /** 缺省共享单例（main 装配路径）；测试可注入受控时钟实例 */
  cache?: PortalCache;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function taskRowsOf(data: unknown): TimelineTaskLike[] {
  const body = isRecord(data) && Array.isArray(data.tasks) ? data.tasks : Array.isArray(data) ? data : [];
  return body.filter((r): r is TimelineTaskLike => isRecord(r) && typeof r.taskId === 'string');
}

function approvalRowsOf(data: unknown): TimelineApprovalLike[] {
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((r): r is TimelineApprovalLike => isRecord(r) && typeof r.requestId === 'string');
}

function capabilityRowsOf(data: unknown): Array<{ status: string }> {
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((r): r is { status: string } => isRecord(r) && typeof r.status === 'string');
}

export function mountObserveOverviewPage(ctx: PageCtx, opts: OverviewMountOptions = {}): PageHandle {
  const cache: PortalCache = opts.cache ?? sharedObserveCache();
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  let taskRows: TimelineTaskLike[] = [];
  let taskTotalAll = 0;
  let approvals: TimelineApprovalLike[] = [];
  let capabilityRows: Array<{ status: string }> = [];
  let authFailed = false;

  /** 经缓存的读：成功结果落缓存（5s TTL）；失败抛出且不落缓存，这里归一为 ApiResult */
  async function cachedGet(path: string): Promise<ApiResult> {
    try {
      return (await cache.get(path, async () => {
        const r = await apiGet(path, deps);
        if (!r.ok) throw r;
        return r;
      })) as ApiResult;
    } catch (err) {
      return err as ApiResult;
    }
  }

  function render(): void {
    const counts = countByStatus(taskRows);
    ctx.view.innerHTML = observeOverviewHtml({
      taskCounts: counts,
      taskTotal: taskRows.length,
      taskTotalAll: taskTotalAll,
      successRate: taskSuccessRate(counts),
      pendingCount: approvals.length,
      oldestPending: oldestPendingRel(approvals, ctx.now()),
      capabilityCounts: capabilityStatusCounts(capabilityRows),
      timeline: mergeTimeline(taskRows, approvals),
      loading: false,
      now: ctx.now(),
    });
  }

  function renderAuthFailed(): void {
    ctx.view.innerHTML = `<div class="error-state" role="alert"><p class="error-state__message">${AUTH_EXPIRED_TEXT}</p></div>`;
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const [tasksRes, approvalsRes, capabilitiesRes] = await Promise.all([
      cachedGet(TASKS_PATH),
      cachedGet(PENDING_PATH),
      cachedGet(CAPABILITIES_PATH),
    ]);
    const failed = [tasksRes, approvalsRes, capabilitiesRes].filter((r) => !r.ok);
    if (failed.some((r) => r.kind === 'http' && r.status === 401)) {
      authFailed = true;
      poller.stop();
      renderAuthFailed();
      return;
    }
    if (tasksRes.ok) {
      taskRows = taskRowsOf(tasksRes.data);
      const total = isRecord(tasksRes.data) ? tasksRes.data.total : undefined;
      taskTotalAll = typeof total === 'number' ? total : taskRows.length;
    }
    if (approvalsRes.ok) approvals = approvalRowsOf(approvalsRes.data);
    if (capabilitiesRes.ok) capabilityRows = capabilityRowsOf(capabilitiesRes.data);
    render();
  }

  const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });

  function onVisibility(ev?: Event): void {
    const t = (ev as { target?: { hidden?: boolean } } | undefined)?.target;
    const hidden = typeof t?.hidden === 'boolean' ? t.hidden : ctx.doc.hidden;
    poller.onVisibility(!hidden);
  }

  ctx.doc.addEventListener('visibilitychange', onVisibility);
  void refresh();
  poller.start();

  return {
    destroy(): void {
      ctx.doc.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    },
  };
}
