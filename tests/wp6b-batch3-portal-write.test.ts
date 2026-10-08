import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, registerL3Tool, approvalSpec } from './helpers.js';
import { startPortalServer, stopPortalServer, bootPortal, type PortalHandle } from '../src/portal/server.js';
import { ResumeService, isTaskIdSafe, defaultCliEntry } from '../src/portal/resume.js';
import { confirmCrashRecoveryText, cancelModeFor, approveActionHint, resumeNote } from '../src/portal/view/write.js';

// WP-6B 批次三（6-3/4）：写面。
// DoD 断言：A-33（写端点库内状态+事件与 CLI 等价操作逐事件一致——判定基准=§4.3 旗标映射表）
//           A-34（并发 approve 恰一方成功，另一方 already_decided→409）
//           A-35 逃生侧（Running 僵尸行 → 显式崩溃恢复 → Failed(CrashRecovery)，事件序列与 CLI recover 等价）
//           A-36（approve 后仍 paused；resume 以 nextCallRef 锚点放行；重复 resume CAS 失败无脏状态）
//           P1-2-②（POST 强制 application/json → 415）于真实写端点复断言；P2-3（resume-log taskId 白名单）。
// 稳定性注（TASK-136，对齐 TASK-119 第五批口径）：本文件真实 server 往返用例（经 startTestServer
//           的 HTTP 用例）统一显式 timeout=20s——防高负载下 vitest 缺省 5s 超时红（trend 族同机理
//           余量不足）；Manager 直调/文件系统/纯函数用例不加。

const TOKEN = { Authorization: 'Bearer test-token-0000000000000000000000000000', 'Content-Type': 'application/json' };

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function forceStatus(rt: Runtime, taskId: string, status: string): void {
  dbOf(rt).prepare('UPDATE task_record SET status = ? WHERE taskId = ?').run(status, taskId);
}

interface TestResponse {
  status: number;
  body: string;
}

function request(port: number, method: string, pathName: string, headers: Record<string, string> = {}, body = ''): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function post(port: number, pathName: string, body = '{}', headers: Record<string, string> = TOKEN): Promise<TestResponse> {
  return request(port, 'POST', pathName, headers, body);
}

const servers: PortalHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await stopPortalServer(s);
});

async function startTestServer(rt: Runtime, extra: { operatorId?: string; resume?: ResumeService } = {}): Promise<PortalHandle> {
  const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
  const handle = await startPortalServer(rt, {
    dataDir: dir,
    repoRoot: process.cwd(),
    host: '127.0.0.1',
    port: 0,
    token: 'test-token-0000000000000000000000000000',
    ...extra,
  });
  servers.push(handle);
  return handle;
}

/** 供脚本续跑的模型响应（resume 后：L3 工具放行 → 终局文本） */
const RESUME_SCRIPT = [
  { kind: 'text', text: JSON.stringify({ summary: '续跑完成', filesCovered: 1, verdict: 'ok' }) },
] as const;

const seededAgents = new WeakMap<ReturnType<typeof makeHarness>, Set<string>>();

/** 驱动到 Paused（L3 审批挂起）：runTask 返回 Paused 行 + pending 请求（同 harness 同 agent 只登记一次） */
async function driveToPaused(h: ReturnType<typeof makeHarness>, agentId: string) {
  let seeded = seededAgents.get(h);
  if (!seeded) {
    seeded = new Set();
    seededAgents.set(h, seeded);
  }
  if (!seeded.has(agentId)) {
    seeded.add(agentId);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec(agentId));
  }
  h.provider.script.push({ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'prod-db' } }] });
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(taskId);
  expect(row.status).toBe('paused');
  const req = h.rt.approvals.pendingForTask(taskId)!;
  expect(req).not.toBeNull();
  return { taskId, request: req };
}

// ---------- A-33 事件归一化对账（判定基准=§4.3：门户操作 ≡ CLI 等价 Manager 调用） ----------

const VOLATILE_VALUE_KEYS = new Set(['eventId', 'timestamp', 'traceId', 'taskId', 'requestId', 'failureRecordId', 'decidedAt', 'endedAt', 'savedAt']);
const VOLATILE_DROP_KEYS = new Set(['elapsedMs', 'queueDepth', 'pausedDurationMs', 'latencyMs', 'durationMs', 'spawnMs']);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:/.test(value)) return '<ts>'; // RFC3339 时点字段（requestedAt/timeoutAt 等）
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_DROP_KEYS.has(k)) continue;
      out[k] = VOLATILE_VALUE_KEYS.has(k) ? '<volatile>' : normalize(v);
    }
    return out;
  }
  return value;
}

