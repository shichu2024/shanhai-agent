// 第七阶段批次二（7-2/4）：玄武·审批中心 HTML 构建 + 纯逻辑（设计 V0.3 §6 FR-A-1..4 / FR-AD-1..6）。
// 数据源实测口径：列表 GET /api/approvals（唯一参数 pending=true，api.ts:97-100；投影无 riskLevel/
// decidedAt——风险档与决议时间仅在详情页）；详情 GET /api/approvals/:id（request 全行 + binding +
// snapshot 元信息 + argsDigest，无明文入参）。

import { cardHtml, emptyStateHtml, esc, pageHeaderHtml, riskBadgeHtml, statusBadgeHtml, tableHtml } from './components.js';
import { formatThousands, formatTimestamp, shortId } from './format.js';
import { feedbackHtml, pagerHtml, type PageFeedback } from './tasksView.js';
import { approveActionHint } from '../view/write.js';

export const APPROVAL_DECISION_LABELS: Record<string, string> = {
  pending: '待决议',
  approved: '已批准',
  denied: '已否决',
  superseded: '已作废',
};

export const DECISION_KEYS = ['pending', 'approved', 'denied', 'superseded'] as const;

export function decisionBadgeHtml(decision: string): string {
  const label = APPROVAL_DECISION_LABELS[decision] ?? decision;
  return `<span class="badge badge--decision-${esc(decision)}"><span class="badge__dot"></span>${esc(label)}</span>`;
}

// ---------- FR-A-1..4 列表逻辑 ----------

export interface ApprovalListRow {
  requestId: string;
  taskId: string;
  toolId: string;
  decision: string;
  requestedAt: string;
  timeoutAt: string;
  callRef: string;
  agentVersionId: string;
  contentHash: string;
  taskStatus: string;
  timeoutRemainingMs: number;
}

/** 待办视图：仅 pending + requestedAt 正序（等待最久置顶——超时风险优先；服务端 DESC，前端重排） */
export function pendingViewRows(rows: ReadonlyArray<ApprovalListRow>): ApprovalListRow[] {
  return rows
    .filter((r) => r.decision === 'pending')
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
}

/** 全部视图：保持服务端 requestedAt DESC（最新在前） */
export function allViewRows(rows: ReadonlyArray<ApprovalListRow>): ApprovalListRow[] {
  return [...rows];
}

// ---------- FR-A-3 / FR-AD-6 倒计时 ----------

export const COUNTDOWN_CRITICAL_MS = 5 * 60_000;

/** 剩余时间展示（approval.ts list 内联 timeoutRemainingMs 同口径：0 → 已超时——惰性判定下次读取落地） */
export function countdownLabel(remainingMs: number): string {
  if (remainingMs <= 0) return '已超时';
  if (remainingMs < 60_000) return '<1 分钟';
  return `${Math.ceil(remainingMs / 60_000)} 分钟内`;
}

export function isCountdownCritical(remainingMs: number): boolean {
  return remainingMs > 0 && remainingMs < COUNTDOWN_CRITICAL_MS;
}

/** 详情页按 request.timeoutAt 本地计算（FR-AD-6） */
export function detailCountdownMs(timeoutAt: string, now: number): number {
  const t = Date.parse(timeoutAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - now);
}

// ---------- 列表页 ----------

function countdownHtml(row: ApprovalListRow): string {
  if (row.decision !== 'pending') return '<span class="hint">—</span>';
  const cls = isCountdownCritical(row.timeoutRemainingMs) ? ' countdown countdown--critical' : ' countdown';
  return `<span class="${cls.trim()}">${esc(countdownLabel(row.timeoutRemainingMs))}</span>`;
}

export interface ApprovalsPageModel {
  mode: 'pending' | 'all';
  rows: ApprovalListRow[];
  page: number;
  pageCount: number;
  /** 全部视图下的前端本地 decision 过滤（null = 不过滤；FR-A-4） */
  decisionFilter: string | null;
  feedback: PageFeedback | null;
  now: number;
}

export function approvalsPageHtml(m: ApprovalsPageModel): string {
  const header = pageHeaderHtml({ view: 'approvals', title: '待办审批' });
  const tabs = `<div class="filter-bar">
    <button type="button" class="btn ${m.mode === 'pending' ? 'btn--primary' : 'btn--secondary'} btn--sm" data-action="view-pending">待办（pending=true）</button>
    <button type="button" class="btn ${m.mode === 'all' ? 'btn--primary' : 'btn--secondary'} btn--sm" data-action="view-all">全部决议</button>
    ${m.mode === 'all'
      ? `<label class="filter">决议<select data-filter="decision"><option value="">全部</option>${DECISION_KEYS.map((k) => `<option value="${k}"${m.decisionFilter === k ? ' selected' : ''}>${esc(APPROVAL_DECISION_LABELS[k])}</option>`).join('')}</select></label>`
      : ''}
    <span class="hint">待办视图按等待最久置顶（超时风险优先，前端重排）</span>
  </div>`;

  let body: string;
  if (m.rows.length === 0) {
    body = cardHtml({ title: '审批列表', body: emptyStateHtml({ title: m.mode === 'pending' ? '暂无待办审批' : '当前筛选无审批' }) });
  } else {
    const rowsHtml = m.rows.map((row) => `<tr>
      <td><a class="mono" href="#/approvals/${encodeURIComponent(row.requestId)}" title="${esc(row.requestId)}">${esc(shortId(row.requestId))}</a></td>
      <td><a class="mono" href="#/tasks/${encodeURIComponent(row.taskId)}" title="${esc(row.taskId)}">${esc(shortId(row.taskId))}</a>${statusBadgeHtml(row.taskStatus)}</td>
      <td class="mono">${esc(row.toolId)}</td>
      <td>${decisionBadgeHtml(row.decision)}</td>
      <td>${esc(formatTimestamp(row.requestedAt))}</td>
      <td>${countdownHtml(row)}</td>
    </tr>`).join('');
    body = cardHtml({
      title: `审批列表（第 ${m.page + 1} 页 / 共 ${m.pageCount} 页）`,
      body: tableHtml({
        columns: ['审批 ID', '任务', '工具', '决议', '请求时间', '超时倒计时'],
        rowsHtml,
      }),
      actionsHtml: pagerHtml(m.page, m.pageCount),
    });
  }
  return `${header}${feedbackHtml(m.feedback)}${tabs}${body}`;
}

