// 第七阶段批次四（7-4/4）：Agent 目录与详情控制器（设计 V0.3 §7.5 FR-AG-1..5）。
// 目录 = FR-O-2 同款双源聚合（/api/tasks?limit=100 + /api/capabilities，无 /api/agents 端点）；
// 详情 = 四只读读面（card / insight / trend?bucket=day|week / report），并行拉取、分区独立错误条；
// bucket 切换走 URL 查询串同步（FR-T-2 同款纪律，?bucket=week，day 缺省省略）；
// 轮询 10s、不可见暂停（观测族同档）；读面 401 → 认证失效提示并停轮询（§11-2）；
// 「触发反思」写操作零出现（对应端点不存在，本期写面 5 POST 不含它）。

import { apiGet } from './client.js';
import { explainFailure, type ApiFailure } from './errors.js';

import { agentCatalogRows } from './agentsData.js';
import {
  agentCatalogHtml,
  agentDetailHtml,
  cardZone,
  insightZone,
  reportZone,
  type AgentDetailModel,
} from './agentsView.js';
import { trendBarsOf, trendSummaryOf } from './agentsData.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { createPoller } from './poll.js';
import { loadToken } from './token.js';

const POLL_INTERVAL_MS = 10_000;
const STATS_LIMIT = 100;
const TASKS_PATH = `/api/tasks?limit=${STATS_LIMIT}`;
const CAPABILITIES_BASE = '/api/capabilities';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isHttp401(r: unknown): boolean {
  return isRecord(r) && r.ok === false && (r as { kind?: unknown }).kind === 'http' && (r as { status?: unknown }).status === 401;
}

// ---------- Agent 目录（#/agents） ----------

export function mountAgentsPage(ctx: PageCtx): PageHandle {
  let authFailed = false;
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  function render(rows: ReturnType<typeof agentCatalogRows>): void {
    ctx.view.innerHTML = agentCatalogHtml({ rows, now: ctx.now() });
  }

  function renderAuthFailed(): void {
    ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
  }

  function renderError(message: string): void {
    ctx.view.innerHTML = `<div class="error-state" role="alert"><p class="error-state__message">目录加载失败：${message}</p><button type="button" class="btn btn--secondary error-state__retry" data-action="retry">重试</button></div>`;
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const [tasksRes, capsRes] = await Promise.all([
      apiGet(TASKS_PATH, deps),
      apiGet(CAPABILITIES_BASE, deps),
    ]);
    if (isHttp401(tasksRes) || isHttp401(capsRes)) {
      authFailed = true;
      poller.stop();
      renderAuthFailed();
      return;
    }
    if (!tasksRes.ok && !capsRes.ok) {
      renderError(explainFailure(tasksRes as ApiFailure)); // 两源均失败 → 错误条可重试
      return;
    }
    // 单源失败降级：以成功侧单源渲染（计数面按可得数据呈现，下一轮轮询补齐）
    const taskRows = (tasksRes.ok
      ? (isRecord(tasksRes.data) && Array.isArray(tasksRes.data.tasks) ? tasksRes.data.tasks : Array.isArray(tasksRes.data) ? tasksRes.data : [])
      : []
    ).filter((r): r is { agentId: string } => isRecord(r) && typeof r.agentId === 'string');
    const capRows = (capsRes.ok && Array.isArray(capsRes.data) ? capsRes.data : [])
      .filter((r): r is { agentId: string; status: string } => isRecord(r) && typeof r.agentId === 'string' && typeof r.status === 'string');
    render(agentCatalogRows(taskRows, capRows));
  }

  const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    if (hit.dataset.action === 'retry') void refresh();
  }

  function onVisibility(ev?: Event): void {
    const t = (ev as { target?: { hidden?: boolean } } | undefined)?.target;
    const hidden = typeof t?.hidden === 'boolean' ? t.hidden : ctx.doc.hidden;
    poller.onVisibility(!hidden);
  }

  ctx.view.addEventListener('click', onClick);
  ctx.doc.addEventListener('visibilitychange', onVisibility);
  ctx.view.innerHTML = '<div class="loading-state" role="status">加载中……</div>';
  void refresh();
  poller.start();

  return {
    destroy(): void {
      ctx.view.removeEventListener('click', onClick);
      ctx.doc.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    },
  };
}

