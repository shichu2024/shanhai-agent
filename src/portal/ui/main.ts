// 第七阶段批次一（7-1/4）：门户全局框架装配（设计 V0.3 §4 FR-G-1..6 / §3.2 页面骨架）。
// 装配：fragment Token 消费（TASK-96）→ Token 表单 → 旧路由 location.replace 一次性改写 →
// 骨架页渲染 + 一级导航高亮 + 观测二级页签 → 连接状态三态指示（探针轮询 + 可见性暂停）。
// 依赖全部可注入（tests/wp7-1-portal-shell.test.ts node 环境直测装配逻辑）。
// 产物经 esbuild 打包为单文件 IIFE 直出 src/portal/public/app.js（方案 A 条件①，入库）。

import { legacyRedirect, parseHash } from './routes.js';
import { activeNavKey } from './nav.js';
import { loadToken, saveToken, clearToken, consumeTokenFragment } from './token.js';
import {
  CONNECTION_LABELS,
  evaluateConnection,
  initialConnection,
  nextConnection,
  outcomeFor,
  type ConnectionState,
} from './connection.js';
import { createPoller, type TimerHost } from './poll.js';
import { renderContent } from './pages.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { mountTasksPage } from './tasksPage.js';
import { mountTaskDetailPage } from './taskDetailPage.js';
import { mountApprovalsPage } from './approvalsPage.js';
import { mountApprovalDetailPage } from './approvalDetailPage.js';
import { mountObserveOverviewPage } from './observeOverviewPage.js';
import { mountObserveCapabilitiesPage } from './observeCapabilitiesPage.js';
import { mountObserveEvolutionPage } from './observeEvolutionPage.js';
import { mountObserveEvolutionDetailPage } from './observeEvolutionDetailPage.js';
import { mountObserveEvidencePage } from './observeEvidencePage.js';

declare const __PORTAL_APP_VERSION__: string;

const APP_VERSION = typeof __PORTAL_APP_VERSION__ !== 'undefined' ? __PORTAL_APP_VERSION__ : '';

const DEFAULT_TIMER_HOST: TimerHost = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 连接探针周期（观测面轮询档 §4 FR-G-4；探针仅为连接指示服务，页面数据轮询 7-2/7-3 随页面接入） */
const PROBE_INTERVAL_MS = 10_000;

export interface BootOptions {
  document?: Document;
  window?: Window;
  timerHost?: TimerHost;
  fetchImpl?: typeof fetch;
  probeIntervalMs?: number;
  /** 确认框实现（默认 window.confirm；测试可注入） */
  confirmBox?: (text: string) => boolean;
}

export interface BootDeps {
  document: Document;
  window: Window;
  timerHost: TimerHost;
  fetchImpl: typeof fetch;
}

export function realDeps(): BootDeps {
  return {
    document: globalThis.document,
    window: globalThis as unknown as Window,
    timerHost: DEFAULT_TIMER_HOST,
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  };
}