/** 逐事件一致断言（A-33）：事件序列 + 归一化载荷深度相等（身份/时点字段归一，语义字段全比） */
function expectEventEquivalence(portalEvents: Record<string, unknown>[], cliEvents: Record<string, unknown>[]): void {
  expect(portalEvents.map((e) => e.eventType)).toEqual(cliEvents.map((e) => e.eventType));
  expect(normalize(portalEvents)).toEqual(normalize(cliEvents));
}

// ---------- A-33：approve（≡ approval approve <id> --detach） ----------

describe('WP6B3-1 POST /api/approvals/:id/approve（A-33/A-36：只写 decision，任务保持 Paused）', () => {
  it('门户 approve 与 CLI 等价操作逐事件一致；响应 {taskId, decision, taskStatus:paused}', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-a');
    const b = await driveToPaused(h, 'wr-a');
    const handle = await startTestServer(h.rt);

    const res = await post(handle.port, `/api/approvals/${a.request.requestId}/approve`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, requestId: a.request.requestId, taskId: a.taskId, decision: 'approved', taskStatus: 'paused' });

    h.rt.approvals.approve(b.request.requestId, 'portal'); // CLI 等价（--by portal）

    expect(h.rt.tasks.getTask(a.taskId).status).toBe('paused'); // A-36：approve 后仍 Paused
    expect(h.rt.tasks.getTask(b.taskId).status).toBe('paused');
    expect(h.rt.approvals.getRequest(a.request.requestId)!.decision).toBe('approved');
    expectEventEquivalence(h.rt.trace.readEvents(a.taskId), h.rt.trace.readEvents(b.taskId));
  });

  it('decidedBy=who 来源标记（缺省 portal / operatorId 覆盖）；未知 requestId → 404', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-who');
    const handle = await startTestServer(h.rt, { operatorId: 'ops-tony' });
    await post(handle.port, `/api/approvals/${a.request.requestId}/approve`);
    const decided = h.rt.trace
      .readEvents(a.taskId)
      .find((e) => e.eventType === 'approval_decided') as unknown as { decidedBy: string };
    expect(decided.decidedBy).toBe('ops-tony');

    const missing = await post(handle.port, '/api/approvals/no-such-req/approve');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('not_found');
  });
});

// ---------- A-33：deny（≡ approval deny <id> [--reason <t>]） ----------

describe('WP6B3-2 POST /api/approvals/:id/deny（A-33：任务终态 cancelled(approval_denied)）', () => {
  it('带 reason 门户 deny 与 CLI 等价操作逐事件一致；快照删除', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-d');
    const b = await driveToPaused(h, 'wr-d');
    const handle = await startTestServer(h.rt);

    const res = await post(handle.port, `/api/approvals/${a.request.requestId}/deny`, JSON.stringify({ reason: '风险过高' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true, taskId: a.taskId, decision: 'denied', taskStatus: 'cancelled', cancelReason: 'approval_denied',
    });

    h.rt.approvals.deny(b.request.requestId, 'portal', '风险过高'); // CLI 等价

    for (const t of [a.taskId, b.taskId]) {
      const row = h.rt.tasks.getTask(t);
      expect(row.status).toBe('cancelled');
      expect(row.cancelReason).toBe('approval_denied');
      expect(dbOf(h.rt).prepare('SELECT * FROM pause_snapshot WHERE taskId = ?').get(t)).toBeUndefined();
    }
    expectEventEquivalence(h.rt.trace.readEvents(a.taskId), h.rt.trace.readEvents(b.taskId));
  });
});

// ---------- A-34：并发 approve CAS 透传 ----------

describe('WP6B3-3 A-34 并发 approve：恰一方成功，另一方 already_decided→409', () => {
  it('门户 vs 门户（并发两请求）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-cas');
    const handle = await startTestServer(h.rt);
    const url = `/api/approvals/${a.request.requestId}/approve`;
    const [r1, r2] = await Promise.all([post(handle.port, url), post(handle.port, url)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(JSON.parse(loser.body).code).toBe('already_decided');
    expect(h.rt.approvals.getRequest(a.request.requestId)!.decision).toBe('approved');
  });

  it('门户 vs 模拟 CLI 直写（Manager 先落库，门户后到 → 409）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-cas2');
    h.rt.approvals.approve(a.request.requestId, 'cli');
    const handle = await startTestServer(h.rt);
    const res = await post(handle.port, `/api/approvals/${a.request.requestId}/approve`);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('already_decided');
    expect(h.rt.tasks.getTask(a.taskId).status).toBe('paused'); // 无脏状态
  });
});

