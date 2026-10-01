// 第七阶段批次一（7-1/4）：统一组件（设计 V0.3 §10.4 组件规范，字符串面——node 环境可测）。
// 按钮/输入/表格/卡片/弹层/徽章/空态/骨架屏；状态徽章 = 圆点 + 文字（不单独依赖颜色，色盲可辨）。

import { beastHeaderOf } from './nav.js';
import type { PortalUiView } from './routes.js';

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// ---------- 徽章 ----------

/** 任务状态七值中文文案（§10.2 / FR-T-4 表，与 db.ts:103 CHECK 一致） */
export const STATUS_LABELS: Record<string, string> = {
  created: '已创建',
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function statusBadgeHtml(status: string): string {
  const label = STATUS_LABELS[status] ?? status;
  return `<span class="badge badge--status-${esc(status)}"><span class="badge__dot"></span>${esc(label)}</span>`;
}

/** 风险档 L0..L4 五值（db.ts:89 tool_registry CHECK）；L3/L4 高危红色加粗（FR-AD-1） */
export function riskBadgeHtml(level: string): string {
  const high = level === 'L3' || level === 'L4';
  return `<span class="badge badge--risk${high ? ' badge--danger' : ''}">${esc(level)}</span>`;
}

// ---------- 按钮（4 态齐全经 CSS：默认/悬停/聚焦/禁用） ----------

export function buttonHtml(label: string, kind: 'primary' | 'secondary' | 'danger' | 'ghost' = 'secondary', extra = ''): string {
  return `<button type="button" class="btn btn--${kind}"${extra ? ` ${extra}` : ''}>${esc(label)}</button>`;
}

// ---------- 空态 / 错误态 / 加载态 / 骨架屏 ----------

export function emptyStateHtml(opts: { title: string; hint?: string; actionLabel?: string; actionAttrs?: string }): string {
  const action = opts.actionLabel ? `<button type="button" class="btn btn--primary"${opts.actionAttrs ? ` ${opts.actionAttrs}` : ''}>${esc(opts.actionLabel)}</button>` : '';
  const hint = opts.hint ? `<p class="empty-state__hint">${esc(opts.hint)}</p>` : '';
  return `<div class="empty-state"><div class="empty-state__icon" aria-hidden="true"></div><p class="empty-state__title">${esc(opts.title)}</p>${hint}${action}</div>`;
}

export function errorStateHtml(opts: { code?: string; message: string; retryLabel?: string }): string {
  const code = opts.code ? `<span class="error-state__code">${esc(opts.code)}</span>` : '';
  const retry = `<button type="button" class="btn btn--secondary error-state__retry">${esc(opts.retryLabel ?? '重试')}</button>`;
  return `<div class="error-state" role="alert">${code}<p class="error-state__message">${esc(opts.message)}</p>${retry}</div>`;
}

export function loadingStateHtml(): string {
  return '<div class="loading-state" role="status">加载中……</div>';
}

export function skeletonHtml(rows: number): string {
  const items = Array.from({ length: Math.max(1, rows) }, () => '<div class="skeleton skeleton--row" aria-hidden="true"></div>').join('');
  return `<div class="skeleton-group">${items}</div>`;
}

// ---------- 卡片 / 表格 / 弹层 ----------

export function cardHtml(opts: { title: string; body: string; actionsHtml?: string }): string {
  const actions = opts.actionsHtml ? `<div class="card__actions">${opts.actionsHtml}</div>` : '';
  return `<section class="card"><header class="card__header"><h3 class="card__title">${esc(opts.title)}</h3>${actions}</header><div class="card__body">${opts.body}</div></section>`;
}

export function tableHtml(opts: { columns: string[]; rowsHtml: string; caption?: string }): string {
  const head = opts.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  return `<div class="table-wrap"><table class="table">${opts.caption ? `<caption>${esc(opts.caption)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${opts.rowsHtml}</tbody></table></div>`;
}

/** 居中模态确认框（遮罩点击与 Esc 均不关闭，必须显式选择——§10.4） */
export function confirmModalHtml(opts: { title: string; bodyHtml: string; confirmLabel: string; cancelLabel?: string }): string {
  return `<div class="modal-overlay" role="presentation"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h3 id="modal-title" class="modal__title">${esc(opts.title)}</h3><div class="modal__body">${opts.bodyHtml}</div><div class="modal__actions"><button type="button" class="btn btn--secondary">${esc(opts.cancelLabel ?? '取消')}</button><button type="button" class="btn btn--danger">${esc(opts.confirmLabel)}</button></div></div></div>`;
}

/** Toast（右上角滑入：info/success 3 秒自动消失，error 常驻至手动关闭——§10.4） */
export function toastHtml(message: string, type: 'info' | 'success' | 'error' = 'info'): string {
  return `<div class="toast toast--${type}" role="${type === 'error' ? 'alert' : 'status'}">${esc(message)}</div>`;
}

// ---------- 页头（FR-G-6 神兽行 + 页面标题 + 页面级操作位） ----------

export function pageHeaderHtml(opts: { view: PortalUiView; title: string; actionsHtml?: string }): string {
  const beast = beastHeaderOf(opts.view);
  const beastRow = beast
    ? `<div class="beast-row"><span class="beast-row__icon" aria-hidden="true">${esc(beast.icon)}</span><span class="beast-row__name">${esc(beast.beast)}·${esc(beast.engineer)}</span><span class="beast-row__tagline">${esc(beast.tagline)}</span></div>`
    : '';
  const actions = opts.actionsHtml ? `<div class="page-header__actions">${opts.actionsHtml}</div>` : '';
  return `<header class="page-header">${beastRow}<h2 class="page-header__title">${esc(opts.title)}</h2>${actions}</header>`;
}
