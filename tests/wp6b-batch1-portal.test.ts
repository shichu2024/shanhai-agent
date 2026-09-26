import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { loadRuntimeConfig, ConfigError } from '../src/config.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, registerL3Tool, approvalSpec } from './helpers.js';
import { bootPortal, startPortalServer, stopPortalServer, parsePortalArgs, type PortalHandle } from '../src/portal/server.js';
import { resolvePortalToken, tokenMatches, hostAllowed } from '../src/portal/auth.js';
import { apiErrorStatus } from '../src/portal/errormap.js';
import { parseHash } from '../src/portal/view/router.js';
import { taskSummary, runningWarning } from '../src/portal/view/tasks.js';
import { approvalSummary, formatDuration } from '../src/portal/view/approvals.js';

// WP-6B 批次一（6-1/4）：门户骨架 + 核心读面。
// DoD 断言：A-32（纯增量）/ A-35（boot 安全）/ A-37 部分（tasks/approvals 读端点深度相等）/
//           A-38（401/415/403/路径穿越）/ A-39（配置兼容）/ A-40（工程门另跑）。

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function dbDump(db: Database.Database): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    parts.push(`${t}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

/** 驱动到 Paused：模型请求 L3 工具 → 挂起即退出（与 approvalFlow 同款基座） */
async function driveToPaused(h: ReturnType<typeof makeHarness>, agentId: string) {
  registerL3Tool(h);
  registerAndRelease(h.rt, approvalSpec(agentId));
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(taskId);
  expect(row.status).toBe('paused');
  const request = h.rt.approvals.pendingForTask(taskId)!;
  expect(request).not.toBeNull();
  return { taskId, request };
}

// ---------- HTTP 客户端小工具（node:http 直打，零依赖） ----------

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpRequest(
  port: number,
  method: string,
  pathName: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const servers: PortalHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await stopPortalServer(s);
});

async function startTestServer(rt: Runtime, dataDir: string, repoRoot: string, opts: { token?: string; host?: string } = {}): Promise<PortalHandle> {
  const handle = await startPortalServer(rt, { dataDir, repoRoot, host: opts.host ?? '127.0.0.1', port: 0, token: opts.token ?? 'test-token-0000000000000000000000000000' });
  servers.push(handle);
  return handle;
}

// ---------- D-49 / A-39：config portal 节 ----------

describe('WP6B-1 config：parsePortalSection（D-49，A-39）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-cfg-'));
  const base = { providers: { anthropic: { baseUrl: 'https://example.test', authTokenEnv: 'TEST_TOK', models: ['m-1'] } } };
  const loadWith = (raw: Record<string, unknown>) => {
    const p = path.join(dir, 'config.local.json');
    writeFileSync(p, JSON.stringify(raw));
    return loadRuntimeConfig({ SHANHAI_CONFIG: p, TEST_TOK: 't' } as NodeJS.ProcessEnv);
  };

  it('无 portal 节：portal 为 undefined（存量兼容，A-39）', () => {
    expect(loadWith(base).portal).toBeUndefined();
  });

  it('合法 portal 节：host/port/operatorId/token 全解析', () => {
    const cfg = loadWith({ ...base, portal: { host: '127.0.0.1', port: 7781, operatorId: 'portal-op', token: 'sekret' } });
    expect(cfg.portal).toEqual({ host: '127.0.0.1', port: 7781, operatorId: 'portal-op', token: 'sekret' });
  });

  it('非法 port（0 / 负数 / 非整数 / 非数字 / NaN）→ ConfigError fail-fast', () => {
    for (const port of [0, -1, 65536, 1.5, 'x', NaN]) {
      expect(() => loadWith({ ...base, portal: { port } })).toThrow(ConfigError);
    }
  });

  it('非法 host / operatorId / token（非字符串或空串）→ ConfigError fail-fast', () => {
    expect(() => loadWith({ ...base, portal: { host: 123 } })).toThrow(ConfigError);
    expect(() => loadWith({ ...base, portal: { host: '' } })).toThrow(ConfigError);
    expect(() => loadWith({ ...base, portal: { operatorId: [] } })).toThrow(ConfigError);
    expect(() => loadWith({ ...base, portal: { token: 42 } })).toThrow(ConfigError);
  });
});

// ---------- D-48：TaskManager.listTasks 增量只读方法 ----------

describe('WP6B-2 TaskManager.listTasks（D-48：只读 SELECT、分页、无写副作用）', () => {
  it('全量/过滤/分页 + 排序（createdAt 倒序）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'lt-a' }));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'lt-b' }));
    const t1 = h.rt.tasks.createTask('lt-a', validInput, 't');
    const t2 = h.rt.tasks.createTask('lt-b', validInput, 't');
    const t3 = h.rt.tasks.createTask('lt-a', validInput, 't');
    const done = await h.rt.tasks.runTask(t1);
    expect(done.status).toBe('succeeded');

    const all = h.rt.tasks.listTasks();
    expect(all.total).toBe(3);
    expect(all.tasks.map((r) => r.taskId)).toEqual([t3, t2, t1]); // 最新在前

    expect(h.rt.tasks.listTasks({ status: 'succeeded' }).tasks.map((r) => r.taskId)).toEqual([t1]);
    expect(h.rt.tasks.listTasks({ status: 'queued' }).total).toBe(2);
    expect(h.rt.tasks.listTasks({ agentId: 'lt-a' }).total).toBe(2);
    expect(h.rt.tasks.listTasks({ agentId: 'lt-b' }).tasks.map((r) => r.taskId)).toEqual([t2]);

    const page1 = h.rt.tasks.listTasks({ limit: 2 });
    const page2 = h.rt.tasks.listTasks({ limit: 2, offset: 2 });
    expect(page1.tasks.map((r) => r.taskId)).toEqual([t3, t2]);
    expect(page2.tasks.map((r) => r.taskId)).toEqual([t1]);
    expect(page1.total).toBe(3); // 分页不缩 total
  });

  it('只读守卫：listTasks 前后全库快照一致（零写入零事件，D-48 守卫）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'lt-ro' }));
    const t = h.rt.tasks.createTask('lt-ro', validInput, 't');
    await h.rt.tasks.runTask(t);
    const before = dbDump(dbOf(h.rt));
    h.rt.tasks.listTasks();
    h.rt.tasks.listTasks({ status: 'succeeded', agentId: 'lt-ro', limit: 1, offset: 0 });
    expect(dbDump(dbOf(h.rt))).toBe(before);
  });
});

// ---------- D-42 / A-35：boot 条件化 startup ----------

describe('WP6B-3 bootPortal 条件化 startup（D-42，A-35 boot 安全）', () => {
  function bareRuntime(dataDir: string): Runtime {
    const provider = new MockProvider([{ kind: 'text', text: validJson }]);
    return Runtime.withProvider(provider, ['mock-model'], dataDir, process.cwd());
  }

  it('Running>0：跳过 startup，Running 行不被标 CrashRecovery、无 crash_recovery_marked 事件', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-boot-'));
    const rt = bareRuntime(dataDir);
    // 先正常 startup（模拟此前 CLI 进程完成工具登记与版本发布），再手工构造 Running 遗留行
    rt.startup('test');
    registerAndRelease(rt, sampleSpec({ agentId: 'boot-a' }));
    const t = rt.tasks.createTask('boot-a', validInput, 't');
    dbOf(rt).prepare(`UPDATE task_record SET status='running' WHERE taskId=?`).run(t);

    const boot = bootPortal(rt);
    expect(boot.skippedStartup).toBe(true);
    expect(boot.runningCount).toBe(1);
    expect(rt.tasks.getTask(t).status).toBe('running'); // 未被误标
    expect(rt.trace.readEvents(t).some((e) => e.eventType === 'crash_recovery_marked')).toBe(false);
    rt.close();
  });

  it('Running=0：startup 正常执行（builtin 工具登记 + recover 完整保留）', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-boot-'));
    const rt = bareRuntime(dataDir);
    const boot = bootPortal(rt);
    expect(boot.skippedStartup).toBe(false);
    expect(boot.report).toBeDefined();
    expect(rt.registry.getTool('docs-list')).not.toBeNull(); // builtin 工具已登记（startup 副作用保留）
    rt.close();
  });
});

// ---------- D-44 / A-38：认证与边界 + 核心读面端点（A-37 部分） ----------

describe('WP6B-4 门户 server：认证边界（A-38：401/415/403/穿越）', () => {
  it('无 Authorization / 错误 Token 访问 /api/* → 401；正确 Bearer → 200', async () => {
    const h = makeHarness();
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
    const handle = await startTestServer(h.rt, dir, process.cwd());

    const noAuth = await httpRequest(handle.port, 'GET', '/api/tasks');
    expect(noAuth.status).toBe(401);
    expect(JSON.parse(noAuth.body).code).toBe('unauthorized');

    const bad = await httpRequest(handle.port, 'GET', '/api/tasks', { Authorization: 'Bearer wrong-token' });
    expect(bad.status).toBe(401);

    const ok = await httpRequest(handle.port, 'GET', '/api/tasks', { Authorization: 'Bearer test-token-0000000000000000000000000000' });
    expect(ok.status).toBe(200);
  });

  it('text/plain POST /api/* → 415（P1-2-② 协议层拒绝）', async () => {
    const h = makeHarness();
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
    const handle = await startTestServer(h.rt, dir, process.cwd());
    const res = await httpRequest(
      handle.port, 'POST', '/api/tasks',
      { Authorization: 'Bearer test-token-0000000000000000000000000000', 'Content-Type': 'text/plain' },
      'hello',
    );
    expect(res.status).toBe(415);
    expect(JSON.parse(res.body).code).toBe('unsupported_media_type');
  });

  it('Host 头非本机地址 → 403（DNS rebinding 防护）', async () => {
    const h = makeHarness();
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
    const handle = await startTestServer(h.rt, dir, process.cwd());
    const res = await httpRequest(
      handle.port, 'GET', '/api/tasks',
      { Authorization: 'Bearer test-token-0000000000000000000000000000', Host: 'evil.example.com' },
    );
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('host_forbidden');
  });

  it('静态面：/ → 200 text/html + nosniff；未知资产 → 404；路径穿越 → 404', async () => {
    const h = makeHarness();
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
    const handle = await startTestServer(h.rt, dir, process.cwd());
    const T = { Authorization: 'Bearer test-token-0000000000000000000000000000' };

    const index = await httpRequest(handle.port, 'GET', '/', T);
    expect(index.status).toBe(200);
    expect(String(index.headers['content-type'])).toContain('text/html');
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.body).toContain('shanhai');

    const missing = await httpRequest(handle.port, 'GET', '/no-such-asset.js', T);
    expect(missing.status).toBe(404);

    const traversal = await httpRequest(handle.port, 'GET', '/..%2f..%2fsrc%2fconfig.ts', T);
    expect(traversal.status).toBe(404);
    const traversal2 = await httpRequest(handle.port, 'GET', '/../package.json', T);
    expect(traversal2.status).toBe(404);
  });

  it('未知 /api 路由 → 404 结构化错误', async () => {
    const h = makeHarness();
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
    const handle = await startTestServer(h.rt, dir, process.cwd());
    const res = await httpRequest(handle.port, 'GET', '/api/nope', { Authorization: 'Bearer test-token-0000000000000000000000000000' });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).ok).toBe(false);
  });
});

describe('WP6B-5 核心读面端点（A-37 部分：与 Manager 输出深度相等）', () => {
  it('GET /api/tasks 与 listTasks 深度相等（过滤/分页参数透传）；/api/tasks/:id 与 getTask 深度相等', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ep-a' }));
    const t1 = h.rt.tasks.createTask('ep-a', validInput, 't');
    await h.rt.tasks.runTask(t1);
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
    const handle = await startTestServer(h.rt, dir, process.cwd());
    const T = { Authorization: 'Bearer test-token-0000000000000000000000000000' };

    const res = await httpRequest(handle.port, 'GET', '/api/tasks', T);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(h.rt.tasks.listTasks());

    const filtered = await httpRequest(handle.port, 'GET', '/api/tasks?status=succeeded&limit=1&offset=0', T);
    expect(JSON.parse(filtered.body)).toEqual(h.rt.tasks.listTasks({ status: 'succeeded', limit: 1, offset: 0 }));

    const one = await httpRequest(handle.port, 'GET', `/api/tasks/${t1}`, T);
    expect(one.status).toBe(200);
    expect(JSON.parse(one.body)).toEqual(h.rt.tasks.getTask(t1));

    const missing = await httpRequest(handle.port, 'GET', '/api/tasks/no-such-task', T);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('not_found');

    const badQuery = await httpRequest(handle.port, 'GET', '/api/tasks?limit=abc', T);
    expect(badQuery.status).toBe(400);
  });

  it('GET /api/approvals?pending= 与 approvals.list 深度相等（含惰性超时判定入口）；/api/approvals/:id 与 show 深度相等', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'prod-db' } }] },
      { kind: 'text', text: validJson },
    ]);
    const { taskId, request } = await driveToPaused(h, 'ep-ap');
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
    const handle = await startTestServer(h.rt, dir, process.cwd());
    const T = { Authorization: 'Bearer test-token-0000000000000000000000000000' };

    const all = await httpRequest(handle.port, 'GET', '/api/approvals', T);
    const stripDrift = (rows: Record<string, unknown>[]) => rows.map(({ timeoutRemainingMs, ...rest }) => ({ ...rest, timeoutRemainingMs: typeof timeoutRemainingMs }));
    expect(stripDrift(JSON.parse(all.body))).toEqual(stripDrift(h.rt.approvals.list() as Record<string, unknown>[]));

    const pending = await httpRequest(handle.port, 'GET', '/api/approvals?pending=true', T);
    expect(stripDrift(JSON.parse(pending.body))).toEqual(stripDrift(h.rt.approvals.list({ pendingOnly: true }) as Record<string, unknown>[]));
    expect((JSON.parse(pending.body) as { requestId: string }[]).some((r) => r.requestId === request.requestId)).toBe(true);

    const one = await httpRequest(handle.port, 'GET', `/api/approvals/${request.requestId}`, T);
    expect(one.status).toBe(200);
    expect(JSON.parse(one.body)).toEqual(h.rt.approvals.show(request.requestId));

    const missing = await httpRequest(handle.port, 'GET', '/api/approvals/no-such-req', T);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('not_found');

    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 读面无写副作用
  });
});

// ---------- D-44 / P1-2-①：Token 解析序与自动生成 ----------

describe('WP6B-6 Token 解析序（D-44：config > env > 首次生成 0600 落盘）', () => {
  it('解析序：config 显式值优先；env 次之；均无则自动生成并落 data/portal/token（幂等重读）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-tok-'));

    expect(resolvePortalToken(dir, 'cfg-token', 'env-token').token).toBe('cfg-token');
    expect(resolvePortalToken(dir, undefined, 'env-token').token).toBe('env-token');

    const gen = resolvePortalToken(dir, undefined, undefined);
    expect(gen.generated).toBe(true);
    expect(gen.token).toMatch(/^[0-9a-f]{64}$/); // randomBytes(32) hex
    const tokenFile = path.join(dir, 'portal', 'token');
    expect(existsSync(tokenFile)).toBe(true);
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(gen.token); // 落盘内容一致

    const again = resolvePortalToken(dir, undefined, undefined);
    expect(again.generated).toBe(false);
    expect(again.token).toBe(gen.token); // 二次启动读取既有文件（稳定）
    rmSync(dir, { recursive: true, force: true });
  });

  it('tokenMatches：恒时比对；hostAllowed：本机/配置地址放行，他域拒绝', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', null)).toBe(false);
    expect(tokenMatches('abc', 'abcd')).toBe(false); // 长度不等不泄露

    expect(hostAllowed('127.0.0.1:7780', '127.0.0.1')).toBe(true);
    expect(hostAllowed('localhost:7780', '127.0.0.1')).toBe(true);
    expect(hostAllowed('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(hostAllowed('192.168.1.5:7780', '192.168.1.5')).toBe(true);
    expect(hostAllowed('evil.example.com:7780', '127.0.0.1')).toBe(false);
    expect(hostAllowed(undefined, '127.0.0.1')).toBe(false);
  });
});

// ---------- D-50：错误码映射 ----------

describe('WP6B-7 errormap（D-50：结构化错误码 → HTTP）', () => {
  it('ApprovalError 族与通用错误映射', () => {
    expect(apiErrorStatus('not_found')).toBe(404);
    expect(apiErrorStatus('already_decided')).toBe(409);
    expect(apiErrorStatus('task_not_paused')).toBe(409);
    expect(apiErrorStatus('version_mismatch')).toBe(409);
    expect(apiErrorStatus('timeout_applied')).toBe(409);
    expect(apiErrorStatus('invalid_bound')).toBe(400);
    expect(apiErrorStatus('who-knows')).toBe(500);
  });
});

// ---------- CLI 旗标解析 ----------

describe('WP6B-8 parsePortalArgs（CLI：shanhai portal [--port N] [--host H]）', () => {
  it('旗标解析 + 非法值拒绝', () => {
    expect(parsePortalArgs([])).toEqual({});
    expect(parsePortalArgs(['--port', '7781'])).toEqual({ port: 7781 });
    expect(parsePortalArgs(['--host', '0.0.0.0', '--port', '8080'])).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(() => parsePortalArgs(['--port', 'abc'])).toThrow();
    expect(() => parsePortalArgs(['--port', '0'])).toThrow();
  });
});

// ---------- 前端纯函数视图模块（假设 5 修订：入覆盖分母） ----------

describe('WP6B-9 view 纯函数（src/portal/view/*）', () => {
  it('parseHash：hash 路由解析', () => {
    expect(parseHash('')).toEqual({ view: 'tasks' });
    expect(parseHash('#/tasks')).toEqual({ view: 'tasks' });
    expect(parseHash('#/tasks/t-123')).toEqual({ view: 'task-detail', id: 't-123' });
    expect(parseHash('#/approvals')).toEqual({ view: 'approvals' });
    expect(parseHash('#/approvals/req-9')).toEqual({ view: 'approval-detail', id: 'req-9' });
    expect(parseHash('#/whatever')).toEqual({ view: 'not-found', hash: '#/whatever' });
  });

  it('taskSummary + runningWarning：任务行展示变换 + D-42 Running 警示', () => {
    const row = {
      taskId: 't-1', agentId: 'ag-1', status: 'succeeded', createdAt: '2026-09-26T00:00:00.000Z', endedAt: '2026-09-26T00:01:00.000Z',
      attemptCount: 1, modelCallCount: 2, tokensUsed: 100,
    } as Parameters<typeof taskSummary>[0];
    const s = taskSummary(row);
    expect(s.taskId).toBe('t-1');
    expect(s.statusLabel).toBe('已成功');
    expect(s.isRunning).toBe(false);

    const running = taskSummary({ ...row, status: 'running' } as Parameters<typeof taskSummary>[0]);
    expect(running.isRunning).toBe(true);
    expect(running.statusLabel).toBe('运行中');

    expect(runningWarning([{ ...row, status: 'queued' } as Parameters<typeof taskSummary>[0]])).toBeNull();
    expect(runningWarning([{ ...row, status: 'running' } as Parameters<typeof taskSummary>[0]])).toContain('运行中');
  });

  it('approvalSummary + formatDuration：审批行展示变换', () => {
    expect(formatDuration(0)).toBe('已超时');
    expect(formatDuration(90_000)).toBe('2 分钟内');
    const s = approvalSummary({ requestId: 'r-1', toolId: 'l3-op', decision: 'pending', timeoutRemainingMs: 90_000, taskStatus: 'paused' } as Parameters<typeof approvalSummary>[0]);
    expect(s.requestId).toBe('r-1');
    expect(s.decisionLabel).toBe('待审批');
    expect(s.blocked).toBe(true); // pending 且任务 Paused → 阻塞中
  });
});
