// 第七阶段批次二（7-2/4）：任务工作台控制器（设计 V0.3 §5 FR-T-1..5 + §8 写操作接线）。
// 数据面：统计卡 GET /api/tasks?limit=100 前端聚合（无 /api/stats 端点，如实口径）；
// 列表面 GET /api/tasks?status=…&agentId=…&limit=20&offset= 服务端分页；
// 时间范围/搜索/created 为前端本地过滤。轮询 5s（FR-T-5），不可见暂停（FR-G-4）；
// 读面 401 → 认证失效提示并停轮询（§11-2）。

import { apiGet, apiPost } from './client.js';
import { explainFailure } from './errors.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { ds } from './pageCtx.js';
import { createPoller } from './poll.js';
import {
  DEFAULT_RANGE,
  SERVER_STATUSES,
  countByStatus,
  isRunningStale,
  localTaskPass,
  parseTaskFilters,
  taskFiltersQuery,
  type TaskFilters,
} from './taskFilters.js';
import { tasksPageHtml, type PageFeedback, type TaskListRow } from './tasksView.js';
import { loadToken } from './token.js';
import { cancelOp, crashRecoveryOp, createWriteGate, resumeFeedback, resumeOp, runWrite } from './writeFlow.js';

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 5_000;
const STATS_LIMIT = 100;

function isListRow(row: unknown): row is TaskListRow {
  return typeof row === 'object' && row !== null && typeof (row as TaskListRow).taskId === 'string';
}

