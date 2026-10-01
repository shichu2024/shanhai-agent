// 第七阶段批次二（7-2/4）：任务详情 HTML 构建（设计 V0.3 §5 FR-TD-1..7，字符串面纯函数）。
// 字段全部为 task_record 实测列（db.ts task_record）；V0.1 虚构字段（步进进度/approval_mode/
// 来源 issue/项目/恢复点摘要/is_zombie_running）一律不出现。

import { cardHtml, emptyStateHtml, esc, pageHeaderHtml, statusBadgeHtml } from './components.js';
import { formatThousands, formatTimestamp, shortId } from './format.js';
import { isRunningStale } from './taskFilters.js';
import { feedbackHtml, type PageFeedback } from './tasksView.js';

export interface TaskDetailRow {
  taskId: string;
  agentId: string;
  agentVersionId: string;
  input: string;
  status: string;
  attemptCount: number;
  modelCallCount: number;
  tokensUsed: number;
  createdAt: string;
  endedAt: string | null;
  cancelReason: string | null;
  parentTaskId: string | null;
}

export interface EventRow {
  eventId: string;
  eventType: string;
  timestamp: string;
  callNo?: number;
  callKind?: string | null;
  attemptNo?: number;
}

export interface EvidenceRefRow {
  ref: string;
  kind: string;
}

/**
 * FR-TD-5/FR-O-4 入口②（7-3 随批修复）：`GET /api/tasks/:id/evidence` 实测返回
 * TaskEvidenceChain（evidenceStore.taskEvidence：ok/taskId/envelope/status/trace.eventIds/
 * failures[].recordId/memories[].memoryId/delegationChain），无 refs 列表键——
 * 据实派生证据 ref 行：task:<taskId> + trace_event:<eventId> + failure:<recordId> + memory:<memoryId>。
 */
export function evidenceRowsOf(data: unknown): EvidenceRefRow[] {
  if (typeof data !== 'object' || data === null) return [];
  const chain = data as Record<string, unknown>;
  const rows: EvidenceRefRow[] = [];
  if (typeof chain.taskId === 'string' && chain.taskId.length > 0) rows.push({ ref: `task:${chain.taskId}`, kind: 'task' });
  const trace = typeof chain.trace === 'object' && chain.trace !== null && Array.isArray((chain.trace as { eventIds?: unknown }).eventIds)
    ? (chain.trace as { eventIds: unknown[] }).eventIds
    : [];
  for (const e of trace) {
    if (typeof e === 'string' && e.length > 0) rows.push({ ref: `trace_event:${e}`, kind: 'trace_event' });
  }
  for (const f of Array.isArray(chain.failures) ? chain.failures : []) {
    if (typeof f === 'object' && f !== null && typeof (f as { recordId?: unknown }).recordId === 'string') {
      rows.push({ ref: `failure:${(f as { recordId: string }).recordId}`, kind: 'failure' });
    }
  }
  for (const m of Array.isArray(chain.memories) ? chain.memories : []) {
    if (typeof m === 'object' && m !== null && typeof (m as { memoryId?: unknown }).memoryId === 'string') {
      rows.push({ ref: `memory:${(m as { memoryId: string }).memoryId}`, kind: 'memory' });
    }
  }
  return rows;
}

export interface ChildTaskRow {
  taskId: string;
  status: string;
}

// ---------- FR-TD-3 input 折叠 ----------

export const INPUT_COLLAPSE_LINES = 50;

export function collapseInput(input: string): { collapsed: boolean; head: string; full: string } {
  const lines = input.split('\n');
  if (lines.length <= INPUT_COLLAPSE_LINES) return { collapsed: false, head: input, full: input };
  return { collapsed: true, head: lines.slice(0, INPUT_COLLAPSE_LINES).join('\n'), full: input };
}

// ---------- FR-TD-4 事件流 ----------

