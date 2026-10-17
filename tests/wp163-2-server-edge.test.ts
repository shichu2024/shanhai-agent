import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { startPortalServer, stopPortalServer, type PortalHandle } from '../src/portal/server.js';

// 每日优化第十六批（TASK-163）：src/portal/server.ts 行覆盖加固（基线行 95.33%，未覆盖
// 232-234/243-245/273/360-362/369-370）。真实 server 往返（startPortalServer 临时端口）：
//  - 232-234：静态路径 percent-encoding 非法 → decodeURIComponent 抛 → 404「路径无法解析」；
//  - 243-245：Windows 盘符绝对形态（/c:/x）→ path.resolve 脱离 publicDir → 前缀校验 404；
//  - 360-362：/api/* 非 GET/HEAD/POST 方法（DELETE）→ 405 method_not_allowed；
//  - 369-370：静态面非 GET/HEAD（POST）→ 405 method_not_allowed；
//  - 另覆盖：POST 无 Content-Type → 415「(无 Content-Type)」、HEAD 静态/API 臂、
//    env 端口解析臂（SHANHAI_PORTAL_PORT，opts.port 缺省时生效）。
// 稳定性注（对齐 TASK-119/136 口径）：本文件全部为真实 server 往返用例，统一 timeout=20s。

const TOKEN = 'test-token-0000000000000000000000000000';

function makeRuntime(): { rt: Runtime; dataDir: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-wp163-srv-'));
  const rt = Runtime.withProvider(new MockProvider([]), ['mock-model'], dataDir, process.cwd());
  rt.startup('test');
  return { rt, dataDir };
}

function httpRequest(
  port: number,
  method: string,
  pathName: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const servers: PortalHandle[] = [];
const envBackup: { key: string; had: boolean; value?: string }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await stopPortalServer(s);
  for (const e of envBackup.splice(0)) {
    if (e.had) process.env[e.key] = e.value;
    else delete process.env[e.key];
  }
});

async function startTestServer(made: { rt: Runtime; dataDir: string }, opts: { port?: number } = {}): Promise<PortalHandle> {
  const handle = await startPortalServer(made.rt, {
    dataDir: made.dataDir,
    repoRoot: process.cwd(),
    host: '127.0.0.1',
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    token: TOKEN,
  });
  servers.push(handle);
  return handle;
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

describe('wp163 serveStatic 错误面：percent-encoding 非法 → 404 路径无法解析（server.ts:229-234）', () => {
  it('GET /%zz（非法百分号序列）→ 404 + code=not_found + 路径无法解析', { timeout: 20_000 }, async () => {
    const made = makeRuntime();
    const h = await startTestServer(made, { port: 0 });
    const res = await httpRequest(h.port, 'GET', '/%zz');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.parse(res.body).message).toContain('路径无法解析');
  });
});

describe('wp163 serveStatic 前缀防御：Windows 盘符绝对形态 → 404（server.ts:241-245）', () => {
  it('GET /c:/x → path.resolve 脱离 publicDir → 404 资源不存在（win32 平台事实）', { timeout: 20_000 }, async () => {
    const made = makeRuntime();
    const h = await startTestServer(made, { port: 0 });
    const res = await httpRequest(h.port, 'GET', '/c:/x');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.parse(res.body).message).toContain('资源不存在');
  });
});

describe('wp163 方法面：/api/* 与静态面的 405 兜底（server.ts:360-362/369-370）', () => {
  it('DELETE /api/tasks（带 Token，认证过、非 GET/HEAD/POST）→ 405 method_not_allowed', { timeout: 20_000 }, async () => {
    const made = makeRuntime();
    const h = await startTestServer(made, { port: 0 });
    const res = await httpRequest(h.port, 'DELETE', '/api/tasks', auth());
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'method_not_allowed' });
  });

  it('POST /index.html（静态面非 GET/HEAD，Token 豁免面）→ 405 method_not_allowed', { timeout: 20_000 }, async () => {
    const made = makeRuntime();
    const h = await startTestServer(made, { port: 0 });
    const res = await httpRequest(h.port, 'POST', '/index.html', { 'Content-Type': 'application/json' }, '{}');
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'method_not_allowed' });
  });
});

describe('wp163 POST Content-Type 缺失 → 415 无 Content-Type 文案（server.ts:330-333）', () => {
  it('POST /api/tasks 无 Content-Type 头 → 415 + 文案含「(无 Content-Type)」', { timeout: 20_000 }, async () => {
    const made = makeRuntime();
    const h = await startTestServer(made, { port: 0 });
    const res = await httpRequest(h.port, 'POST', '/api/tasks', auth(), '{}');
    expect(res.status).toBe(415);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'unsupported_media_type' });
    expect(JSON.parse(res.body).message).toContain('(无 Content-Type)');
  });
});

describe('wp163 HEAD 方法臂：静态面与 API 面均走 GET 处理（server.ts:355/365）', () => {
  it('HEAD / → 200（静态 index.html，方法臂放行）', { timeout: 20_000 }, async () => {
    const made = makeRuntime();
    const h = await startTestServer(made, { port: 0 });
    const res = await httpRequest(h.port, 'HEAD', '/');
    expect(res.status).toBe(200);
  });

  it('HEAD /api/tasks（带 Token）→ 200（API GET/HEAD 臂放行）', { timeout: 20_000 }, async () => {
    const made = makeRuntime();
    const h = await startTestServer(made, { port: 0 });
    const res = await httpRequest(h.port, 'HEAD', '/api/tasks', auth());
    expect(res.status).toBe(200);
  });
});

describe('wp163 env 端口解析臂：opts.port 缺省时 SHANHAI_PORTAL_PORT 生效（server.ts:263）', () => {
  it('不传 port 旗标 + env 指定空闲端口 → 实际监听端口 = env 值', { timeout: 20_000 }, async () => {
    // 先探测一个空闲端口（内核分配后立即释放，复用值）
    const probe = net.createServer();
    const freePort: number = await new Promise((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    envBackup.push({ key: 'SHANHAI_PORTAL_PORT', had: 'SHANHAI_PORTAL_PORT' in process.env, value: process.env.SHANHAI_PORTAL_PORT });
    process.env.SHANHAI_PORTAL_PORT = String(freePort);
    const made = makeRuntime();
    const h = await startTestServer(made); // 无 port —— 走 env 臂
    expect(h.port).toBe(freePort);
    const res = await httpRequest(h.port, 'HEAD', '/');
    expect(res.status).toBe(200);
  });
});