export function boot(opts: BootOptions = {}): void {
  const doc = opts.document ?? globalThis.document;
  const win = opts.window ?? (globalThis as unknown as Window);
  const timerHost = opts.timerHost ?? DEFAULT_TIMER_HOST;
  const fetchImpl = opts.fetchImpl ?? realDeps().fetchImpl;
  const probeIntervalMs = opts.probeIntervalMs ?? PROBE_INTERVAL_MS;

  const view = doc.getElementById('view');
  const tokenStateEl = doc.getElementById('token-state');
  const connEl = doc.getElementById('connection-indicator');
  const versionEl = doc.getElementById('app-version');
  if (versionEl) versionEl.textContent = APP_VERSION;

  let conn: ConnectionState = initialConnection();

  function refreshTokenState(): void {
    if (tokenStateEl) tokenStateEl.textContent = loadToken() ? '已设置' : '未设置';
  }

  function renderConnection(): void {
    if (!connEl) return;
    connEl.className = `conn conn--${conn.phase}`;
    connEl.textContent = CONNECTION_LABELS[conn.phase];
  }

  /** 连接探针：带 Token 时 GET /api/tasks?limit=1（既有端点只读探测；401/403 不计入断连） */
  async function probe(): Promise<void> {
    const token = loadToken();
    if (!token) {
      if (connEl) {
        connEl.className = 'conn conn--unknown';
        connEl.textContent = '未认证（请设置 Token）';
      }
      return;
    }
    try {
      const res = await fetchImpl('/api/tasks?limit=1', { headers: { Authorization: `Bearer ${token}` } });
      conn = nextConnection(conn, outcomeFor(res.status), Date.now());
    } catch {
      conn = nextConnection(conn, 'fail', Date.now());
    }
    conn = evaluateConnection(conn, Date.now());
    renderConnection();
  }

  const probePoller = createPoller({ intervalMs: probeIntervalMs, fn: probe, timerHost });

  let activePage: PageHandle | null = null;

  function mountPage(route: ReturnType<typeof parseHash>['route'], query: Record<string, string>): void {
    if (!view) return;
    const ctx: PageCtx = {
      doc,
      view,
      fetchImpl,
      timerHost,
      confirmBox: opts.confirmBox ?? ((text: string) => win.confirm(text)),
      now: () => Date.now(),
    };
    switch (route.view) {
      case 'tasks': activePage = mountTasksPage(ctx, query); break;
      case 'task-detail': activePage = mountTaskDetailPage(ctx, route.id); break;
      case 'approvals': activePage = mountApprovalsPage(ctx, query); break;
      case 'approval-detail': activePage = mountApprovalDetailPage(ctx, route.id); break;
      case 'observe': activePage = mountObserveOverviewPage(ctx); break;
      case 'observe-capabilities': activePage = mountObserveCapabilitiesPage(ctx, query); break;
      case 'observe-evolution': activePage = mountObserveEvolutionPage(ctx); break;
      case 'observe-evolution-detail': activePage = mountObserveEvolutionDetailPage(ctx, route.id); break;
      case 'observe-evidence': activePage = mountObserveEvidencePage(ctx, query); break;
      default: activePage = null; break;
    }
  }

  function renderRoute(): void {
    const hash = location.hash;
    const redirect = legacyRedirect(hash);
    if (redirect) {
      location.replace(redirect); // 旧路由一次性改写（hashchange 后按新路由渲染），不留双跳历史
      return;
    }
    if (!view) return;
    if (activePage) activePage.destroy(); // 路由切换：停旧页轮询与监听（FR-G-4 页面级轮询生命周期）
    activePage = null;
    const { route, query } = parseHash(hash);
    view.innerHTML = renderContent(route, query);
    mountPage(route, query);
    const navKey = activeNavKey(route.view);
    for (const link of doc.querySelectorAll('[data-nav]')) {
      const el = link as HTMLElement;
      el.className = el.dataset.nav === navKey ? 'nav-link active' : 'nav-link';
    }
  }

  const tokenForm = doc.getElementById('token-form');
  tokenForm?.addEventListener('submit', (ev: Event) => {
    ev.preventDefault();
    const input = doc.getElementById('token-input') as HTMLInputElement | null;
    const value = input ? input.value.trim() : '';
    if (value) saveToken(value);
    else clearToken();
    refreshTokenState();
    renderRoute();
    void probe(); // Token 变更后立即探测连接
  });

  connEl?.addEventListener('click', () => {
    void probe(); // 断开态点击重连（§10.4 连接状态区）
  });

  doc.addEventListener('visibilitychange', () => {
    probePoller.onVisibility(!doc.hidden); // 页面不可见暂停轮询，恢复可见立即拉一次（FR-G-4）
  });
  win.addEventListener('hashchange', renderRoute);

  refreshTokenState();
  consumeTokenFragment();
  refreshTokenState(); // fragment 消费后刷新状态文案（TASK-96 拉起形态：标签须显示「已设置」）
  const tokenInput = doc.getElementById('token-input') as HTMLInputElement | null;
  if (tokenInput && loadToken()) tokenInput.value = loadToken();
  if (connEl) connEl.textContent = '检测中';
  renderRoute();
  probePoller.start();
}

if (typeof document !== 'undefined') boot(realDeps());