// ---------- A-33/D-47：cancel（graceful≡task cancel；force≡--force；running+graceful 前置 409） ----------

describe('WP6B3-4 POST /api/tasks/:id/cancel（A-33 + P3-1 前置校验）', () => {
  it('queued + graceful：与 CLI 等价操作逐事件一致', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wr-q' }));
    const a = h.rt.tasks.createTask('wr-q', validInput, 't');
    const b = h.rt.tasks.createTask('wr-q', validInput, 't');
    const handle = await startTestServer(h.rt);

    const res = await post(handle.port, `/api/tasks/${a}/cancel`, JSON.stringify({ mode: 'graceful' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, taskId: a, mode: 'graceful' });
    h.rt.tasks.cancel(b, 'portal'); // CLI 等价
    expect(h.rt.tasks.getTask(a).status).toBe('cancelled');
    expectEventEquivalence(h.rt.trace.readEvents(a), h.rt.trace.readEvents(b));
  });

  it('paused + graceful：立即取消 + pending superseded + 快照删除（与 CLI 等价一致）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-p');
    const b = await driveToPaused(h, 'wr-p');
    const handle = await startTestServer(h.rt);

    const res = await post(handle.port, `/api/tasks/${a.taskId}/cancel`, JSON.stringify({ mode: 'graceful' }));
    expect(res.status).toBe(200);
    h.rt.tasks.cancel(b.taskId, 'portal'); // CLI 等价
    for (const t of [a.taskId, b.taskId]) {
      expect(h.rt.tasks.getTask(t).status).toBe('cancelled');
      expect(h.rt.approvals.getRequest((t === a.taskId ? a : b).request.requestId)!.decision).toBe('superseded');
      expect(dbOf(h.rt).prepare('SELECT * FROM pause_snapshot WHERE taskId = ?').get(t)).toBeUndefined();
    }
    expectEventEquivalence(h.rt.trace.readEvents(a.taskId), h.rt.trace.readEvents(b.taskId));
  });

  it('running + graceful：服务端前置校验 409，不进 Manager（无状态变化、无 task_cancelled 事件）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wr-r' }));
    const t = h.rt.tasks.createTask('wr-r', validInput, 't');
    forceStatus(h.rt, t, 'running'); // 构造无人执行的 Running 行（僵尸形态）
    const eventsBefore = h.rt.trace.readEvents(t).length;
    const handle = await startTestServer(h.rt);

    const res = await post(handle.port, `/api/tasks/${t}/cancel`, JSON.stringify({ mode: 'graceful' }));
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.message).toContain('独立进程');
    expect(h.rt.tasks.getTask(t).status).toBe('running'); // 未触碰
    expect(h.rt.trace.readEvents(t).length).toBe(eventsBefore); // 零事件（前置校验不进 Manager）
  });

  it('running + force：abortRequested=1（≡ task cancel --force 跨进程路径）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wr-f' }));
    const a = h.rt.tasks.createTask('wr-f', validInput, 't');
    const b = h.rt.tasks.createTask('wr-f', validInput, 't');
    forceStatus(h.rt, a, 'running');
    forceStatus(h.rt, b, 'running');
    const handle = await startTestServer(h.rt);

    const res = await post(handle.port, `/api/tasks/${a}/cancel`, JSON.stringify({ mode: 'force' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, taskId: a, mode: 'abort' });
    h.rt.tasks.cancel(b, 'portal', { force: true }); // CLI 等价（--force）
    for (const t of [a, b]) {
      const flag = dbOf(h.rt).prepare('SELECT abortRequested FROM task_record WHERE taskId = ?').get(t) as { abortRequested: number };
      expect(flag.abortRequested).toBe(1);
      expect(h.rt.tasks.getTask(t).status).toBe('running'); // 僵尸行不在本进程执行：登记后等待执行进程
    }
    expectEventEquivalence(h.rt.trace.readEvents(a), h.rt.trace.readEvents(b));
  });

  it('body 校验：缺 mode / 非法 mode → 400；未知任务 → 404；text/plain → 415', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wr-b' }));
    const t = h.rt.tasks.createTask('wr-b', validInput, 't');
    const handle = await startTestServer(h.rt);

    expect((await post(handle.port, `/api/tasks/${t}/cancel`, '{}')).status).toBe(400);
    expect((await post(handle.port, `/api/tasks/${t}/cancel`, JSON.stringify({ mode: 'nonsense' }))).status).toBe(400);
    expect((await post(handle.port, '/api/tasks/no-such/cancel', JSON.stringify({ mode: 'graceful' }))).status).toBe(404);
    const plain = await request(handle.port, 'POST', `/api/tasks/${t}/cancel`, {
      Authorization: TOKEN.Authorization, 'Content-Type': 'text/plain',
    }, JSON.stringify({ mode: 'graceful' }));
    expect(plain.status).toBe(415);
    expect(h.rt.tasks.getTask(t).status).toBe('queued'); // 全程零副作用
  });
});

