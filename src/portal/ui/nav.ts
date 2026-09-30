// 第七阶段批次一（7-1/4）：导航与神兽行配置（设计 V0.3 §3.1 / §4 FR-G-6 / §15）。
// 三一级导航（应龙·任务 / 玄武·审批 / 观测——组名不加前缀）+ 观测二级聚合页签；
// Agent 导航按批次计划 7-4 交付。占位神兽（四名，见设计 §15.3 清单）零出现（§12-8 硬 DoD）。

import type { PortalUiView } from './routes.js';

export interface NavItem {
  key: string;
  label: string;
  hash: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { key: 'tasks', label: '应龙·任务', hash: '#/tasks' },
  { key: 'approvals', label: '玄武·审批', hash: '#/approvals' },
  { key: 'observe', label: '观测', hash: '#/observe' },
];

export const OBSERVE_TABS: NavItem[] = [
  { key: 'overview', label: '总控', hash: '#/observe' },
  { key: 'capabilities', label: '白泽·能力', hash: '#/observe/capabilities' },
  { key: 'evolution', label: '女娲·演进', hash: '#/observe/evolution' },
  { key: 'evidence', label: '夔牛·证据', hash: '#/observe/evidence' },
];

/** 当前路由 → 一级导航高亮键（详情页归属其一级导航；7-1 无 Agent 导航项 → null） */
export function activeNavKey(view: PortalUiView): string | null {
  if (view === 'tasks' || view === 'task-detail') return 'tasks';
  if (view === 'approvals' || view === 'approval-detail') return 'approvals';
  if (view === 'observe' || view === 'observe-capabilities' || view === 'observe-evolution' || view === 'observe-evolution-detail' || view === 'observe-evidence') return 'observe';
  return null;
}

/** 当前路由 → 观测二级页签高亮键（非观测族 → null） */
export function activeObserveTabKey(view: PortalUiView): string | null {
  if (view === 'observe') return 'overview';
  if (view === 'observe-capabilities') return 'capabilities';
  if (view === 'observe-evolution' || view === 'observe-evolution-detail') return 'evolution';
  if (view === 'observe-evidence') return 'evidence';
  return null;
}

/** 页头神兽行（FR-G-6：神兽图标 + 神兽名·工程名 + 一句定位语）；观测总控为跨域聚合页、Agent 页为工程视图——均无神兽行 */
export interface BeastHeader {
  beast: string;
  /** 工程名（界面域名后半） */
  engineer: string;
  /** 一句定位语（不承诺未落地能力，§15.1 基座如实） */
  tagline: string;
  /** 神兽图标位（首字） */
  icon: string;
}

const BEAST_HEADERS: Partial<Record<PortalUiView, BeastHeader>> = {
  'tasks': { beast: '应龙', engineer: '任务工作台', tagline: '任务执行域：调度、运行与状态机', icon: '应' },
  'task-detail': { beast: '应龙', engineer: '任务工作台', tagline: '任务执行域：调度、运行与状态机', icon: '应' },
  'approvals': { beast: '玄武', engineer: '审批中心', tagline: '审批与发布守卫：风险分级与写前脱敏', icon: '玄' },
  'approval-detail': { beast: '玄武', engineer: '审批中心', tagline: '审批与发布守卫：风险分级与写前脱敏', icon: '玄' },
  'observe-capabilities': { beast: '白泽', engineer: '能力登记', tagline: 'Capability Registry：能力画像与登记', icon: '白' },
  'observe-evolution': { beast: '女娲', engineer: '演进候选', tagline: 'Evolution：演进候选清单（只读）', icon: '女' },
  'observe-evolution-detail': { beast: '女娲', engineer: '演进候选', tagline: 'Evolution：演进候选清单（只读）', icon: '女' },
  'observe-evidence': { beast: '夔牛', engineer: '证据存证', tagline: 'Evidence Store：证据存证与追溯', icon: '夔' },
};

export function beastHeaderOf(view: PortalUiView): BeastHeader | null {
  return BEAST_HEADERS[view] ?? null;
}