// ---------- 详情页 ----------

export interface ApprovalDetail {
  request: {
    requestId: string;
    taskId: string;
    agentVersionId: string;
    toolId: string;
    riskLevel: string;
    requestedAt: string;
    decision: string;
    decidedAt: string | null;
    timeoutAt: string;
    callRef: string;
  };
  binding: { agentVersionId: string; contentHash: string; snapshotBytes: number } | null;
  snapshot: { savedAt: string; contextBytes: number } | null;
  argsDigest: string | null;
}

export interface ApprovalDetailModel {
  detail: ApprovalDetail;
  taskStatus: string | null;
  feedback: PageFeedback | null;
  now: number;
}

/** 决策来源展示（服务端无 decidedBy 列——如实展示决议与时间，不虚构来源） */
function decidedSectionHtml(req: ApprovalDetail['request']): string {
  if (req.decision === 'pending') return '<p class="hint">尚未决议</p>';
  return `<dl class="kv-grid">
    <div class="kv"><dt>决议</dt><dd>${decisionBadgeHtml(req.decision)}</dd></div>
    <div class="kv"><dt>决议时间</dt><dd>${esc(formatTimestamp(req.decidedAt))}</dd></div>
  </dl>`;
}

export function approvalDetailHtml(m: ApprovalDetailModel): string {
  const { request: req } = m.detail;
  const header = pageHeaderHtml({ view: 'approval-detail', title: `审批详情（${shortId(req.requestId)}）` });
  const hint = approveActionHint(req.decision, m.taskStatus ?? 'unknown');
  const taskBadge = m.taskStatus ? statusBadgeHtml(m.taskStatus) : '<span class="hint">—</span>';
  const countdownMs = detailCountdownMs(req.timeoutAt, m.now);
  const countdown = req.decision === 'pending'
    ? `<span class="${isCountdownCritical(countdownMs) ? 'countdown countdown--critical' : 'countdown'}">${esc(countdownLabel(countdownMs))}</span>`
    : '<span class="hint">—</span>';

  const head = cardHtml({
    title: '审批信息',
    body: `<dl class="kv-grid">
      <div class="kv"><dt>审批 ID</dt><dd class="mono">${esc(req.requestId)}</dd></div>
      <div class="kv"><dt>任务</dt><dd><a class="mono" href="#/tasks/${encodeURIComponent(req.taskId)}">${esc(shortId(req.taskId))}</a></dd></div>
      <div class="kv"><dt>任务状态</dt><dd>${taskBadge}</dd></div>
      <div class="kv"><dt>工具</dt><dd class="mono">${esc(req.toolId)}</dd></div>
      <div class="kv"><dt>风险档</dt><dd>${riskBadgeHtml(req.riskLevel)}</dd></div>
      <div class="kv"><dt>请求时间</dt><dd>${esc(formatTimestamp(req.requestedAt))}</dd></div>
      <div class="kv"><dt>超时倒计时</dt><dd>${countdown}</dd></div>
    </dl>
    <p class="hint hint--static">${esc(hint.hint)}</p>`,
  });

  const digest = cardHtml({
    title: '参数摘要',
    body: `<dl class="kv-grid">
      <div class="kv"><dt>参数摘要（argsDigest）</dt><dd class="mono">${esc(m.detail.argsDigest ?? '—')}</dd></div>
      <div class="kv"><dt>快照保存时间</dt><dd>${esc(formatTimestamp(m.detail.snapshot?.savedAt))}</dd></div>
      <div class="kv"><dt>快照字节量</dt><dd>${m.detail.snapshot ? formatThousands(m.detail.snapshot.contextBytes) : '—'}</dd></div>
      <div class="kv"><dt>版本内容哈希</dt><dd class="mono">${esc(m.detail.binding?.contentHash ?? '—')}</dd></div>
    </dl>
    <p class="hint">明文入参不离开服务端（PauseContext 不出库），前端不展示、不缓存。</p>`,
  });

  const decided = cardHtml({ title: '决议', body: decidedSectionHtml(req) });

  const cliGuide = req.decision === 'approved'
    ? `<pre class="code-block"><code>shanhai task run ${esc(req.taskId)} --resume --resumed-by manual-resume</code></pre>`
    : '';
  const actions = hint.decidable
    ? `<div class="detail-actions">
        <button type="button" class="btn btn--primary" data-action="approve">批准（approve）</button>
        <button type="button" class="btn btn--danger" data-action="deny">否决（deny，任务终局）</button>
      </div>`
    : '<p class="hint">当前状态不可决议</p>';
  const actionsCard = cardHtml({ title: '决议操作', body: `${actions}${cliGuide}` });

  return `${header}${feedbackHtml(m.feedback)}${head}${digest}${decided}${actionsCard}`;
}
