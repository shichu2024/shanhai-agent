import type http from 'node:http';
import type Database from 'better-sqlite3';
import type { Runtime } from '../runtime.js';
import type { TaskStatus } from '../types.js';
import { apiErrorPayload, apiErrorStatus } from './errormap.js';
import { CAPABILITY_KINDS, type CapabilityRow } from '../modules/capabilityRegistry.js';
import { buildCapabilityTrend } from '../modules/trend.js';
import { buildAgentInsight } from '../modules/insight.js';
import { buildAgentReport } from '../modules/report.js';
import { queryT1 } from '../evidence.js';

// 第六阶段批次一（§4.2）+ 批次二（读面全景）：API handler——参数解析 → 调用 Runtime 只读函数 → JSON 响应。
// 纪律：门户层零正则二次处理（展示存储字节原样，§6-6）；A-37 读端点返回体与 CLI JSON 输出深度相等。
// 零写入（D-48）：evolution 端点不执行 CLI 的惰性聚合（aggregateRepeatedFailures 是写路径）；
// capability/insight 的 derived 惰性重算为 §4.2 既有语义（与 CLI 同构、幂等——settle 后零写入）。

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
const CAPABILITY_STATUSES = new Set(['candidate', 'active', 'retired']);

/** capability 列表行投影——与 CLI `capability list` 输出形状逐键一致（A-37，cli.ts 同款投影） */
export function capabilityListRow(r: CapabilityRow): Record<string, unknown> {
  const evidenceRefs = JSON.parse(r.evidenceRefs) as unknown[];
  return {
    capabilityId: r.capabilityId,
    agentId: r.agentId,
    kind: r.kind,
    origin: r.origin,
    statement: r.statement,
    statementDigest: r.statementDigest,
    status: r.status,
    evidenceRefs,
    evidencePending: evidenceRefs.length === 0,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy,
  };
}

/** EvidenceStore 结果值错误（ok:false 值形态，非异常）→ HTTP：not_found→404 / not_implemented→501 */
function sendEvidenceResult(
  res: http.ServerResponse,
  result: { ok: false; code: string; ref: string; kind: string; message: string },
  status: (code: string) => number,
): void {
  sendJson(res, status(result.code), result);
}