/** 事件行按时间正序 + eventType 多选过滤（无 step 维度，不提供 step 过滤） */
export function eventRowsFor(events: ReadonlyArray<EventRow>, typeFilter: ReadonlySet<string>): EventRow[] {
  const filtered = events.filter((e) => typeFilter.size === 0 || typeFilter.has(e.eventType));
  return [...filtered].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

// ---------- 区块构建 ----------

function headCardHtml(task: TaskDetailRow): string {
  const ended = task.endedAt ? esc(formatTimestamp(task.endedAt)) : '—';
  const cancel = task.status === 'cancelled' && task.cancelReason
    ? `<div class="kv"><dt>取消原因</dt><dd>${esc(task.cancelReason)}</dd></div>`
    : '';
  return cardHtml({
    title: '任务信息',
    body: `<div class="detail-head">
      <div class="detail-head__id"><code class="mono">${esc(task.taskId)}</code><button type="button" class="btn btn--ghost btn--sm" data-action="copy-id" data-id="${esc(task.taskId)}">复制</button>${statusBadgeHtml(task.status)}</div>
      <dl class="kv-grid">
        <div class="kv"><dt>Agent</dt><dd>${esc(task.agentId)}</dd></div>
        <div class="kv"><dt>版本</dt><dd class="mono">${esc(task.agentVersionId)}</dd></div>
        <div class="kv"><dt>创建时间</dt><dd>${esc(formatTimestamp(task.createdAt))}</dd></div>
        <div class="kv"><dt>结束时间</dt><dd>${ended}</dd></div>
        <div class="kv"><dt>尝试次数</dt><dd>${task.attemptCount}</dd></div>
        <div class="kv"><dt>模型调用</dt><dd>${task.modelCallCount}</dd></div>
        <div class="kv"><dt>Token 用量</dt><dd>${formatThousands(task.tokensUsed)}</dd></div>
        ${cancel}
      </dl>
    </div>`,
  });
}

/** FR-TD-2 时间线：如实两时间点（无阶段节点，不虚构进度条） */
function timelineHtml(task: TaskDetailRow): string {
  const end = task.endedAt ? esc(formatTimestamp(task.endedAt)) : '进行中';
  return cardHtml({
    title: '时间线',
    body: `<ol class="timeline">
      <li class="timeline__item"><span class="timeline__dot" aria-hidden="true"></span><span class="timeline__label">创建</span><span class="timeline__time">${esc(formatTimestamp(task.createdAt))}</span></li>
      <li class="timeline__item"><span class="timeline__dot" aria-hidden="true"></span><span class="timeline__label">结束</span><span class="timeline__time">${end}</span></li>
    </ol>`,
  });
}

function inputHtml(task: TaskDetailRow): string {
  let pretty = task.input;
  try {
    pretty = JSON.stringify(JSON.parse(task.input), null, 2);
  } catch {
    /* 非 JSON 原文展示 */
  }
  const collapsed = collapseInput(pretty);
  const body = collapsed.collapsed
    ? `<pre class="code-block code-block--collapsed"><code>${esc(collapsed.head)}</code></pre><button type="button" class="btn btn--ghost btn--sm" data-action="expand-input">展开全部</button><pre class="code-block" hidden><code>${esc(collapsed.full)}</code></pre>`
    : `<pre class="code-block"><code>${esc(pretty)}</code></pre>`;
  return cardHtml({ title: '输入', body });
}

function eventsHtml(events: ReadonlyArray<EventRow>, excluded: ReadonlySet<string>): string {
  if (events.length === 0) {
    return cardHtml({ title: '事件流', body: emptyStateHtml({ title: '暂无事件' }) });
  }
  const types = [...new Set(events.map((e) => e.eventType))];
  const checks = types.map((t) => `<label class="check"><input type="checkbox" data-event-type="${esc(t)}"${excluded.has(t) ? '' : ' checked'} /> ${esc(t)}</label>`).join('');
  const rows = events.filter((e) => !excluded.has(e.eventType)).map((e) => `<tr>
    <td class="mono">${esc(shortId(e.eventId))}</td>
    <td>${esc(e.eventType)}</td>
    <td>${esc(formatTimestamp(e.timestamp))}</td>
    <td>${e.callKind ? `调用 ${e.callNo ?? '—'} · ${esc(e.callKind)}` : '—'}</td>
    <td>${e.attemptNo ?? '—'}</td>
  </tr>`).join('');
  return cardHtml({
    title: '事件流',
    body: `<div class="event-filter">${checks}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>事件</th><th>类型</th><th>时间</th><th>调用面</th><th>尝试</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  });
}

function evidenceHtml(evidence: ReadonlyArray<EvidenceRefRow>): string {
  if (evidence.length === 0) {
    return cardHtml({ title: '证据', body: emptyStateHtml({ title: '本任务未登记证据引用' }) });
  }
  const rows = evidence.map((e) => `<tr>
    <td><a class="mono" href="#/observe/evidence?ref=${encodeURIComponent(e.ref)}">${esc(e.ref)}</a></td>
    <td>${esc(e.kind)}</td>
  </tr>`).join('');
  return cardHtml({ title: '证据', body: `<div class="table-wrap"><table class="table"><thead><tr><th>引用</th><th>类型</th></tr></thead><tbody>${rows}</tbody></table></div>` });
}

function relatedHtml(task: TaskDetailRow, children: ReadonlyArray<ChildTaskRow>): string {
  const hasParent = task.parentTaskId !== null && task.parentTaskId.length > 0;
  if (!hasParent && children.length === 0) {
    return cardHtml({ title: '关联任务', body: emptyStateHtml({ title: '无关联任务' }) });
  }
  const parent = hasParent
    ? `<div class="kv"><dt>父任务</dt><dd><a class="mono" href="#/tasks/${encodeURIComponent(task.parentTaskId!)}">${esc(shortId(task.parentTaskId!))}</a></dd></div>`
    : '';
  const childRows = children.map((c) => `<tr>
    <td><a class="mono" href="#/tasks/${encodeURIComponent(c.taskId)}">${esc(shortId(c.taskId))}</a></td>
    <td>${statusBadgeHtml(c.status)}</td>
  </tr>`).join('');
  const childTable = children.length > 0
    ? `<div class="table-wrap"><table class="table"><caption>子任务（${children.length}，基于最近 100 条前端聚合）</caption><thead><tr><th>任务</th><th>状态</th></tr></thead><tbody>${childRows}</tbody></table></div>`
    : '';
  return cardHtml({ title: '关联任务', body: `<dl class="kv-grid">${parent}</dl>${childTable}` });
}

/** FR-TD-7 操作区：取消仅 queued/running/paused；续跑仅 paused；崩溃恢复仅滞留 running（全局端点） */
function actionsHtml(task: TaskDetailRow, stale: boolean, now: number): string {
  const cancel = ['queued', 'running', 'paused'].includes(task.status)
    ? `<button type="button" class="btn btn--secondary" data-action="cancel" data-task-id="${esc(task.taskId)}" data-task-status="${esc(task.status)}">取消</button>`
    : '';
  const resume = task.status === 'paused'
    ? `<button type="button" class="btn btn--primary" data-action="resume" data-task-id="${esc(task.taskId)}">续跑</button>`
    : '';
  const crash = stale || isRunningStale(task, now)
    ? `<button type="button" class="btn btn--danger" data-action="crash-recovery">显式崩溃恢复</button>`
    : '';
  const body = cancel || resume || crash
    ? `<div class="detail-actions">${cancel}${resume}${crash}</div>`
    : emptyStateHtml({ title: '当前状态无可用操作' });
  return cardHtml({ title: '操作', body });
}

export interface TaskDetailModel {
  task: TaskDetailRow;
  events: ReadonlyArray<EventRow>;
  evidence: ReadonlyArray<EvidenceRefRow>;
  children: ReadonlyArray<ChildTaskRow>;
  feedback: PageFeedback | null;
  /** eventType 多选过滤的排除集（空集 = 全部，FR-TD-4） */
  excludedEventTypes?: ReadonlySet<string>;
  now: number;
}

export function taskDetailHtml(m: TaskDetailModel): string {
  const title = `任务详情（${shortId(m.task.taskId)}）`;
  const header = pageHeaderHtml({ view: 'task-detail', title });
  const stale = isRunningStale(m.task, m.now);
  const staleNotice = stale ? '<p class="warning">该任务运行时间异常，可能是孤儿运行——出口为显式崩溃恢复（全局操作），不提供取消以防误杀仍在执行的进程。</p>' : '';
  return `${header}${feedbackHtml(m.feedback)}${headCardHtml(m.task)}${timelineHtml(m.task)}${staleNotice}${inputHtml(m.task)}${eventsHtml(m.events, m.excludedEventTypes ?? new Set())}${evidenceHtml(m.evidence)}${relatedHtml(m.task, m.children)}${actionsHtml(m.task, stale, m.now)}`;
}
