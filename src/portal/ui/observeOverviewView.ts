// 第七阶段批次三（7-3/4）：观测·总控 HTML 构建（设计 V0.3 §7.1 FR-O-1，字符串面纯函数）。
// 三块统计卡（任务七状态+成功率 / 待办审批 / 能力三枚举）+ 合并时间线 + 快速入口。
// 明示：无 /api/stats 端点，全部统计为客户端聚合（卡片口径注记）。

import { cardHtml, emptyStateHtml, esc, pageHeaderHtml, statusBadgeHtml } from './components.js';
import { formatTimestamp, shortId } from './format.js';
import { STATUS_LABELS } from './components.js';
import { CAPABILITY_STATUS_LABELS, type TimelineEntry } from './observeData.js';
import { decisionBadgeHtml } from './approvalsView.js';
import { observeTabsHtml } from './pages.js';

const SEVEN = ['created', 'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'] as const;

const QUICK_ENTRIES: ReadonlyArray<{ label: string; hash: string; hint: string }> = [
  { label: '任务列表', hash: '#/tasks', hint: '应龙·任务工作台' },
  { label: '审批中心', hash: '#/approvals', hint: '玄武·审批与发布守卫' },
  { label: 'Agent 目录', hash: '#/agents', hint: 'Agent 目录与详情' },
  { label: '证据查询', hash: '#/observe/evidence', hint: '夔牛·按 ref 直查' },
];

export interface OverviewModel {
  taskCounts: Record<string, number>;
  /** 聚合样本数（≤100） */
  taskTotal: number;
  /** 服务端 total（>100 时标注「基于最近 100 条」） */
  taskTotalAll: number;
  /** succeeded / (total − cancelled)；分母 ≤0 → null */
  successRate: number | null;
  pendingCount: number;
  /** 「最老待办 x 分钟前」；无待办空串 */
  oldestPending: string;
  capabilityCounts: { candidate: number; active: number; retired: number };
  timeline: ReadonlyArray<TimelineEntry>;
  loading: boolean;
  now: number;
}

function taskStatsCardHtml(m: OverviewModel): string {
  const note = m.taskTotalAll > 100 ? '<p class="hint">基于最近 100 条（全量更多，客户端聚合口径）</p>' : '';
  const cards = SEVEN.map((s) => `<div class="stat-card${m.taskCounts[s] === 0 ? ' stat-card--zero stat-card--muted' : ''}"><span class="stat-card__value">${m.taskCounts[s]}</span><span class="stat-card__label">${esc(STATUS_LABELS[s])}</span></div>`).join('');
  const rate = m.successRate === null ? '—' : `${Math.round(m.successRate * 100)}%`;
  const total = `<div class="stat-card stat-card--total"><span class="stat-card__value">${m.taskTotal}</span><span class="stat-card__label">合计</span></div>
    <div class="stat-card stat-card--total"><span class="stat-card__value">${rate}</span><span class="stat-card__label">成功率</span></div>`;
  return cardHtml({
    title: '任务统计（最近 100 条客户端聚合，无统计端点）',
    body: `<div class="stat-grid">${cards}${total}</div>${note}`,
  });
}

function approvalsCardHtml(m: OverviewModel): string {
  const oldest = m.oldestPending ? `<p class="hint">${esc(m.oldestPending)}</p>` : '<p class="hint">当前无待办审批</p>';
  return cardHtml({
    title: '待办审批',
    body: `<div class="stat-grid"><div class="stat-card stat-card--total"><span class="stat-card__value">${m.pendingCount}</span><span class="stat-card__label">待决议</span></div></div>${oldest}`,
  });
}

function capabilityCardHtml(m: OverviewModel): string {
  const statuses = ['candidate', 'active', 'retired'] as const;
  const cards = statuses.map((s) => `<div class="stat-card${m.capabilityCounts[s] === 0 ? ' stat-card--muted' : ''}"><span class="stat-card__value">${m.capabilityCounts[s]}</span><span class="stat-card__label">${esc(CAPABILITY_STATUS_LABELS[s])}</span></div>`).join('');
  return cardHtml({
    title: '能力登记',
    body: `<div class="stat-grid">${cards}</div>`,
  });
}

function timelineHtml(entries: ReadonlyArray<TimelineEntry>): string {
  if (entries.length === 0) {
    return cardHtml({ title: '合并时间线（最新任务 + 待办审批）', body: emptyStateHtml({ title: '暂无动态' }) });
  }
  const rows = entries.map((e) => {
    if (e.kind === 'task') {
      return `<li class="feed-item"><span class="feed-item__time">${esc(formatTimestamp(e.at))}</span><a class="mono" href="#/tasks/${encodeURIComponent(e.taskId)}" title="${esc(e.taskId)}">${esc(shortId(e.taskId))}</a>${statusBadgeHtml(e.status)}</li>`;
    }
    return `<li class="feed-item"><span class="feed-item__time">${esc(formatTimestamp(e.at))}</span><a class="mono" href="#/approvals/${encodeURIComponent(e.requestId)}" title="${esc(e.requestId)}">${esc(shortId(e.requestId))}</a><span class="hint">${esc(e.toolId)}</span>${decisionBadgeHtml('pending')}</li>`;
  }).join('');
  return cardHtml({
    title: '合并时间线（最新任务前 10 + 待办审批，时间倒序）',
    body: `<ul class="feed">${rows}</ul>`,
  });
}

function quickEntriesHtml(): string {
  const items = QUICK_ENTRIES.map((q) => `<a class="entry-card" href="${q.hash}"><span class="entry-card__label">${esc(q.label)}</span><span class="entry-card__hint">${esc(q.hint)}</span></a>`).join('');
  return cardHtml({ title: '快速入口', body: `<div class="entry-grid">${items}</div>` });
}

export function observeOverviewHtml(m: OverviewModel): string {
  const header = pageHeaderHtml({ view: 'observe', title: '观测·总控' });
  return `${observeTabsHtml('observe')}${header}${taskStatsCardHtml(m)}${approvalsCardHtml(m)}${capabilityCardHtml(m)}${timelineHtml(m.timeline)}${quickEntriesHtml()}`;
}
