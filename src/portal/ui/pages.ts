// 第七阶段批次一（7-1/4）骨架 + 批次二（7-2/4）任务/审批页 + 批次三（7-3/4）观测族接线
// + 批次四（7-4/4）Agent 目录与详情接线（设计 V0.3 §3.3 路由与视图契约）。
// 数据页由页面控制器挂载（数据到达后重渲染内容区，控制器 HTML 自带页签/页头）；
// 至此全站无「建设中」占位页（7-4 收官）。

import { OBSERVE_TABS, activeObserveTabKey } from './nav.js';
import type { PortalUiRoute } from './routes.js';
import { esc, loadingStateHtml, pageHeaderHtml } from './components.js';
import { shortId } from './format.js';

const PAGE_TITLES: Partial<Record<PortalUiRoute['view'], string>> = {
  'tasks': '任务列表',
  'task-detail': '任务详情',
  'approvals': '待办审批',
  'approval-detail': '审批详情',
  'observe': '观测·总控',
  'observe-capabilities': '观测·白泽·能力',
  'observe-evolution': '观测·女娲·演进',
  'observe-evolution-detail': '观测·女娲·演进·详情',
  'observe-evidence': '观测·夔牛·证据',
  'agents': 'Agent 目录',
  'agent-detail': 'Agent 详情',
};

function detailTitle(view: PortalUiRoute['view'], id: string): string {
  return `${PAGE_TITLES[view]}（${shortId(id)}）`;
}

/** 观测二级页签（FR-G-2：当前页签高亮 + aria-current） */
export function observeTabsHtml(view: PortalUiRoute['view']): string {
  const active = activeObserveTabKey(view);
  const tabs = OBSERVE_TABS.map((t) => {
    const isActive = t.key === active;
    return `<a class="tab${isActive ? ' active' : ''}" href="${t.hash}"${isActive ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`;
  }).join('');
  return `<nav class="tabs" aria-label="观测二级导航">${tabs}</nav>`;
}

/** 数据页初始壳：页头 + 加载态（控制器 fetch 后重渲染内容区） */
function loadingPage(view: PortalUiRoute['view'], opts?: { id?: string }): string {
  const title = opts?.id ? detailTitle(view, opts.id) : PAGE_TITLES[view]!;
  return `${pageHeaderHtml({ view, title })}${loadingStateHtml()}`;
}

export function renderContent(route: PortalUiRoute, query: Record<string, string>): string {
  switch (route.view) {
    case 'tasks':
      return loadingPage('tasks');
    case 'task-detail':
      return loadingPage('task-detail', { id: route.id });
    case 'approvals':
      return loadingPage('approvals');
    case 'approval-detail':
      return loadingPage('approval-detail', { id: route.id });
    case 'observe':
      return `${observeTabsHtml('observe')}${loadingPage('observe')}`;
    case 'observe-capabilities':
      return `${observeTabsHtml('observe-capabilities')}${loadingPage('observe-capabilities')}`;
    case 'observe-evolution':
      return `${observeTabsHtml('observe-evolution')}${loadingPage('observe-evolution')}`;
    case 'observe-evolution-detail':
      return `${observeTabsHtml('observe-evolution-detail')}${loadingPage('observe-evolution-detail', { id: route.id })}`;
    case 'observe-evidence':
      return `${observeTabsHtml('observe-evidence')}${loadingPage('observe-evidence')}`;
    case 'agents':
      return loadingPage('agents');
    case 'agent-detail':
      return loadingPage('agent-detail', { id: route.id });
    case 'not-found':
      return `<div class="error-state" role="alert"><p class="error-state__message">未找到视图：${esc(route.hash)}</p><a class="btn btn--primary" href="#/tasks">返回首页</a></div>`;
  }
}
