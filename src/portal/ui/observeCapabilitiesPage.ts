// 第七阶段批次三（7-3/4）：观测·白泽·能力控制器（设计 V0.3 §7.2 FR-O-2）。
// Agent 选择器 = /api/tasks?limit=100 与 /api/capabilities 两源 agentId 去重排序（无 /api/agents 端点）；
// 能力矩阵 = /api/capabilities?agent=&kind=&status=（同一端点查询参数，api.ts:141-158 实测参数面）；
// 筛选状态写入 hash 查询串（URL 同步，FR-AG-5 ?agent= 前向预选）；轮询 10s（FR-G-4 观测各页档）；
// 只读无写操作；读面 401 → 认证失效提示并停轮询（§11-2）。

import { apiGet } from './client.js';
import { AUTH_EXPIRED_TEXT } from './errors.js';
import { collectAgentIds } from './observeData.js';
import { observeCapabilitiesHtml, type CapabilityFilters, type CapabilityRowUi } from './observeCapabilitiesView.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { createPoller } from './poll.js';
import { loadToken } from './token.js';

const POLL_INTERVAL_MS = 10_000;
const STATS_LIMIT = 100;
const TASKS_PATH = `/api/tasks?limit=${STATS_LIMIT}`;
const CAPABILITIES_BASE = '/api/capabilities';

const KINDS = new Set(['capability', 'limitation']);
const STATUSES = new Set(['candidate', 'active', 'retired']);

export function parseCapabilityFilters(query: Record<string, string>): CapabilityFilters {
  const agent = query.agent && query.agent.length > 0 ? query.agent : null;
  const kind = KINDS.has(query.kind ?? '') ? (query.kind as string) : null;
  const status = STATUSES.has(query.status ?? '') ? (query.status as string) : null;
  return { agent, kind, status };
}

/** URL 同步序列化：默认值（全空）省略；顺序 agent/kind/status */
export function capabilityFiltersQuery(f: CapabilityFilters): string {
  const parts: string[] = [];
  if (f.agent !== null) parts.push(`agent=${encodeURIComponent(f.agent)}`);
  if (f.kind !== null) parts.push(`kind=${f.kind}`);
  if (f.status !== null) parts.push(`status=${f.status}`);
  return parts.join('&');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function taskAgentRowsOf(data: unknown): Array<{ agentId: string }> {
  const body = isRecord(data) && Array.isArray(data.tasks) ? data.tasks : Array.isArray(data) ? data : [];
  return body.filter((r): r is { agentId: string } => isRecord(r) && typeof r.agentId === 'string');
}

function capRowsOf(data: unknown): CapabilityRowUi[] {
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((r): r is CapabilityRowUi =>
    isRecord(r) && typeof r.capabilityId === 'string' && typeof r.status === 'string' && typeof r.agentId === 'string');
}

export function mountObserveCapabilitiesPage(ctx: PageCtx, query: Record<string, string>): PageHandle {
  let filters = parseCapabilityFilters(query);
  let agents: string[] = [];
  let rows: CapabilityRowUi[] = [];
  let authFailed = false;
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  function matrixPath(): string | null {
    const q = capabilityFiltersQuery(filters);
    return q ? `${CAPABILITIES_BASE}?${q}` : null; // 无筛选时复用选择器已拉的全量结果
  }

  function render(): void {
    ctx.view.innerHTML = observeCapabilitiesHtml({ agents, filters, rows, now: ctx.now() });
  }

  function renderAuthFailed(): void {
    ctx.view.innerHTML = `<div class="error-state" role="alert"><p class="error-state__message">${AUTH_EXPIRED_TEXT}</p></div>`;
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const [tasksRes, capsRes] = await Promise.all([
      apiGet(TASKS_PATH, deps),
      apiGet(CAPABILITIES_BASE, deps), // 选择器源（全量）
    ]);
    if ((tasksRes.ok === false && tasksRes.kind === 'http' && tasksRes.status === 401)
      || (capsRes.ok === false && capsRes.kind === 'http' && capsRes.status === 401)) {
      authFailed = true;
      poller.stop();
      renderAuthFailed();
      return;
    }
    if (tasksRes.ok && capsRes.ok) {
      agents = collectAgentIds(taskAgentRowsOf(tasksRes.data), capRowsOf(capsRes.data));
    }
    const path = matrixPath();
    if (path === null) {
      rows = capsRes.ok ? capRowsOf(capsRes.data) : rows;
      render();
      return;
    }
    const matrixRes = await apiGet(path, deps);
    if (matrixRes.ok === false && matrixRes.kind === 'http' && matrixRes.status === 401) {
      authFailed = true;
      poller.stop();
      renderAuthFailed();
      return;
    }
    if (matrixRes.ok) rows = capRowsOf(matrixRes.data);
    render();
  }

  const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });

  function navigate(next: CapabilityFilters): void {
    filters = { ...next }; // 本地先同步以撑住连续变更间隙（hashchange 后重挂载，URL 同步）
    const q = capabilityFiltersQuery(next);
    location.hash = `#/observe/capabilities${q ? `?${q}` : ''}`;
  }

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    if (hit.dataset.action === 'clear-filters') navigate({ agent: null, kind: null, status: null });
  }

  function onChange(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null; value?: string } | null;
    const hit = target?.closest?.('[data-filter]');
    if (!hit) return;
    const key = hit.dataset.filter;
    const value = target?.value ?? '';
    const v = value.length > 0 ? value : null;
    if (key === 'agent') navigate({ ...filters, agent: v });
    else if (key === 'kind') navigate({ ...filters, kind: v });
    else if (key === 'status') navigate({ ...filters, status: v });
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
