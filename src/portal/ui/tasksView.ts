// 第七阶段批次二（7-2/4）：任务工作台 HTML 构建（设计 V0.3 §5 FR-T-1/3/4，字符串面纯函数）。

import {
  RANGE_OPTIONS,
  SERVER_STATUSES,
  type TaskFilters,
} from './taskFilters.js';
import { STATUS_LABELS, buttonHtml, cardHtml, emptyStateHtml, esc, pageHeaderHtml, statusBadgeHtml, tableHtml } from './components.js';
import { formatThousands, formatTimestamp, shortId } from './format.js';

export interface TaskListRow {
  taskId: string;
  agentId: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  attemptCount: number;
  modelCallCount: number;
  tokensUsed: number;
}

export interface PageFeedback {
  kind: 'success' | 'error';
  text: string;
  /** resume 后续指引（FR-WR-4）：note 原文 + CLI 命令 + 日志链接 */
  resume?: { note: string; cli: string; logUrl: string; taskId: string; logText?: string };
}

export function feedbackHtml(feedback: PageFeedback | null): string {
  if (!feedback) return '';
  const resume = feedback.resume
    ? `<div class="feedback__resume"><p class="feedback__note">${esc(feedback.resume.note)}</p><pre class="code-block"><code>${esc(feedback.resume.cli)}</code></pre><button type="button" class="btn btn--ghost btn--sm" data-action="view-resume-log" data-task-id="${esc(feedback.resume.taskId)}" data-log-url="${esc(feedback.resume.logUrl)}">查看续跑日志</button><span class="hint mono">${esc(feedback.resume.logUrl)}</span><div class="resume-log"${feedback.resume.logText ? '' : ' hidden'}>${feedback.resume.logText ? esc(feedback.resume.logText) : ''}</div></div>`
    : '';
  return `<div class="feedback feedback--${feedback.kind}" role="${feedback.kind === 'error' ? 'alert' : 'status'}"><p class="feedback__text">${esc(feedback.text)}</p>${resume}</div>`;
}

// ---------- FR-T-1 统计卡 ----------

function statCardsHtml(counts: Record<string, number>, total: number, activeStatus: string | null): string {
  const cards = (['created', 'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'] as const).map((status) => {
    const isActive = activeStatus === status;
    const tip = status === 'created'
      ? ' title="created 不支持服务端筛选（api.ts 白名单六枚举）——点击为前端本地过滤"'
      : ` title="点击筛选 ${STATUS_LABELS[status]} 任务"`;
    return `<button type="button" class="stat-card${isActive ? ' stat-card--active' : ''}${counts[status] === 0 ? ' stat-card--zero' : ''}" data-action="stat" data-status="${status}"${tip}><span class="stat-card__value">${counts[status]}</span><span class="stat-card__label">${esc(STATUS_LABELS[status])}</span></button>`;
  }).join('');
  const totalCard = `<div class="stat-card stat-card--total"><span class="stat-card__value">${total}</span><span class="stat-card__label">合计</span></div>`;
  return `<div class="stat-grid" aria-label="任务状态统计（基于最近 100 条聚合）">${cards}${totalCard}</div>`;
}

// ---------- FR-T-2 筛选条 ----------