// ---------- D-46：resume + resume-log ----------

describe('WP6B3-5 POST /api/tasks/:id/resume + GET resume-log（D-46/P2-3）', () => {
  it('HTTP 立即返回 {spawned:true, logFile}；未知任务 → 404；resume-log 经端点可读', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-rs');
    const resume = new ResumeService({ dataDir: mkdtempSync(path.join(tmpdir(), 'shanhai-rs-')), repoRoot: process.cwd(), cliEntry: path.resolve('tests/fixtures/resumeChild.mjs') });
    const handle = await startTestServer(h.rt, { resume });

    const res = await post(handle.port, `/api/tasks/${a.taskId}/resume`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, taskId: a.taskId, spawned: true, resumedBy: 'manual-resume' });
    expect(typeof JSON.parse(res.body).logFile).toBe('string');
    expect(h.rt.tasks.getTask(a.taskId).status).toBe('paused'); // spawn 不阻塞、不迁移（子进程持有迁移权）

    await new Promise((r) => setTimeout(r, 1500)); // 子进程落日志
    const log = await request(handle.port, 'GET', `/api/tasks/${a.taskId}/resume-log`, { Authorization: TOKEN.Authorization });
    expect(log.status).toBe(200);
    const logBody = JSON.parse(log.body);
    expect(logBody.ok).toBe(true);
    expect(logBody.content).toContain('--resume');
    expect(logBody.content).toContain('manual-resume');

    const missing = await post(handle.port, '/api/tasks/no-such-task/resume');
    expect(missing.status).toBe(404);
  });

  it('resume-log 端点：taskId 非法字符 → 400；无记录 → 404；内存索引与文件系统回落一致', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const handle = await startTestServer(h.rt);
    const bad = await request(handle.port, 'GET', '/api/tasks/..%2Fescape/resume-log', { Authorization: TOKEN.Authorization });
    expect(bad.status).toBe(400);
    const none = await request(handle.port, 'GET', '/api/tasks/t-clean/resume-log', { Authorization: TOKEN.Authorization });
    expect(none.status).toBe(404);
  });

  it('ResumeService：内存索引与文件系统回落一致（P2-3/P3-3）', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-resume-'));
    const svc = new ResumeService({ dataDir, repoRoot: process.cwd(), cliEntry: path.resolve('tests/fixtures/resumeChild.mjs') });
    const spawned = svc.spawnResume('t-abc123', 'portal');
    expect(isTaskIdSafe('t-abc123')).toBe(true);
    expect(spawned.logFile).toContain(path.join(dataDir, 'portal', 'logs'));
    expect(path.basename(spawned.logFile)).toMatch(/^resume-t-abc123-\d+\.log$/);
    await new Promise((r) => setTimeout(r, 1500)); // 子进程落日志
    const mem = svc.readLog('t-abc123');
    expect(mem).not.toBeNull();
    expect(mem!.content).toContain('task');
    expect(mem!.content).toContain('--resume');
    expect(mem!.content).toContain('manual-resume'); // resumedBy 语义标注
    expect(mem!.content).toContain('cwd=');
    expect(mem!.content).toContain('stderr-probe'); // stderr 同文件重定向

    // 门户重启形态：全新实例（内存 map 空）→ 文件系统 mtime 回落（P2-3/P3-3）
    const svc2 = new ResumeService({ dataDir, repoRoot: process.cwd() });
    const fb = svc2.readLog('t-abc123');
    expect(fb).not.toBeNull();
    expect(fb!.logFile).toBe(mem!.logFile);
    expect(fb!.content).toContain('manual-resume');
  });

  it('isTaskIdSafe 白名单 + mtime 取最新 + 目录前缀断言', async () => {
    expect(isTaskIdSafe('a')).toBe(true);
    expect(isTaskIdSafe('t-1.2_3')).toBe(true);
    expect(isTaskIdSafe('../etc')).toBe(false);
    expect(isTaskIdSafe('a/b')).toBe(false);
    expect(isTaskIdSafe('..')).toBe(false);
    expect(isTaskIdSafe('')).toBe(false);
    expect(isTaskIdSafe('x'.repeat(200))).toBe(false);
    expect(typeof defaultCliEntry()).toBe('string');
    expect(path.isAbsolute(defaultCliEntry())).toBe(true);

    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-resume2-'));
    const svc = new ResumeService({ dataDir, repoRoot: process.cwd() });
    expect(() => svc.readLog('../escape')).toThrow();
    expect(svc.readLog('t-none')).toBeNull(); // 无日志 → null（端点转 404）
    // mtime 最新：手工放两份日志，后写的胜出
    const dir = path.join(dataDir, 'portal', 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'resume-t-m-111.log'), 'older', { flag: 'w' });
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(dir, 'resume-t-m-222.log'), 'newer', { flag: 'w' });
    expect(svc.readLog('t-m')!.content).toBe('newer');
    // 相邻前缀任务不串日志（resume-t-m-xxx 不属于 t-m-2）
    writeFileSync(path.join(dir, 'resume-t-m-2-9.log'), 'other-task', { flag: 'w' });
    expect(svc.readLog('t-m')!.content).toBe('newer');
    expect(svc.readLog('t-m-2')!.content).toBe('other-task');
  });
});

