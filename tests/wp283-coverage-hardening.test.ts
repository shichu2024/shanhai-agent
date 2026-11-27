import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 第六十二批（TASK-283 · 覆盖蓄量第三度）：纯测试加固，零 src 改动。
// 目标面（基线 f7ef625 实测 4896/4929 语句的未覆盖子集，逐条实质断言）：
//  - taskFilters.ts：isRunningStale 的 createdAt 不可解析 → false（行 93，不把非法时间当滞留）；
//  - taskDetailPage.ts：copy-id 剪贴板写入被拒 → catch 吞掉、不产生未处理拒绝（行 134 回调段）；
//  - server.ts：POST 头已到达、体未完成即断开 → req 'error' → readBody 收敛 null（行 387）。
// 其余未覆盖语句（竞速窗口 / 不可达防御 / TOCTOU / 须真实子进程）记入交付评论范围外清单。

import { isRunningStale, RUNNING_STALE_MS } from '../src/portal/ui/taskFilters.js';
import { mountTaskDetailPage } from '../src/portal/ui/taskDetailPage.js';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { startPortalServer, stopPortalServer, type PortalHandle } from '../src/portal/server.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import type { TimerHost } from '../src/portal/ui/poll.js';
import { clickEvent, fakeTimerHost, jsonResponse, makeSessionStorageStub, stubDoc, stubViewEl } from './wp7-3-mount-stubs.js';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

// ---------- taskFilters 纯函数 ----------

describe('wp283 taskFilters：running 滞留判定的非法时间边界', () => {
  it('isRunningStale：createdAt 不可解析 → false（不把非法时间当滞留）', () => {
    expect(isRunningStale({ status: 'running', endedAt: null, createdAt: 'not-a-date' }, NOW)).toBe(false);
    // 对照：合法且超阈值的同一形状 → true（证明 false 来自日期分支而非其他前置条件）
    expect(isRunningStale({ status: 'running', endedAt: null, createdAt: new Date(NOW - RUNNING_STALE_MS - 1000).toISOString() }, NOW)).toBe(true);
  });
});

// ---------- taskDetailPage 控制器 ----------

function makeCtx(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
): { ctx: PageCtx; view: ReturnType<typeof stubViewEl> } {
  const view = stubViewEl();
  const doc = stubDoc();
  const { host } = fakeTimerHost();
  return {
    ctx: {
      doc: doc as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: host as unknown as TimerHost,
      confirmBox: () => true,
      now: () => NOW,
    },
    view,
  };
}

const taskBody = {
  taskId: 'task-28300001', agentId: 'ag-1', agentVersionId: 'ver-1', input: '{"topic":"t"}', status: 'paused',
  attemptCount: 0, modelCallCount: 1, tokensUsed: 10, createdAt: '2026-11-01T11:00:00.000Z',
  endedAt: null, cancelReason: null, parentTaskId: null,
};

describe('wp283 taskDetailPage：copy-id 剪贴板写入被拒', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-283' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('writeText 拒绝 → 复制失败被吞掉（无未处理拒绝），页面不抛错且不触发任何请求', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    const attempted: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => { attempted.push(t); return Promise.reject(new Error('NotAllowedError')); } } });
    const calls: string[] = [];
    const { ctx, view } = makeCtx(async (p) => {
      calls.push(p);
      return jsonResponse(p.endsWith('/events') ? [] : p.endsWith('/evidence') ? { refs: [] } : p.includes('limit=100') ? { tasks: [], total: 0 } : taskBody);
    });
    try {
      const handle = mountTaskDetailPage(ctx, 'task-28300001');
      await vi.waitFor(() => expect(view.innerHTML).toContain('task-28300001'));
      const before = calls.length;
      expect(() => view.listeners.get('click')![0](clickEvent({ action: 'copy-id', id: 'task-28300001' }))).not.toThrow();
      await new Promise<void>((r) => setTimeout(r, 20)); // 让拒绝传播过微任务队列
      expect(attempted).toEqual(['task-28300001']); // 确实走到了写入（拒绝来自剪贴板，而非可选链短路）
      expect(unhandled).toEqual([]); // 行 134 catch 兜底：复制失败不冒泡
      expect(calls).toHaveLength(before); // 纯前端复制：无网络副作用
      handle.destroy();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------- portal server：请求体在途中连接中止 ----------

describe('wp283 portal server：POST 请求体在途中连接中止', () => {
  it('头已到达、体未完成即断开 → readBody 收敛为 null（req error 分支），服务不崩且后续请求照常', { timeout: 20_000 }, async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-wp283-srv-'));
    const rt = Runtime.withProvider(new MockProvider([]), ['mock-model'], dataDir, process.cwd());
    rt.startup('test');
    const token = 'test-token-0000000000000000000000000000';
    const handle: PortalHandle = await startPortalServer(rt, { dataDir, repoRoot: process.cwd(), host: '127.0.0.1', port: 0, token });
    try {
      // 100-continue 握手作为确定性同步点：收到「HTTP/1.1 100 Continue」即证明服务端已解析完头部、
      // 进入 readBody（error 监听已挂接），此刻断开必落入 req 'error' 分支而非连接建立前失败。
      const sawContinue = await new Promise<boolean>((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port: handle.port });
        sock.once('error', reject);
        sock.once('connect', () => {
          sock.write(
            `POST /api/tasks HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nAuthorization: Bearer ${token}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 64\r\nExpect: 100-continue\r\n\r\n',
          );
        });
        sock.once('data', (buf: Buffer) => {
          const ok = buf.toString('latin1').includes('100 Continue');
          sock.destroy(); // 头已到达、体未发送即中止
          resolve(ok);
        });
      });
      expect(sawContinue).toBe(true);
      // 服务仍可用：正常 GET 照常应答（中止分支未拖垮进程）
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: handle.port, path: '/api/tasks?limit=1', headers: { Authorization: `Bearer ${token}` } }, (r) => {
          r.resume();
          r.on('end', () => resolve({ status: r.statusCode ?? 0 }));
        }).on('error', reject);
      });
      expect(res.status).toBe(200);
    } finally {
      await stopPortalServer(handle);
    }
  });
});