function filterBarHtml(filters: TaskFilters, agentOptions: ReadonlyArray<string>, search: string): string {
  const statusOptions = ['<option value="">全部状态</option>',
    ...SERVER_STATUSES.map((s) => `<option value="${s}"${filters.status === s ? ' selected' : ''}>${esc(STATUS_LABELS[s])}</option>`),
    `<option value="created"${filters.status === 'created' ? ' selected' : ''}>${esc(STATUS_LABELS.created)}（本地过滤）</option>`,
  ].join('');
  const agentOpts = ['<option value="">全部 Agent</option>',
    ...agentOptions.map((a) => `<option value="${esc(a)}"${filters.agent === a ? ' selected' : ''}>${esc(a)}</option>`),
  ].join('');
  const rangeOpts = RANGE_OPTIONS.map((o) => `<option value="${o.key}"${filters.range === o.key ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<div class="filter-bar">
    <label class="filter">状态<select data-filter="status">${statusOptions}</select></label>
    <label class="filter">Agent<select data-filter="agent">${agentOpts}</select></label>
    <label class="filter">时间范围<select data-filter="range">${rangeOpts}</select></label>
    <input class="filter__search" data-filter="search" type="search" placeholder="按任务 ID 前缀搜索" value="${esc(search)}" />
    <span class="hint">时间范围为前端过滤（服务端无时间参数）</span>
  </div>`;
}

// ---------- FR-T-3 行内操作 ----------

function rowActionsHtml(row: TaskListRow, stale: boolean): string {
  const detail = `<a class="btn btn--ghost btn--sm" href="#/tasks/${encodeURIComponent(row.taskId)}">详情</a>`;
  if (stale) {
    // FR-T-4：滞留行出口是崩溃恢复（全局），不出取消——防误杀仍正常执行的独立进程任务
    return `${detail}<button type="button" class="btn btn--danger btn--sm" data-action="crash-recovery">显式崩溃恢复</button>`;
  }
  const cancel = ['queued', 'running', 'paused'].includes(row.status)
    ? `<button type="button" class="btn btn--secondary btn--sm" data-action="cancel" data-task-id="${esc(row.taskId)}" data-task-status="${esc(row.status)}">取消</button>`
    : '';
  const resume = row.status === 'paused'
    ? `<button type="button" class="btn btn--primary btn--sm" data-action="resume" data-task-id="${esc(row.taskId)}">续跑</button>`
    : '';
  return `${detail}${cancel}${resume}`;
}

function staleMarkHtml(): string {
  return '<span class="stale-mark" title="该任务运行时间异常，可能是孤儿运行" aria-label="运行时间异常警告">⚠</span>';
}

// ---------- 页面 ----------

export interface TasksPageModel {
  stats: Record<string, number>;
  total: number;
  rows: TaskListRow[];
  runningStaleIds: ReadonlyArray<string>;
  page: number;
  pageCount: number;
  filters: TaskFilters;
  agentOptions: ReadonlyArray<string>;
  search: string;
  feedback: PageFeedback | null;
  now: number;
}

export function tasksPageHtml(m: TasksPageModel): string {
  const header = pageHeaderHtml({ view: 'tasks', title: '任务列表' });
  const stats = statCardsHtml(m.stats, m.total, m.filters.status);
  const filters = filterBarHtml(m.filters, m.agentOptions, m.search);

  let body: string;
  if (m.rows.length === 0) {
    const hasFilter = m.filters.status !== null || m.filters.agent !== null || m.filters.range !== 'all' || m.search.length > 0;
    body = cardHtml({
      title: '任务列表',
      body: emptyStateHtml({
        title: '当前筛选无任务',
        hint: hasFilter ? '调整或清除筛选条件后再试' : '尚无任务记录',
        actionLabel: hasFilter ? '清除筛选' : undefined,
        actionAttrs: hasFilter ? 'data-action="clear-filters"' : undefined,
      }),
    });
  } else {
    const rowsHtml = m.rows.map((row) => {
      const stale = m.runningStaleIds.includes(row.taskId);
      return `<tr>
        <td><a class="mono" href="#/tasks/${encodeURIComponent(row.taskId)}" title="${esc(row.taskId)}">${esc(shortId(row.taskId))}</a></td>
        <td>${esc(row.agentId)}</td>
        <td>${statusBadgeHtml(row.status)}${stale ? staleMarkHtml() : ''}</td>
        <td>${row.attemptCount}</td>
        <td>${row.modelCallCount}</td>
        <td>${formatThousands(row.tokensUsed)}</td>
        <td>${esc(formatTimestamp(row.createdAt))}</td>
        <td class="row-actions">${rowActionsHtml(row, stale)}</td>
      </tr>`;
    }).join('');
    body = cardHtml({
      title: `任务列表（第 ${m.page + 1} 页 / 共 ${m.total} 条）`,
      body: tableHtml({
        columns: ['任务', 'Agent', '状态', '尝试', '模型调用', 'Token', '创建时间', '操作'],
        rowsHtml,
      }),
      actionsHtml: pagerHtml(m.page, m.pageCount),
    });
  }
  const notice = m.runningStaleIds.length > 0
    ? `<p class="warning">检测到 ${m.runningStaleIds.length} 个滞留运行任务——若确认其执行进程已不存在，可执行显式崩溃恢复（全局操作，将把所有 Running 任务标记为 Failed(CrashRecovery)）。</p>`
    : '';
  return `${header}${feedbackHtml(m.feedback)}${stats}${filters}${notice}${body}`;
}

export function pagerHtml(page: number, pageCount: number): string {
  if (pageCount <= 1) return '';
  return `<div class="pager">
    <button type="button" class="btn btn--secondary btn--sm" data-action="page-prev"${page <= 0 ? ' disabled' : ''}>上一页</button>
    <span class="pager__label">第 ${page + 1} / ${pageCount} 页</span>
    <button type="button" class="btn btn--secondary btn--sm" data-action="page-next"${page >= pageCount - 1 ? ' disabled' : ''}>下一页</button>
  </div>`;
}
