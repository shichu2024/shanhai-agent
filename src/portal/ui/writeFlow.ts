// 第七阶段批次二（7-2/4）：写操作流（设计 V0.3 §8 FR-WR-1..4）。
// 确认分级文案逐字复用 src/portal/view/write.ts 四函数（FR-WR-6 不可变物①——
// 直接 import 同源复用，非抄写）；approve/deny/resume 不弹确认（FR-WR-1④ 点击即提交）；
// 乐观禁用门（FR-WR-2）：在途期间重复提交直接忽略。

import { cancelModeFor, confirmCrashRecoveryText, resumeNote } from '../view/write.js';
import type { ApiResult } from './client.js';

export interface WriteOp {
  kind: 'cancel' | 'resume' | 'crash-recovery' | 'approve' | 'deny';
  path: string;
  body?: Record<string, unknown>;
  /** undefined = 点击即提交（无确认门） */
  confirmText?: string;
}

export type WriteOutcome =
  | { ok: false; kind: 'cancelled-by-user' }
  | { ok: true; kind: 'success'; data: unknown }
  | { ok: false; kind: 'failure'; status: number; code: string; message: string }
  | { ok: false; kind: 'network' };

/** 取消（FR-WR-1①②：mode 与确认文案都取 cancelModeFor 分支） */
export function cancelOp(taskId: string, taskStatus: string): WriteOp {
  const mode = cancelModeFor(taskStatus);
  return {
    kind: 'cancel',
    path: `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
    body: { mode: mode.defaultMode },
    confirmText: mode.hint,
  };
}

/** 续跑（FR-WR-4：detached spawn，无确认门） */
export function resumeOp(taskId: string): WriteOp {
  return { kind: 'resume', path: `/api/tasks/${encodeURIComponent(taskId)}/resume`, body: {} };
}

/** 显式崩溃恢复（FR-WR-1③：全局端点无 :id，超危确认明示误杀面） */
export function crashRecoveryOp(runningCount: number): WriteOp {
  return { kind: 'crash-recovery', path: '/api/portal/crash-recovery', body: {}, confirmText: confirmCrashRecoveryText(runningCount) };
}

/** 批准（FR-WR-1④：approve 只写决议，无确认门） */
export function approveOp(requestId: string): WriteOp {
  return { kind: 'approve', path: `/api/approvals/${encodeURIComponent(requestId)}/approve`, body: {} };
}

/** 否决（FR-WR-1④：任务级终局，无确认门——后果由 approveActionHint 常驻提示如实告知） */
export function denyOp(requestId: string): WriteOp {
  return { kind: 'deny', path: `/api/approvals/${encodeURIComponent(requestId)}/deny`, body: {} };
}

export interface WriteFlowDeps {
  confirmBox: (text: string) => boolean;
  post: (path: string, body: Record<string, unknown>) => Promise<ApiResult>;
}

/** 执行一次写操作：确认门（有 confirmText 时）→ POST → 结果分类（post 抛异常归 network） */
export async function runWrite(op: WriteOp, deps: WriteFlowDeps): Promise<WriteOutcome> {
  if (op.confirmText !== undefined && !deps.confirmBox(op.confirmText)) {
    return { ok: false, kind: 'cancelled-by-user' };
  }
  let result: ApiResult;
  try {
    result = await deps.post(op.path, op.body ?? {});
  } catch {
    return { ok: false, kind: 'network' };
  }
  if (result.ok) return { ok: true, kind: 'success', data: result.data };
  if (result.kind === 'network') return { ok: false, kind: 'network' };
  return { ok: false, kind: 'failure', status: result.status, code: result.code, message: result.message };
}

/** FR-WR-2 乐观禁用门：在途期间 acquire() 恒 false（双击只发 1 个请求） */
export function createWriteGate(): { acquire(): boolean; release(): void } {
  let inFlight = false;
  return {
    acquire(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release(): void {
      inFlight = false;
    },
  };
}

/** FR-WR-4 resume 后续指引：resumeNote 原文（view/write.ts 同源）+ CLI 兜底命令 + resume-log 链接 */
export function resumeFeedback(result: { taskId: string; spawned: boolean; logFile: string }, taskId: string): { note: string; cli: string; logUrl: string } {
  return {
    note: resumeNote(result),
    cli: `shanhai task run ${taskId} --resume --resumed-by manual-resume`,
    logUrl: `/api/tasks/${encodeURIComponent(taskId)}/resume-log`,
  };
}
