// 第七阶段批次二（7-2/4）：任务详情页控制器（设计 V0.3 §5 FR-TD-1..7）。
// 三读面并发（task/events/evidence）+ 子任务经 GET /api/tasks?limit=100 前端按 parentTaskId 聚合
// （无子任务端点，如实口径）；轮询 3s 仅非终态（终态即停）；操作区接 §8 写流。

import { apiGet, apiPost } from './client.js';
import { AUTH_EXPIRED_TEXT, explainFailure } from './errors.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { ds } from './pageCtx.js';
import { createPoller } from './poll.js';
import { isRunningStale } from './taskFilters.js';
import { evidenceRowsOf, taskDetailHtml, type ChildTaskRow, type EventRow, type EvidenceRefRow, type TaskDetailRow } from './taskDetailView.js';
import type { PageFeedback } from './tasksView.js';
import { loadToken } from './token.js';
import { cancelOp, crashRecoveryOp, createWriteGate, resumeFeedback, resumeOp, runWrite } from './writeFlow.js';

const POLL_INTERVAL_MS = 3_000;
const CHILDREN_SCAN_LIMIT = 100;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function asObject(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

export function mountTaskDetailPage(ctx: PageCtx, taskId: string): PageHandle {
  let task: TaskDetailRow | null = null;
  let events: EventRow[] = [];
  let evidence: EvidenceRefRow[] = [];
  let children: ChildTaskRow[] = [];
  let feedback: PageFeedback | null = null;
  let authFailed = false;
  let excludedEventTypes = new Set<string>();
  let runningCount = 0;
  const gate = createWriteGate();
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  function render(): void {
    if (!task) {
      ctx.view.innerHTML = '<div class="loading-state" role="status">加载中……</div>';
      return;
    }
    ctx.view.innerHTML = taskDetailHtml({ task, events, evidence, children, feedback, excludedEventTypes, now: ctx.now() });
  }

  async function refresh(): Promise<void> {
    if (authFailed || (task !== null && TERMINAL_STATUSES.has(task.status))) return;
    const base = `/api/tasks/${encodeURIComponent(taskId)}`;
    const [taskRes, eventsRes, evidenceRes, childrenRes] = await Promise.all([
      apiGet(base, deps),
      apiGet(`${base}/events`, deps),
      apiGet(`${base}/evidence`, deps),
      apiGet(`/api/tasks?limit=${CHILDREN_SCAN_LIMIT}`, deps),
    ]);
    if (!taskRes.ok && taskRes.kind === 'http' && taskRes.status === 401) {
      authFailed = true;
      poller.stop();
      ctx.view.innerHTML = `<div class="error-state" role="alert"><p class="error-state__message">${AUTH_EXPIRED_TEXT}</p></div>`;
      return;
    }
    if (!taskRes.ok && taskRes.kind === 'http' && taskRes.status === 404) {
      poller.stop();
      ctx.view.innerHTML = `<div class="error-state" role="alert"><span class="error-state__code">not_found</span><p class="error-state__message">任务不存在：${taskId}</p><a class="btn btn--secondary" href="#/tasks">返回任务列表</a></div>`;
      return;
    }
    if (taskRes.ok) task = asObject(taskRes.data) as unknown as TaskDetailRow;
    if (eventsRes.ok) events = Array.isArray(eventsRes.data) ? (eventsRes.data as EventRow[]) : [];
    if (evidenceRes.ok) {
      evidence = evidenceRowsOf(evidenceRes.data); // TaskEvidenceChain 实测形状派生（7-3 随批修复）
    }
    if (childrenRes.ok) {
      const tasks = Array.isArray((childrenRes.data as { tasks?: unknown }).tasks)
        ? ((childrenRes.data as { tasks: unknown[] }).tasks as Record<string, unknown>[])
        : [];
      runningCount = tasks.filter((r) => r.status === 'running').length; // 崩溃恢复确认文案的全局 Running 数
      children = tasks
        .filter((r) => r.parentTaskId === taskId)
        .map((r) => ({ taskId: String(r.taskId), status: String(r.status) }));
    }
    render();
    if (task !== null && TERMINAL_STATUSES.has(task.status)) poller.stop(); // 终态即停
  }

  const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });

  async function refreshResumeLog(): Promise<void> {
    if (!feedback?.resume) return;
    const res = await apiGet(feedback.resume.logUrl, deps);
    const text = res.ok
      ? String((res.data as { content?: unknown }).content ?? '').slice(0, 4000)
      : `续跑日志读取失败：${res.ok ? '' : explainFailure(res)}`;
    feedback = { ...feedback, resume: { ...feedback.resume, logText: text } };
    render();
  }

  async function handleWrite(kind: string, dataset: Record<string, string>): Promise<void> {
    if (!gate.acquire()) return;
    try {
      let op;
      if (kind === 'cancel') op = cancelOp(ds(dataset, 'task-id') || taskId, ds(dataset, 'task-status') || task?.status || '');
      else if (kind === 'resume') op = resumeOp(ds(dataset, 'task-id') || taskId);
      else if (kind === 'crash-recovery') op = crashRecoveryOp(runningCount);
      else return;
      const outcome = await runWrite(op, { confirmBox: ctx.confirmBox, post: (path, body) => apiPost(path, body, deps) });
      if (outcome.kind === 'cancelled-by-user') return;
      if (outcome.ok) {
        const data = outcome.data as { taskId?: string; spawned?: boolean; logFile?: string; mode?: string };
        if (kind === 'resume' && typeof data.taskId === 'string') {
          const rf = resumeFeedback({ taskId: data.taskId, spawned: data.spawned === true, logFile: data.logFile ?? '' }, data.taskId);
          feedback = { kind: 'success', text: '续跑请求已受理', resume: { ...rf, taskId: data.taskId } };
        } else if (kind === 'crash-recovery') {
          feedback = { kind: 'success', text: '崩溃恢复已执行（Running→Failed(CrashRecovery)、孤儿快照清理、pending 审批作废、trace 对账）' };
        } else {
          feedback = { kind: 'success', text: `取消成功（mode=${data.mode ?? '—'}）` };
        }
      } else if (outcome.kind === 'network') {
        feedback = { kind: 'error', text: explainFailure({ ok: false, kind: 'network' }) };
      } else {
        feedback = { kind: 'error', text: explainFailure({ ok: false, kind: 'http', status: outcome.status, code: outcome.code, message: outcome.message }) };
      }
      render();
      await refresh();
    } finally {
      gate.release();
    }
  }

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    const action = hit.dataset.action;
    if (action === 'copy-id') {
      const id = hit.dataset.id ?? '';
      void navigator.clipboard?.writeText?.(id).catch(() => undefined); // 复制失败不阻塞（等宽区可选中文本兜底）
      return;
    }
    if (action === 'view-resume-log') { void refreshResumeLog(); return; }
    if (action === 'expand-input') {
      const hidden = ctx.view.querySelector('.code-block:not(.code-block--collapsed)');
      if (hidden) hidden.removeAttribute('hidden');
      const collapsed = ctx.view.querySelector('.code-block--collapsed');
      if (collapsed) collapsed.setAttribute('hidden', '');
      const btn = ev.target as HTMLElement;
      if (typeof btn.setAttribute === 'function') btn.setAttribute('hidden', '');
      return;
    }
    if (action === 'cancel' || action === 'resume' || action === 'crash-recovery') {
      void handleWrite(action, hit.dataset);
    }
  }

  function onChange(ev: Event): void {
    const target = ev.target as { dataset?: Record<string, string>; checked?: boolean } | null;
    const type = target?.dataset ? ds(target.dataset, 'event-type') : '';
    if (!type) return;
    const next = new Set(excludedEventTypes);
    if (target?.checked === false) next.add(type);
    else next.delete(type);
    excludedEventTypes = next;
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
  render();
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