// ---------- A-36：resume 语义（锚点放行 + 重复 resume CAS） ----------

describe('WP6B3-6 A-36 resume 语义（复用既有 resume 断言路径）', () => {
  it('门户 approve 后 in-process resume（≡ 子进程同款调用）：nextCallRef 锚点放行至终态 + task_resumed(manual-resume)', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-anchor');
    h.provider.script.push(RESUME_SCRIPT[0]); // resume 后首响应：终局文本（脚本序 = tool_use → text）
    const handle = await startTestServer(h.rt);
    await post(handle.port, `/api/approvals/${a.request.requestId}/approve`);

    const final = await h.rt.tasks.runTask(a.taskId, null, { resume: true, resumedBy: 'manual-resume' });
    expect(final.status).toBe('succeeded');
    const resumed = h.rt.trace.readEvents(a.taskId).find((e) => e.eventType === 'task_resumed') as unknown as { resumedBy: string; requestId: string };
    expect(resumed.resumedBy).toBe('manual-resume');
    expect(resumed.requestId).toBe(a.request.requestId); // 放行锚点 = 当前挂起点（callRef=snapshot.nextCallRef 对应的请求）
  });

  it('重复 resume：任务已被取走（Running）时第二调用 CAS 失败退出，不产生脏状态', async () => {
    const h = makeHarness();
    const a = await driveToPaused(h, 'wr-dup');
    await h.rt.approvals.approve(a.request.requestId, 'portal');
    forceStatus(h.rt, a.taskId, 'running'); // 模拟第一 resume 子进程已 CAS 取出
    const before = h.rt.trace.readEvents(a.taskId).length;
    await expect(h.rt.tasks.runTask(a.taskId, null, { resume: true, resumedBy: 'manual-resume' })).rejects.toThrow('resume');
    expect(h.rt.tasks.getTask(a.taskId).status).toBe('running'); // 状态未被覆写
    expect(h.rt.trace.readEvents(a.taskId).length).toBe(before); // 零新事件（无脏状态）
  });
});

// ---------- A-35 逃生侧：POST /api/portal/crash-recovery ----------

