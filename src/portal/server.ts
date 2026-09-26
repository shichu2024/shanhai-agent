import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Runtime } from '../runtime.js';
import type { RecoveryReport } from '../modules/stateManager.js';
import { resolvePortalToken, bearerTokenOf, tokenMatches, hostAllowed } from './auth.js';
import { handleApiGet, sendJson, sendApiError } from './api.js';

// 第六阶段批次一（§4.1 / §5.1）：node:http 门户服务器——启动、路由分发、静态文件、错误兜底。
// 进程模型（D-42）：常驻单进程；boot 条件化 startup（Running>0 跳过 recover 并警示）；
// 请求路径零 recover、零后台定时器。本批无写端点（6-3 扩写面）。

export interface PortalServerOptions {
  dataDir: string;
  repoRoot: string;
  /** 绑定地址（CLI 旗标 > config > 缺省 127.0.0.1，D-44） */
  host?: string;
  /** 端口（CLI 旗标 > config > env SHANHAI_PORTAL_PORT > 缺省 7780；0 = 测试临时端口） */
  port?: number;
  /** config portal.token 显式覆盖（解析序首位） */
  token?: string;
}

export interface PortalHandle {
  server: http.Server;
  host: string;
  port: number;
  token: string;
  /** Token 为本次启动新生成（CLI 据此打印一次性提示） */
  tokenGenerated: boolean;
  /** 自动生成/读取的 Token 文件路径（显式 config/env 覆盖时为 null） */
  tokenFile: string | null;
  close(): Promise<void>;
}

export interface BootReport {
  skippedStartup: boolean;
  runningCount: number;
  report?: RecoveryReport;
}

/**
 * 门户 boot（D-42 核心，§5.1 步骤 2）：查 Running 遗留计数——
 * =0：调用 rt.startup（内含 builtin 登记 + recover 全段，既有行为完整保留）；
 * >0：跳过 startup 并警示（recover 无法区分崩溃遗留与活进程执行，常驻门户无条件扫描必误杀）。
 * 纯调用编排，不改 stateManager 任何行为。rt.db 经既有非枚举暴露面取用，仅读（§6）。
 */
export function bootPortal(rt: Runtime, who = 'portal'): BootReport {
  const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
  const runningCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM task_record WHERE status = 'running'`).get() as { c: number }
  ).c;
  if (runningCount > 0) {
    console.warn(
      `[portal] 检测到 ${runningCount} 个 Running 任务（可能正由其他进程执行），本次启动不执行崩溃恢复扫描；` +
        `请确认该任务进程存活。recover 责任留给下一次无 Running 遗留的 CLI/门户启动（D-42）。`,
    );
    return { skippedStartup: true, runningCount };
  }
  return { skippedStartup: false, runningCount, report: rt.startup(who) };
}

/** CLI 旗标解析：shanhai portal [--port N] [--host H]；非法值 fail-fast */
export function parsePortalArgs(args: string[]): { port?: number; host?: string } {
  const out: { port?: number; host?: string } = {};
  const portIdx = args.indexOf('--port');
  if (portIdx >= 0) {
    const raw = args[portIdx + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port 必须为 1-65535 的整数（收到：${raw ?? '(缺失)'}）`);
    out.port = n;
  }
  const hostIdx = args.indexOf('--host');
  if (hostIdx >= 0) {
    const raw = args[hostIdx + 1];
    if (!raw || raw.length === 0) throw new Error('--host 不能为空');
    out.host = raw;
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 静态资产根（P2-1：运行期自 repoRoot 解析，不做构建期复制） */
function publicDirOf(repoRoot: string): string {
  return path.resolve(repoRoot, 'src', 'portal', 'public');
}

/** 静态文件服务：路径归一化防穿越 + 扩展名 Content-Type + nosniff（D-44-5）；未命中 404 */
function serveStatic(repoRoot: string, pathname: string, res: http.ServerResponse): void {
  const publicDir = publicDirOf(repoRoot);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 404, { ok: false, code: 'not_found', message: '路径无法解析' });
    return;
  }
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..' || s === '.' || s.includes('\\') || s.includes('\0'))) {
    sendJson(res, 404, { ok: false, code: 'not_found', message: '资源不存在' });
    return;
  }
  const relative = segments.length === 0 ? 'index.html' : segments.join('/');
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(publicDir + path.sep)) {
    sendJson(res, 404, { ok: false, code: 'not_found', message: '资源不存在' });
    return;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    sendJson(res, 404, { ok: false, code: 'not_found', message: '资源不存在' });
    return;
  }
  const body = readFileSync(resolved);
  res.writeHead(200, {
    'Content-Type': MIME_BY_EXT[path.extname(resolved)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

/** 启动门户服务器（auth/静态/路由全链装配；port=0 时由内核分配临时端口，句柄回传实际端口） */
export async function startPortalServer(rt: Runtime, opts: PortalServerOptions): Promise<PortalHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? (process.env.SHANHAI_PORTAL_PORT ? Number(process.env.SHANHAI_PORTAL_PORT) : undefined) ?? 7780;
  const resolvedToken = resolvePortalToken(opts.dataDir, opts.token, process.env.SHANHAI_PORTAL_TOKEN);

  const server = http.createServer((req, res) => {
    try {
      handleRequest(rt, opts.repoRoot, host, resolvedToken.token, req, res);
    } catch (err) {
      sendApiError(res, err); // 错误兜底：Manager 结构化错误 → errormap → HTTP
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise());
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    server,
    host,
    port: actualPort,
    token: resolvedToken.token,
    tokenGenerated: resolvedToken.generated,
    tokenFile: resolvedToken.tokenFile,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

export async function stopPortalServer(handle: PortalHandle): Promise<void> {
  await handle.close();
}

function handleRequest(
  rt: Runtime,
  repoRoot: string,
  host: string,
  token: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const port = (req.socket.address() as { port: number }).port;
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const pathname = url.pathname;

  // ① Host 头校验（DNS rebinding 防护，D-44-4）——先于认证与路由
  if (!hostAllowed(req.headers.host, host)) {
    sendJson(res, 403, { ok: false, code: 'host_forbidden', message: `Host 头不被允许：${req.headers.host ?? '(缺失)'}` });
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    // ② 认证：所有 /api/* 要求 Bearer Token（静态资产豁免——不含数据面，D-44-2）
    if (!tokenMatches(token, bearerTokenOf(req))) {
      sendJson(res, 401, { ok: false, code: 'unauthorized', message: '缺少或错误的 Bearer Token（Authorization: Bearer <token>）' });
      return;
    }
    // ③ POST 强制 application/json（跨站简单请求协议层拒绝，P1-2-②）——先于路由
    if (req.method === 'POST') {
      const contentType = req.headers['content-type'] ?? '';
      if (!/^application\/json\b/i.test(contentType)) {
        sendJson(res, 415, { ok: false, code: 'unsupported_media_type', message: `POST 仅接受 application/json（收到：${contentType || '(无 Content-Type)'}）` });
        return;
      }
      sendJson(res, 404, { ok: false, code: 'not_found', message: '未知 API 路由（写面端点于批次 6-3 落地）' });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (handleApiGet(rt, pathname, url.searchParams, res)) return;
      sendJson(res, 404, { ok: false, code: 'not_found', message: `未知 API 路由：${req.method} ${pathname}` });
      return;
    }
    sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: `不支持的方法：${req.method}` });
    return;
  }

  // ④ 静态面（Token 豁免——静态资产不含数据面）
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(repoRoot, pathname, res);
    return;
  }
  sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: `不支持的方法：${req.method}` });
}
