// 第七阶段批次二（7-2/4）：玄武·审批列表控制器（设计 V0.3 §6 FR-A-1..4）。
// 待办视图（默认）= GET /api/approvals?pending=true + 前端重排 requestedAt 正序（等待最久置顶）；
// 全部视图 = GET /api/approvals + decision 四枚举前端本地过滤（服务端参数面仅 pending=true）；
// 前端分页 20/页；轮询 5s（timeoutRemainingMs 随轮询刷新）。

import { apiGet } from './client.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { createPoller } from './poll.js';
import {
  allViewRows,
  approvalsPageHtml,
  pendingViewRows,
  type ApprovalListRow,
} from './approvalsView.js';
import type { PageFeedback } from './tasksView.js';
import { loadToken } from './token.js';

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 5_000;

function asRows(data: unknown): ApprovalListRow[] {
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((r): r is ApprovalListRow =>
    typeof r === 'object' && r !== null && typeof (r as ApprovalListRow).requestId === 'string');
}

export function mountApprovalsPage(ctx: PageCtx, _query: Record<string, string>): PageHandle {
  void _query;
  let mode: 'pending' | 'all' = 'pending';
  let decisionFilter: string | null = null;
  let page = 0;
  let allFetched: ApprovalListRow[] = [];
  let feedback: PageFeedback | null = null;
  let authFailed = false;
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  function viewRows(): ApprovalListRow[] {
    const source = mode === 'pending' ? pendingViewRows(allFetched) : allViewRows(allFetched);
    return mode === 'all' && decisionFilter !== null
      ? source.filter((r) => r.decision === decisionFilter) // FR-A-4 前端本地过滤
      : source;
  }

  function render(): void {
    const rows = viewRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const clamped = Math.min(page, pageCount - 1);
    ctx.view.innerHTML = approvalsPageHtml({
      mode,
      rows: rows.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE),
      page: clamped,
      pageCount,
      decisionFilter,
      feedback,
      now: ctx.now(),
    });
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const res = await apiGet(mode === 'pending' ? '/api/approvals?pending=true' : '/api/approvals', deps);
    if (!res.ok && res.kind === 'http' && res.status === 401) {
      authFailed = true;
      poller.stop();
      ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
      return;
    }
    if (res.ok) {
      allFetched = asRows(res.data);
      render();
    }
  }

  const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    const action = hit.dataset.action;
    if (action === 'view-pending' && mode !== 'pending') {
      mode = 'pending';
      decisionFilter = null;
      page = 0;
      void refresh();
    } else if (action === 'view-all' && mode !== 'all') {
      mode = 'all';
      page = 0;
      void refresh();
    } else if (action === 'page-prev' && page > 0) {
      page -= 1;
      render();
    } else if (action === 'page-next') {
      page += 1;
      render();
    }
  }

  function onChange(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null; value?: string } | null;
    const hit = target?.closest?.('[data-filter]');
    if (!hit || hit.dataset.filter !== 'decision') return;
    decisionFilter = target?.value ? target.value : null; // FR-A-4 前端本地过滤，不重拉
    page = 0;
    render();
  }

  function onVisibility(ev?: Event): void {
    const t = (ev as { target?: { hidden?: boolean } } | undefined)?.target;
    const hidden = typeof t?.hidden === 'boolean' ? t.hidden : ctx.doc.hidden;
    poller.onVisibility(!hidden);
  }

  ctx.view.addEventListener('click', onClick);
  ctx.view.addEventListener('change', onChange);
  ctx.doc.addEventListener('visibilitychange', onVisibility);
  void refresh();
  poller.start();

  return {
    destroy(): void {
      ctx.view.removeEventListener('click', onClick);
      ctx.view.removeEventListener('change', onChange);
      ctx.doc.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    },
  };
}