describe('WP6B3-7 A-35 显式崩溃恢复（P1-1 逃生侧：≡ rt.startup() 全段 recover）', () => {
  it('Running 僵尸行 → 门户崩溃恢复 → Failed(CrashRecovery)，事件序列与 CLI recover 等价；pending superseded + 快照清理 + 索引对账', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    // 僵尸 A：走门户显式恢复；僵尸 B：走 CLI 等价（rt.startup('cli')）
    const zA = await driveToPaused(h, 'wr-z');
    const zB = await driveToPaused(h, 'wr-z');
    forceStatus(h.rt, zA.taskId, 'running');
    forceStatus(h.rt, zB.taskId, 'running');
    // 索引漂移：删 A/B 各一行 trace_index（recover ①段对账重建）
    for (const z of [zA.taskId, zB.taskId]) {
      dbOf(h.rt).prepare('DELETE FROM trace_index WHERE rowid = (SELECT MIN(rowid) FROM trace_index WHERE taskId = ?)').run(z);
    }
    const boot = bootPortal(h.rt); // D-42：Running>0 → 跳过 startup（僵尸不被误杀）
    expect(boot.skippedStartup).toBe(true);
    const handle = await startTestServer(h.rt);

    const res = await post(handle.port, '/api/portal/crash-recovery');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.report.crashMarkedTasks).toContain(zA.taskId);
    expect(body.report.reconciledTasks).toContain(zA.taskId);

    h.rt.startup('cli'); // CLI 等价（下一命令触发的 startup recover 全段，对 B 执行）

    for (const z of [zA.taskId, zB.taskId]) {
      const row = h.rt.tasks.getTask(z);
      expect(row.status).toBe('failed');
      expect(row.terminalFailureClass).toBe('Runtime(CrashRecovery)');
      expect(h.rt.approvals.getRequest((z === zA.taskId ? zA : zB).request.requestId)!.decision).toBe('superseded');
      expect(dbOf(h.rt).prepare('SELECT * FROM pause_snapshot WHERE taskId = ?').get(z)).toBeUndefined();
      const types = h.rt.trace.readEvents(z).map((e) => e.eventType);
      expect(types).toContain('crash_recovery_marked');
      expect(types).toContain('task_failed');
    }
    expectEventEquivalence(h.rt.trace.readEvents(zA.taskId), h.rt.trace.readEvents(zB.taskId));
  });

  it('boot 安全侧回归（Running>0 不误杀）+ Running=0 时恢复行为完整保留', async () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wr-boot' }));
    const t = h.rt.tasks.createTask('wr-boot', validInput, 't');
    forceStatus(h.rt, t, 'running');
    const b1 = bootPortal(h.rt);
    expect(b1.skippedStartup).toBe(true);
    expect(h.rt.tasks.getTask(t).status).toBe('running'); // 未被标 CrashRecovery
    forceStatus(h.rt, t, 'queued'); // 清场：Running=0
    const b2 = bootPortal(h.rt);
    expect(b2.skippedStartup).toBe(false); // startup 正常执行（recover 完整保留）
  });
});

// ---------- ResumeService：真实子进程 detached spawn（Windows 一等公民，假设 8） ----------

describe('WP6B3-8 ResumeService detached spawn（假设 8：node 直启 + 日志落盘 + 存活登记）', () => {
  it('spawn 后进程独立于父进程（detached/unref），日志目录按 taskId 隔离', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-rs3-'));
    const svc = new ResumeService({ dataDir, repoRoot: process.cwd(), cliEntry: path.resolve('tests/fixtures/resumeChild.mjs') });
    const s1 = svc.spawnResume('t-live1', 'portal');
    const s2 = svc.spawnResume('t-live2', 'portal');
    expect(s1.logFile).not.toBe(s2.logFile);
    await new Promise((r) => setTimeout(r, 1500));
    const files = readdirSync(path.join(dataDir, 'portal', 'logs'));
    expect(files.some((f) => f.startsWith('resume-t-live1-'))).toBe(true);
    expect(files.some((f) => f.startsWith('resume-t-live2-'))).toBe(true);
    const st1 = svc.statusOf('t-live1');
    expect(st1).not.toBeNull();
    expect(st1!.logFile).toBe(s1.logFile);
    expect(svc.statusOf('t-unknown')).toBeNull();
    expect(() => svc.spawnResume('../evil', 'portal')).toThrow();
  });

  it('spawn 透传 Node 装载旗标（execArgv——开发态 tsx 形态前提：argv[1]=.ts 须复现装载器）', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-rs4-'));
    const svc = new ResumeService({
      dataDir,
      repoRoot: process.cwd(),
      cliEntry: path.resolve('tests/fixtures/resumeChild.mjs'),
      execArgv: ['--require', path.resolve('tests/fixtures/resumePreload.cjs')], // 模拟 tsx/装载旗标
    });
    svc.spawnResume('t-pre', 'portal');
    await new Promise((r) => setTimeout(r, 1500));
    const log = svc.readLog('t-pre')!;
    expect(log.content).toContain('preload-marker'); // 旗标已透传（子进程先跑预载再进主模块）
    expect(log.content).toContain('manual-resume'); // 主模块参数不受旗标干扰
  });
});

