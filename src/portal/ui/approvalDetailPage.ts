// 第七阶段批次二（7-2/4）：玄武·审批详情控制器（设计 V0.3 §6 FR-AD-1..6 + §8 写接线）。
// GET /api/approvals/:id（request 全行 + binding + snapshot 元信息 + argsDigest）；
// 任务状态徽章：无跨页缓存时补一次既有 GET /api/tasks/:id（FR-AD-1 深链接口径，非新增端点）；
// FR-AD-5：提交前重查详情，decision≠pending → 「该审批已被处理」不 POST；
// approve/deny 点击即提交（FR-WR-1④，无确认弹窗）；超时倒计时按 request.timeoutAt 本地计算（FR-AD-6）。

import { apiGet, apiPost } from './client.js';
import { explainFailure } from './errors.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { approvalDetailHtml, type ApprovalDetail } from './approvalsView.js';
import type { PageFeedback } from './tasksView.js';
import { loadToken } from './token.js';
import { approveOp, createWriteGate, denyOp, runWrite } from './writeFlow.js';

export function mountApprovalDetailPage(ctx: PageCtx, requestId: string): PageHandle {
  let detail: ApprovalDetail | null = null;
  let taskStatus: string | null = null;
  let feedback: PageFeedback | null = null;
  let authFailed = false;
  const gate = createWriteGate();
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };

  function render(): void {
    if (!detail) {
      ctx.view.innerHTML = '<div class="loading-state" role="status">加载中……</div>';
      return;
    }
    ctx.view.innerHTML = approvalDetailHtml({ detail, taskStatus, feedback, now: ctx.now() });
  }

  async function refresh(): Promise<void> {
    if (authFailed) return;
    const res = await apiGet(`/api/approvals/${encodeURIComponent(requestId)}`, deps);
    if (!res.ok && res.kind === 'http' && res.status === 401) {
      authFailed = true;
      ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
      return;
    }
    if (!res.ok && res.kind === 'http' && res.status === 404) {
      ctx.view.innerHTML = `<div class="error-state" role="alert"><span class="error-state__code">not_found</span><p class="error-state__message">审批请求不存在：${requestId}</p><a class="btn btn--secondary" href="#/approvals">返回审批列表</a></div>`;
      return;
    }
    if (res.ok) {
      detail = res.data as ApprovalDetail;
      const taskId = detail.request.taskId;
      const taskRes = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}`, deps);
      if (taskRes.ok) {
        const status = (taskRes.data as { status?: unknown }).status;
        taskStatus = typeof status === 'string' ? status : null;
      }
      render();
    }
  }

  async function decide(action: 'approve' | 'deny'): Promise<void> {
    if (!gate.acquire()) return; // FR-WR-2
    try {
      const fresh = await apiGet(`/api/approvals/${encodeURIComponent(requestId)}`, deps);
      if (fresh.ok) {
        detail = fresh.data as ApprovalDetail;
        if (detail.request.decision !== 'pending') {
          feedback = { kind: 'error', text: '该审批已被处理' }; // FR-AD-5 乐观读拦截
          const taskId = detail.request.taskId;
          const taskRes = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}`, deps);
          if (taskRes.ok) {
            const status = (taskRes.data as { status?: unknown }).status;
            taskStatus = typeof status === 'string' ? status : null;
          }
          render();
          return;
        }
      }
      const op = action === 'approve' ? approveOp(requestId) : denyOp(requestId);
      const outcome = await runWrite(op, { confirmBox: ctx.confirmBox, post: (path, body) => apiPost(path, body, deps) });
      if (outcome.ok) {
        feedback = { kind: 'success', text: action === 'approve' ? '已批准（approve 只写决议，任务保持挂起）' : '已否决（deny 为任务级终局：cancelled/approval_denied）' };
      } else if (outcome.kind === 'network') {
        feedback = { kind: 'error', text: explainFailure({ ok: false, kind: 'network' }) };
      } else if (outcome.kind === 'failure') {
        feedback = { kind: 'error', text: `${explainFailure({ ok: false, kind: 'http', status: outcome.status, code: outcome.code, message: outcome.message })}（${outcome.code}：${outcome.message}）` };
      }
      await refresh(); // 决议后重拉详情 + 任务状态（本地倒计时/提示条随之更新）
    } finally {
      gate.release();
    }
  }

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    if (hit.dataset.action === 'approve') void decide('approve');
    else if (hit.dataset.action === 'deny') void decide('deny');
  }

  ctx.view.addEventListener('click', onClick);
  render();
  void refresh();

  return {
    destroy(): void {
      ctx.view.removeEventListener('click', onClick);
    },
  };
}