// ---------- Agent 详情（#/agents/:id）四读面 ----------

type TrendZone = AgentDetailModel['trend']['data'];

export function mountAgentDetailPage(ctx: PageCtx, agentId: string, query: Record<string, string>): PageHandle {
  const bucket: 'day' | 'week' = query.bucket === 'week' ? 'week' : 'day';
  let authFailed = false;
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
  const base = `/api/agents/${encodeURIComponent(agentId)}`;
  const trendPath = bucket === 'week' ? `${base}/trend?bucket=week` : `${base}/trend`;

  const model: AgentDetailModel = {
    agentId,
    card: { data: null, error: null },
    insight: { data: null, error: null },
    trend: { data: null, error: null },
    report: { data: null, error: null },
    bucket,
    now: ctx.now(),
  };

  function render(): void {
    ctx.view.innerHTML = agentDetailHtml(model);
  }

  function renderAuthFailed(): void {
    ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
  }

  function failureText(r: unknown): string {
    return explainFailure(r as ApiFailure);
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const [cardRes, insightRes, trendRes, reportRes] = await Promise.all([
      apiGet(`${base}/card`, deps),
      apiGet(`${base}/insight`, deps),
      apiGet(trendPath, deps),
      apiGet(`${base}/report`, deps),
    ]);
    const results = [cardRes, insightRes, trendRes, reportRes];
    if (results.some(isHttp401)) {
      authFailed = true;
      poller.stop();
      renderAuthFailed();
      return;
    }
    if (cardRes.ok) model.card = cardZone(cardRes.data);
    else model.card = { data: null, error: failureText(cardRes) };
    if (insightRes.ok) model.insight = insightZone(insightRes.data);
    else model.insight = { data: null, error: failureText(insightRes) };
    if (trendRes.ok && isRecord(trendRes.data) && Array.isArray(trendRes.data.buckets)) {
      const summary = trendSummaryOf({
        agentId,
        bucket: typeof trendRes.data.bucket === 'string' ? trendRes.data.bucket : bucket,
        buckets: trendRes.data.buckets as Record<string, unknown>[],
      });
      const trend: TrendZone = {
        bars: trendBarsOf(trendRes.data.buckets as Record<string, unknown>[]),
        coverageNote: isRecord(trendRes.data.coverage) && typeof trendRes.data.coverage.note === 'string' ? trendRes.data.coverage.note : '',
        summary: {
          bucket: summary.bucket,
          bucketCount: summary.bucketCount,
          hasData: summary.hasData,
          latestKey: summary.latestKey,
          latestRateLabel: summary.latestRateLabel,
        },
      };
      model.trend = { data: trend, error: null };
    } else if (!trendRes.ok) {
      model.trend = { data: null, error: failureText(trendRes) };
    } else {
      model.trend = { data: null, error: '响应形状异常（trend buckets 键缺失）' };
    }
    if (reportRes.ok) model.report = reportZone(reportRes.data);
    else model.report = { data: null, error: failureText(reportRes) };
    render();
  }

  const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    const action = hit.dataset.action;
    if (action === 'retry') {
      void refresh(); // 分区错误条重试（FR-AG-1 加载失败显错误条可重试）
    } else if (action === 'bucket-day') {
      location.hash = `#/agents/${encodeURIComponent(agentId)}`; // day 缺省省略参数（URL 同步；同值写入不触发 hashchange）
    } else if (action === 'bucket-week') {
      location.hash = `#/agents/${encodeURIComponent(agentId)}?bucket=week`;
    }
  }

  function onVisibility(ev?: Event): void {
    const t = (ev as { target?: { hidden?: boolean } } | undefined)?.target;
    const hidden = typeof t?.hidden === 'boolean' ? t.hidden : ctx.doc.hidden;
    poller.onVisibility(!hidden);
  }

  ctx.view.addEventListener('click', onClick);
  ctx.doc.addEventListener('visibilitychange', onVisibility);
  render(); // 初始壳（各分区加载态）
  void refresh();
  poller.start();

  return {
    destroy(): void {
      ctx.view.removeEventListener('click', onClick);
      ctx.doc.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    },
  };
}
