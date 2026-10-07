// 第七阶段批次三（7-3/4）：观测·女娲·演进列表控制器（设计 V0.3 §7.3 FR-O-3）。
// GET /api/evolution 全量 → 前端按 status 三枚举分组；整页只读无任何操作按钮
// （confirm/dismiss 属 D-45 延后）。轮询 10s（FR-G-4 观测各页档）；
// 读面 401 → 认证失效提示并停轮询（§11-2）。

import { apiGet } from './client.js';
import { AUTH_EXPIRED_TEXT } from './errors.js';
import { observeEvolutionHtml, type EvolutionRowUi } from './observeEvolutionView.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { createPoller } from './poll.js';
import { loadToken } from './token.js';

const POLL_INTERVAL_MS = 10_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function rowsOf(data: unknown): EvolutionRowUi[] {
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((r): r is EvolutionRowUi => isRecord(r) && typeof r.candidateId === 'string' && typeof r.status === 'string');
}

export function mountObserveEvolutionPage(ctx: PageCtx): PageHandle {
  let rows: EvolutionRowUi[] = [];
  let authFailed = false;
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  function render(): void {
    ctx.view.innerHTML = observeEvolutionHtml(rows);
  }

  function renderAuthFailed(): void {
    ctx.view.innerHTML = `<div class="error-state" role="alert"><p class="error-state__message">${AUTH_EXPIRED_TEXT}</p></div>`;
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const res = await apiGet('/api/evolution', deps);
    if (!res.ok && res.kind === 'http' && res.status === 401) {
      authFailed = true;
      poller.stop();
      renderAuthFailed();
      return;
    }
    if (res.ok) {
      rows = rowsOf(res.data);
      render();
    }
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