// ---------- view/write 纯函数（§4.4 前端写操作流口径） ----------

describe('WP6B3-9 view/write 纯函数', () => {
  it('cancelModeFor：running 仅 force（graceful 禁用+提示）；queued/paused 两态可选', () => {
    const running = cancelModeFor('running');
    expect(running.gracefulDisabled).toBe(true);
    expect(running.hint).toContain('独立进程');
    expect(cancelModeFor('queued').gracefulDisabled).toBe(false);
    expect(cancelModeFor('paused').gracefulDisabled).toBe(false);
    expect(cancelModeFor('succeeded').defaultMode).toBe('graceful');
  });

  it('confirmCrashRecoveryText：明示将把所有 Running 任务标记为 Failed(CrashRecovery)', () => {
    const text = confirmCrashRecoveryText(2);
    expect(text).toContain('2');
    expect(text).toContain('Failed(CrashRecovery)');
  });

  it('approveActionHint：pending+paused 可决议；approved+paused=已批准待续跑；其余只读', () => {
    expect(approveActionHint('pending', 'paused').decidable).toBe(true);
    const approved = approveActionHint('approved', 'paused');
    expect(approved.decidable).toBe(false);
    expect(approved.hint).toContain('待续跑');
    expect(approveActionHint('pending', 'running').decidable).toBe(false);
    const terminal = approveActionHint('denied', 'cancelled');
    expect(terminal.decidable).toBe(false);
    expect(terminal.hint).toContain('只读');
  });

  it('resumeNote：spawn 结果标注 resumedBy=manual-resume 与日志位置；未启动明示', () => {
    const note = resumeNote({ taskId: 't-1', spawned: true, logFile: 'x/resume-t-1-1.log' });
    expect(note).toContain('manual-resume');
    expect(note).toContain('resume-t-1-1.log');
    expect(resumeNote({ taskId: 't-1', spawned: false, logFile: '' })).toContain('未启动');
  });
});

// ---------- 写面协议边界（补覆盖：413 / 非法 JSON / 未知 POST 路由 / 通用错误映射） ----------

describe('WP6B3-10 写面协议边界（P1-2-② 与 body 解析）', () => {
  it('POST 非法 JSON → 400；未知 POST 路由 → 404；GET 非法 status 过滤 → 400', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const handle = await startTestServer(h.rt);
    const bad = await post(handle.port, '/api/portal/crash-recovery', '{not-json');
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).code).toBe('bad_request');
    const array = await post(handle.port, '/api/portal/crash-recovery', '[1,2]');
    expect(array.status).toBe(400);
    const unknown = await post(handle.port, '/api/no-such-write');
    expect(unknown.status).toBe(404);
    const badStatus = await request(handle.port, 'GET', '/api/tasks?status=bogus', { Authorization: TOKEN.Authorization });
    expect(badStatus.status).toBe(400);
  });

  it('POST 请求体超 1 MiB → 413 payload_too_large（读侧丢弃不解析）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const handle = await startTestServer(h.rt);
    const res = await request(
      handle.port,
      'POST',
      '/api/portal/crash-recovery',
      TOKEN,
      'x'.repeat(1024 * 1024 + 1024),
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).code).toBe('payload_too_large');
  });

  it('apiErrorPayload：无 code 的通用错误归 internal_error(500)；ResumeError(invalid_task_id)→400', async () => {
    const { apiErrorPayload } = await import('../src/portal/errormap.js');
    const generic = apiErrorPayload(new Error('boom'));
    expect(generic.status).toBe(500);
    expect(generic.body.code).toBe('internal_error');
    const notTask = apiErrorPayload(Object.assign(new Error('任务不存在：x'), {}));
    expect(notTask.status).toBe(404);
    // resume-log 端点对非法 taskId 直接走 ResumeError → 400（已在 WP6B3-5 断言端点行为，此处钉错误映射）
    const { ResumeError } = await import('../src/portal/resume.js');
    const mapped = apiErrorPayload(new ResumeError('bad id', 'invalid_task_id'));
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe('invalid_task_id');
  });
});