function asRows(data: unknown): TaskListRow[] {
  if (Array.isArray(data)) return data.filter(isListRow);
  const tasks = (data as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? tasks.filter(isListRow) : [];
}

export function mountTasksPage(ctx: PageCtx, query: Record<string, string>): PageHandle {
  let filters: TaskFilters = parseTaskFilters(query);
  let search = '';
  let page = 0;
  let stats = countByStatus([]);
  let statsTotal = 0;
  let rows: TaskListRow[] = [];
  let total = 0;
  let feedback: PageFeedback | null = null;
  let authFailed = false;
  const gate = createWriteGate();
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  function listUrl(): string {
    const params: string[] = [];
    if (filters.status !== null && (SERVER_STATUSES as readonly string[]).includes(filters.status)) params.push(`status=${filters.status}`);
    if (filters.agent !== null) params.push(`agentId=${encodeURIComponent(filters.agent)}`);
    params.push(`limit=${PAGE_SIZE}`, `offset=${page * PAGE_SIZE}`);
    return `/api/tasks?${params.join('&')}`;
  }

  function visibleRows(now: number): TaskListRow[] {
    return rows.filter((row) => localTaskPass(row, filters, search, now));
  }

  function render(): void {
    const now = ctx.now();
    const shown = visibleRows(now);
    const runningStaleIds = rows.filter((row) => isRunningStale(row, now)).map((row) => row.taskId);
    const agentOptions = [...new Set(rows.map((r) => r.agentId))].sort();
    ctx.view.innerHTML = tasksPageHtml({
      stats,
      total: total > 0 ? total : statsTotal,
      rows: shown,
      runningStaleIds,
      page,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      filters,
      agentOptions,
      search,
      feedback,
      now,
    });
  }

  function renderAuthFailed(): void {
    ctx.view.innerHTML = `<header class="page-header"><div class="beast-row"><span class="beast-row__icon" aria-hidden="true">应</span><span class="beast-row__name">应龙·任务工作台</span><span class="beast-row__tagline">任务执行域：调度、运行与状态机</span></div><h2 class="page-header__title">任务列表</h2></header>
      <div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>`;
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const [statsRes, listRes] = await Promise.all([
      apiGet(`/api/tasks?limit=${STATS_LIMIT}`, deps),
      apiGet(listUrl(), deps),
    ]);
    if ((statsRes.ok === false && statsRes.kind === 'http' && statsRes.status === 401)
      || (listRes.ok === false && listRes.kind === 'http' && listRes.status === 401)) {
      authFailed = true;
      poller.stop();
      renderAuthFailed();
      return;
    }
    if (statsRes.ok) {
      const statsRows = asRows(statsRes.data);
      stats = countByStatus(statsRows);
      statsTotal = statsRows.length;
    }
    if (listRes.ok) {
      const body = listRes.data as { tasks?: unknown; total?: unknown };
      rows = asRows(body);
      total = typeof body.total === 'number' ? body.total : rows.length;
    }
    if (!statsRes.ok && !listRes.ok) {
      // 双面失败（非 401）：保留旧数据渲染，连接状态由全局探针呈现（§11-3）
    }
    render();
  }

  const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });

  function navigate(next: TaskFilters): void {
    filters = { ...next };
    page = 0;
    const q = taskFiltersQuery(next);
    location.hash = `#/tasks${q ? `?${q}` : ''}`; // hashchange → 重挂载（URL 同步，FR-T-2）；本地先同步以撑住双击间隙
  }

  async function refreshResumeLog(taskId: string): Promise<void> {
    const res = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}/resume-log`, deps);
    const text = res.ok
      ? `续跑日志（${(res.data as { logFile?: unknown }).logFile ?? ''}）：\n${String((res.data as { content?: unknown }).content ?? '').slice(0, 4000)}${(res.data as { truncated?: unknown }).truncated ? '\n……（已截断）' : ''}`
      : `续跑日志读取失败：${explainFailure({ ok: false, kind: 'network' })}`;
    if (feedback?.resume) {
      feedback = { ...feedback, resume: { ...feedback.resume, logText: text } };
      render();
    }
  }

  async function handleWrite(kind: string, dataset: Record<string, string>): Promise<void> {
    if (!gate.acquire()) return; // FR-WR-2 乐观禁用：在途期间忽略重复点击
    try {
      let op;
      if (kind === 'cancel') op = cancelOp(ds(dataset, 'task-id'), ds(dataset, 'task-status'));
      else if (kind === 'resume') op = resumeOp(ds(dataset, 'task-id'));
      else if (kind === 'crash-recovery') {
        const rc = Number(ds(dataset, 'running-count'));
        op = crashRecoveryOp(Number.isFinite(rc) && ds(dataset, 'running-count') !== '' ? rc : stats.running);
      } else return;
      const outcome = await runWrite(op, { confirmBox: ctx.confirmBox, post: (path, body) => apiPost(path, body, deps) });
      if (outcome.kind === 'cancelled-by-user') return;
      if (outcome.ok) {
        const data = outcome.data as { taskId?: string; spawned?: boolean; logFile?: string; mode?: string };
        if (kind === 'resume' && typeof data.taskId === 'string') {
          const rf = resumeFeedback({ taskId: data.taskId, spawned: data.spawned === true, logFile: data.logFile ?? '' }, data.taskId);
          feedback = { kind: 'success', text: '续跑请求已受理', resume: { ...rf, taskId: data.taskId } };
        } else if (kind === 'crash-recovery') {
          feedback = { kind: 'success', text: '崩溃恢复已执行（Running→Failed(CrashRecovery)、孤儿快照清理、pending 审批作废、trace 对账）' };
        } else {
          feedback = { kind: 'success', text: `取消成功（mode=${data.mode ?? '—'}）` };
        }
      } else if (outcome.kind === 'network') {
        feedback = { kind: 'error', text: explainFailure({ ok: false, kind: 'network' }) };
      } else {
        // FR-WR-5 分类文案 + 服务端错误码/原文（红条如实可溯）
        feedback = { kind: 'error', text: `${explainFailure({ ok: false, kind: 'http', status: outcome.status, code: outcome.code, message: outcome.message })}（${outcome.code}：${outcome.message}）` };
      }
      render();
      await refresh(); // FR-WR-3 受影响区域局部刷新
    } finally {
      gate.release();
    }
  }

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    const action = hit.dataset.action;
    if (action === 'stat') {
      const status = hit.dataset.status ?? '';
      navigate({ ...filters, status: filters.status === status ? null : status });
      return;
    }
    if (action === 'clear-filters') {
      navigate({ status: null, agent: null, range: DEFAULT_RANGE }); // 回默认筛选（近 7 天），hash 归零查询串
      return;
    }
    if (action === 'page-prev' && page > 0) { page -= 1; void refresh(); return; }
    if (action === 'page-next' && page < Math.ceil(total / PAGE_SIZE) - 1) { page += 1; void refresh(); return; }
    if (action === 'view-resume-log') { void refreshResumeLog(ds(hit.dataset, 'task-id')); return; }
    if (action === 'cancel' || action === 'resume' || action === 'crash-recovery') {
      void handleWrite(action, hit.dataset);
    }
  }

  function onChange(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null; value?: string } | null;
    const hit = target?.closest?.('[data-filter]');
    if (!hit) return;
    const key = hit.dataset.filter;
    const value = target?.value ?? '';
    if (key === 'status') navigate({ ...filters, status: value.length > 0 ? value : null });
    else if (key === 'agent') navigate({ ...filters, agent: value.length > 0 ? value : null });
    else if (key === 'range') navigate({ ...filters, range: (value || '7d') as TaskFilters['range'] });
  }

  function onInput(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null; value?: string } | null;
    const hit = target?.closest?.('[data-filter]');
    if (!hit || hit.dataset.filter !== 'search') return;
    search = target?.value ?? '';
    render(); // 搜索为前端本地过滤，不清 hash、不重拉
  }

  function onVisibility(ev?: Event): void {
    const t = (ev as { target?: { hidden?: boolean } } | undefined)?.target;
    const hidden = typeof t?.hidden === 'boolean' ? t.hidden : ctx.doc.hidden;
    poller.onVisibility(!hidden);
  }

  ctx.view.addEventListener('click', onClick);
  ctx.view.addEventListener('change', onChange);
  ctx.view.addEventListener('input', onInput);
  ctx.doc.addEventListener('visibilitychange', onVisibility);
  void refresh();
  poller.start();

  return {
    destroy(): void {
      ctx.view.removeEventListener('click', onClick);
      ctx.view.removeEventListener('change', onChange);
      ctx.view.removeEventListener('input', onInput);
      ctx.doc.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    },
  };
}