/** GET 读面路由（批次 6-1：tasks / approvals；批次 6-2：events/evidence/capabilities/trend/insight/card/report/evolution）。返回 false = 未命中路由。 */
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

  // ---------- 批次 6-2：读面全景（§4.2） ----------

  const taskEventsMatch = /^\/api\/tasks\/([^/]+)\/events$/.exec(pathname);
  if (taskEventsMatch) {
    const taskId = decodeURIComponent(taskEventsMatch[1]);
    rt.tasks.getTask(taskId); // 不存在 → 抛「任务不存在」→ 404（与 /api/tasks/:id 同语义）
    sendJson(res, 200, rt.trace.readEvents(taskId)); // 时间线：事件原样
    return true;
  }

  const taskEvidenceMatch = /^\/api\/tasks\/([^/]+)\/evidence$/.exec(pathname);
  if (taskEvidenceMatch) {
    const result = rt.evidence.taskEvidence(decodeURIComponent(taskEvidenceMatch[1]));
    if (!result.ok) {
      sendEvidenceResult(res, result, apiErrorStatus);
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  const evidenceMatch = /^\/api\/evidence\/(.+)$/.exec(pathname);
  if (evidenceMatch) {
    // ref 语法非法时 show 内抛 EvidenceRefError(invalid_ref) → errormap → 400
    const result = rt.evidence.show(decodeURIComponent(evidenceMatch[1]));
    if (!result.ok) {
      sendEvidenceResult(res, result, apiErrorStatus);
      return true;
    }
    sendJson(res, 200, result); // payload 逐字节原样（§9-1：不二次脱敏）
    return true;
  }

  if (pathname === '/api/capabilities') {
    const kind = query.get('kind');
    if (kind !== null && !(CAPABILITY_KINDS as readonly string[]).includes(kind)) {
      sendJson(res, 400, { ok: false, code: 'bad_request', message: `未知 kind 过滤值（封闭枚举 ${CAPABILITY_KINDS.join('/')}）：${kind}` });
      return true;
    }
    const status = query.get('status');
    if (status !== null && !CAPABILITY_STATUSES.has(status)) {
      sendJson(res, 400, { ok: false, code: 'bad_request', message: `未知 status 过滤值（candidate/active/retired）：${status}` });
      return true;
    }
    const rows = rt.capabilities.list({
      ...(query.get('agent') !== null ? { agent: query.get('agent') ?? undefined } : {}),
      ...(kind !== null ? { kind } : {}),
      ...(status !== null ? { status } : {}),
    });
    sendJson(res, 200, rows.map(capabilityListRow));
    return true;
  }

  const agentMatch = /^\/api\/agents\/([^/]+)\/(card|trend|insight|report)$/.exec(pathname);
  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]);
    const db = (rt as unknown as { db: Database.Database }).db;
    if (agentMatch[2] === 'card') {
      sendJson(res, 200, rt.registry.agentCard(agentId, query.get('versionId') ?? undefined));
      return true;
    }
    if (agentMatch[2] === 'trend') {
      const bucket = query.get('bucket');
      // bucket 原样透传：非法值由 buildCapabilityTrend 抛 TrendError(invalid_bucket) → 400（不静默回退缺省）
      const trend = buildCapabilityTrend(db, rt.trace, agentId, {
        ...(query.get('since') !== null ? { since: query.get('since') ?? undefined } : {}),
        ...(query.get('until') !== null ? { until: query.get('until') ?? undefined } : {}),
        ...(bucket !== null ? { bucket: bucket as 'day' | 'week' } : {}),
      });
      sendJson(res, 200, trend);
      return true;
    }
    if (agentMatch[2] === 'insight') {
      const insight = buildAgentInsight(
        { db, trace: rt.trace, registry: rt.registry, capabilities: rt.capabilities },
        agentId,
        {
          ...(query.get('versionId') !== null ? { versionId: query.get('versionId') ?? undefined } : {}),
          ...(query.get('since') !== null ? { since: query.get('since') ?? undefined } : {}),
        },
      );
      sendJson(res, 200, insight);
      return true;
    }
    // report：与 CLI `agent report` 同款 T1 采样注入（健康面板 P95 实测）
    const report = buildAgentReport(db, agentId, {
      ...(query.get('since') !== null ? { since: query.get('since') ?? undefined } : {}),
      t1: (taskId) => queryT1(rt, taskId),
    });
    sendJson(res, 200, report);
    return true;
  }

  if (pathname === '/api/evolution') {
    // 零写入（D-48）：不执行 CLI 的惰性聚合（aggregateRepeatedFailures 是写路径）——
    // 未 settle 库上门户读返回既有清单；聚合责任在 CLI / 显式操作（语义成文于批次 6-2 交付）。
    sendJson(res, 200, rt.evolutions.list());
    return true;
  }

  const evolutionMatch = /^\/api\/evolution\/([^/]+)$/.exec(pathname);
  if (evolutionMatch) {
    const row = rt.evolutions.get(decodeURIComponent(evolutionMatch[1]));
    if (!row) {
      sendJson(res, 404, { ok: false, code: 'not_found', message: `演进候选不存在：${decodeURIComponent(evolutionMatch[1])}` });
      return true;
    }
    sendJson(res, 200, row);
    return true;
  }

  return false;
}

/** 统一 API 错误出口（errormap 映射；Manager 抛出的结构化错误在此转 HTTP） */
export function sendApiError(res: http.ServerResponse, err: unknown): void {
  const { status, body } = apiErrorPayload(err);
  sendJson(res, status, body);
}
