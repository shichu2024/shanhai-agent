import type http from 'node:http';
import type { Runtime } from '../runtime.js';
import type { TaskStatus } from '../types.js';
import { apiErrorPayload } from './errormap.js';

// 第六阶段批次一（§4.2）：核心读面 API handler——参数解析 → 调用 Runtime 只读函数 → JSON 响应。
// 纪律：门户层零正则二次处理（展示存储字节原样，§6-6）；A-37 读端点返回体与 CLI JSON 输出深度相等。

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function intQuery(query: URLSearchParams, key: string): number | undefined | 'invalid' {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 'invalid';
  return n;
}

const TASK_STATUSES = new Set(['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled']);

/** GET 读面路由（批次 6-1：tasks / approvals；6-2 扩全景）。返回 false = 未命中路由。 */
export function handleApiGet(rt: Runtime, pathname: string, query: URLSearchParams, res: http.ServerResponse): boolean {
  if (pathname === '/api/tasks') {
    const limit = intQuery(query, 'limit');
    const offset = intQuery(query, 'offset');
    if (limit === 'invalid' || offset === 'invalid') {
      sendJson(res, 400, { ok: false, code: 'bad_request', message: 'limit/offset 必须为非负整数' });
      return true;
    }
    const status = query.get('status');
    if (status !== null && !TASK_STATUSES.has(status)) {
      sendJson(res, 400, { ok: false, code: 'bad_request', message: `未知 status 过滤值：${status}` });
      return true;
    }
    sendJson(res, 200, rt.tasks.listTasks({
      ...(status !== null ? { status: status as TaskStatus } : {}),
      ...(query.get('agentId') !== null ? { agentId: query.get('agentId') ?? undefined } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    }));
    return true;
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (taskMatch) {
    sendJson(res, 200, rt.tasks.getTask(decodeURIComponent(taskMatch[1])));
    return true;
  }
  if (pathname === '/api/approvals') {
    const pending = query.get('pending');
    sendJson(res, 200, rt.approvals.list(pending === 'true' ? { pendingOnly: true } : {}));
    return true;
  }
  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(pathname);
  if (approvalMatch) {
    sendJson(res, 200, rt.approvals.show(decodeURIComponent(approvalMatch[1])));
    return true;
  }
  return false;
}

/** 统一 API 错误出口（errormap 映射；Manager 抛出的结构化错误在此转 HTTP） */
export function sendApiError(res: http.ServerResponse, err: unknown): void {
  const { status, body } = apiErrorPayload(err);
  sendJson(res, status, body);
}
