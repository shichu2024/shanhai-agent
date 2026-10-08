import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers.js';
import { startPortalServer, stopPortalServer, type PortalHandle } from '../src/portal/server.js';
import { AUTH_EXPIRED_TEXT, UI_ERROR_TEXT, explainFailure } from '../src/portal/ui/errors.js';

// TASK-128：启动后不得出现「缺少或错误的 Bearer Token（Authorization: Bearer <token>）」式
// 技术性报错——最终用户不应需要理解 Token。三个面：
//   ① 服务端 401 message 去技术化（机器语义仍由 code=unauthorized 承载，协议本身不变）；
//   ② 前端 401/未登录文案去技术化，且恢复路径指向「启动自动送达」而非要求用户操作口令；
//   ③ 会话自动送达：文件托管形态每次启动恒拉起浏览器（wp6d 测试已随 TASK-128 修订）。
// 稳定性注（TASK-136，对齐 TASK-119 第五批口径）：①节的两个真实 server 往返用例统一显式
//           timeout=20s——防高负载下 vitest 缺省 5s 超时红（trend 族同机理余量不足）；
//           ②③节为源契约/纯函数断言不加。

const JARGON = /Bearer|Authorization/;

// ---------- ① 服务端 401 message（真实 HTTP 集成） ----------

interface TestResponse {
  status: number;
  body: string;
}

function httpRequest(port: number, method: string, pathName: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const servers: PortalHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await stopPortalServer(s);
});

describe('TASK-128 服务端 401 message 去技术化（协议不变，文案面向最终用户）', () => {
  it('无凭证 GET /api/tasks → 401 + code=unauthorized，message 无 Bearer/Authorization 字样', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const handle = await startPortalServer(h.rt, { dataDir: h.dataDir, repoRoot: h.repoRoot, host: '127.0.0.1', port: 0, token: 'test-token-0000000000000000000000000000' });
    servers.push(handle);
    const res = await httpRequest(handle.port, 'GET', '/api/tasks');
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('unauthorized'); // 机器语义保留
    expect(body.message).not.toMatch(JARGON);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('错误凭证 → 同口径（错误口令不泄露协议细节）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    const handle = await startPortalServer(h.rt, { dataDir: h.dataDir, repoRoot: h.repoRoot, host: '127.0.0.1', port: 0, token: 'test-token-0000000000000000000000000000' });
    servers.push(handle);
    const res = await httpRequest(handle.port, 'GET', '/api/tasks', { Authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('unauthorized');
    expect(body.message).not.toMatch(JARGON);
  });
});

// ---------- ② 前端文案去技术化（源契约 + 纯函数） ----------

describe('TASK-128 前端 401/未登录文案去技术化', () => {
  it('AUTH_EXPIRED_TEXT：无 Token/Bearer/Authorization 字样，指引自动送达恢复路径', () => {
    expect(AUTH_EXPIRED_TEXT).not.toMatch(JARGON);
    expect(AUTH_EXPIRED_TEXT).not.toContain('Token');
    expect(AUTH_EXPIRED_TEXT).toContain('自动完成登录'); // 恢复路径 = 启动自动送达，非用户操作口令
  });

  it('UI_ERROR_TEXT.unauthorized 与 explainFailure(401) 同口径且无技术概念', () => {
    expect(UI_ERROR_TEXT.unauthorized).toBe(AUTH_EXPIRED_TEXT);
    const text = explainFailure({ ok: false, kind: 'http', status: 401, code: 'unauthorized', message: 'server-side detail' });
    expect(text).toBe(AUTH_EXPIRED_TEXT);
    expect(text).not.toMatch(JARGON);
    expect(text).not.toContain('Token');
  });

  it('源契约：ui 各页面 401 态统一引用 AUTH_EXPIRED_TEXT，无散落技术文案', () => {
    const uiDir = path.resolve(process.cwd(), 'src', 'portal', 'ui');
    for (const file of [
      'agentsPage.ts',
      'approvalDetailPage.ts',
      'approvalsPage.ts',
      'observeCapabilitiesPage.ts',
      'observeEvolutionPage.ts',
      'observeOverviewPage.ts',
      'taskDetailPage.ts',
      'tasksPage.ts',
    ]) {
      const source = readFileSync(path.join(uiDir, file), 'utf8');
      expect(source, `${file} 应引用 AUTH_EXPIRED_TEXT`).toContain('AUTH_EXPIRED_TEXT');
      expect(source, `${file} 不得残留旧技术文案`).not.toContain('认证失效，请更新 Token');
    }
  });

  it('源契约：产物 app.js 401 文案已更新，旧技术文案零残留', () => {
    const appJs = readFileSync(path.resolve(process.cwd(), 'src', 'portal', 'public', 'app.js'), 'utf8');
    expect(appJs).toContain('登录状态已失效');
    expect(appJs).toContain('自动完成登录');
    expect(appJs).not.toContain('认证失效，请更新 Token');
    expect(appJs).not.toContain('Token 无效或已过期');
    expect(appJs).not.toContain('未认证（请设置 Token）');
  });

  it('源契约：index.html 口令区占位文案去技术化（兜底入口，不要求理解凭证概念）', () => {
    const html = readFileSync(path.resolve(process.cwd(), 'src', 'portal', 'public', 'index.html'), 'utf8');
    expect(html).toContain('访问口令');
    expect(html).not.toContain('门户 Token（会话级存储）');
  });

  it('源契约：服务端 401 message 常量无技术概念（防回退钉死）', () => {
    const server = readFileSync(path.resolve(process.cwd(), 'src', 'portal', 'server.ts'), 'utf8');
    expect(server).not.toContain("message: '缺少或错误的 Bearer Token");
    expect(server).not.toMatch(/message: [^\n]*Authorization/);
  });
});
