import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 第六十批（TASK-278 · 覆盖蓄量第一度）：纯测试加固，零 src 改动。
// 目标面（实测基线 4882/4929 语句的未覆盖子集，逐条实质断言）：
//  - agentsData：目录排序比较器（行 42）/ entryOf 形状防御（行 134）/ insightUiOf active 形状防御（行 149）/
//    reportUiOf 非对象（行 249）；
//  - approvalsView：detailCountdownMs 非法 timeoutAt → 0（行 71）/ 待办空态卡（行 107）；
//  - observeOverviewView：时间线空态「暂无动态」（行 69）；
//  - approvalDetailPage：401 后 authFailed 短路 refresh（行 32）/ 写门在途重复提交忽略（行 56）；
//  - approvalsPage：401 后 view-all 切换短路 refresh（行 61）/ asRows 数组过滤（行 23）；
//  - taskDetailPage：copy-id 剪贴板复制（行 134）；
//  - main.ts：DEFAULT_TIMER_HOST.clear（探针轮询可见性暂停，行 38）/ confirmBox 缺省回退 win.confirm（行 127）；
//  - mcp/client.ts：StdioMcpTransport.close 优雅退出 + 重复 close 短路（行 139/141）+ 3s 宽限超限强杀升级；
//  - portal/server.ts：POST 请求体 > 1 MiB → 413 payload_too_large（行 387）；
//  - runtime/executor.ts：native 策略 resume 批次 emit_output 提交（行 206）。

import { agentCatalogRows, insightUiOf, reportUiOf } from '../src/portal/ui/agentsData.js';
import { approvalsPageHtml, detailCountdownMs, type ApprovalListRow } from '../src/portal/ui/approvalsView.js';
import { observeOverviewHtml } from '../src/portal/ui/observeOverviewView.js';
import { mountApprovalDetailPage } from '../src/portal/ui/approvalDetailPage.js';
import { mountApprovalsPage } from '../src/portal/ui/approvalsPage.js';
import { mountTaskDetailPage } from '../src/portal/ui/taskDetailPage.js';
import { boot } from '../src/portal/ui/main.js';
import { StdioMcpTransport } from '../src/mcp/client.js';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { startPortalServer, stopPortalServer, type PortalHandle } from '../src/portal/server.js';
import { AUTH_EXPIRED_TEXT } from '../src/portal/ui/errors.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import type { TimerHost } from '../src/portal/ui/poll.js';
import { makeHarness, registerL3Tool, registerAndRelease, approvalSpec, validInput, validOutput } from './helpers.js';
import {
  clickEvent,
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
} from './wp7-3-mount-stubs.js';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

function makeCtx(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
): { ctx: PageCtx; view: ReturnType<typeof stubViewEl>; doc: ReturnType<typeof stubDoc> } {
  const view = stubViewEl();
  const doc = stubDoc();
  const { host } = fakeTimerHost();
  return {
    ctx: {
      doc: doc as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: host,
      confirmBox: () => true,
      now: () => NOW,
    },
    view, doc,
  };
}

// ---------- agentsData 纯函数 ----------

describe('wp278 agentsData：形状防御与排序比较器', () => {
  it('agentCatalogRows 多 agentId → 排序比较器执行（未知 status 忽略、计数正确）', () => {
    const rows = agentCatalogRows(
      [{ agentId: 'beta-ag' }, { agentId: 'alpha-ag' }, { agentId: 'alpha-ag' }],
      [
        { agentId: 'gamma-ag', status: 'active' },
        { agentId: 'alpha-ag', status: 'candidate' },
        { agentId: 'beta-ag', status: 'unknown-status' }, // 非三枚举 → 忽略
      ],
    );
    expect(rows.map((r) => r.agentId)).toEqual(['alpha-ag', 'beta-ag', 'gamma-ag']); // 比较器双分支排序
    expect(rows[0]).toMatchObject({ candidate: 1, active: 0, retired: 0 });
    expect(rows[1]).toMatchObject({ candidate: 0, active: 0, retired: 0 }); // 未知 status 不计数
    expect(rows[2]).toMatchObject({ active: 1 });
  });

  it('insightUiOf：assertions.active 非对象 → null（形状防御）', () => {
    const bad = {
      generatedAt: '2026-11-01T00:00:00.000Z',
      declared: {},
      assertions: { active: 5, openCandidates: { total: 0, evidencePending: 0 } },
      behavior: { since: '', status: '', insufficientNote: null },
    };
    expect(insightUiOf(bad)).toBeNull();
  });

  it('insightUiOf：active.entries 混入 statement 非字符串条目 → 该条目剔除（entryOf 防御）', () => {
    const ok = insightUiOf({
      generatedAt: '2026-11-01T00:00:00.000Z',
      versionId: 'ver-1',
      declared: { agentId: 'ag-1' },
      assertions: {
        active: {
          counts: { capability: 2, limitation: 0 },
          entries: [
            { capabilityId: 'cap-1', kind: 'capability', statement: '可执行只读分析', origin: 'declared', evidenceCount: 2 },
            { capabilityId: 'cap-2', kind: 'limitation', statement: 123, origin: 'declared' }, // statement 非字符串 → 剔除
          ],
        },
        openCandidates: { total: 0, evidencePending: 0 },
        emptyHint: null,
      },
      behavior: { since: '2026-11-01', status: 'insufficient', insufficientNote: null },
    });
    expect(ok).not.toBeNull();
    expect(ok!.activeEntries).toHaveLength(1);
    expect(ok!.activeEntries[0]).toMatchObject({ capabilityId: 'cap-1', evidenceCount: 2 });
  });

  it('reportUiOf：非对象输入 → null（形状防御）', () => {
    expect(reportUiOf('not-a-record')).toBeNull();
    expect(reportUiOf(null)).toBeNull();
  });
});

// ---------- approvalsView / observeOverviewView 纯函数 ----------

describe('wp278 观测与审批视图：空态与倒计时边界', () => {
  it('detailCountdownMs：timeoutAt 非法日期 → 0（不假装计算）', () => {
    expect(detailCountdownMs('not-a-date', NOW)).toBe(0);
    expect(detailCountdownMs('2026-11-01T12:10:00.000Z', NOW)).toBe(10 * 60_000); // 对照：合法日期正常计算
  });

  it('approvalsPageHtml：待办视图空列表 → 「暂无待办审批」空态卡', () => {
    const html = approvalsPageHtml({ mode: 'pending', rows: [], page: 0, pageCount: 1, decisionFilter: null, feedback: null, now: NOW });
    expect(html).toContain('暂无待办审批');
  });

  it('observeOverviewHtml：时间线为空 → 「暂无动态」空态卡', () => {
    const html = observeOverviewHtml({
      taskCounts: { created: 0, queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0 },
      taskTotal: 0,
      taskTotalAll: 0,
      successRate: null,
      pendingCount: 0,
      oldestPending: '',
      capabilityCounts: { candidate: 0, active: 0, retired: 0 },
      timeline: [],
      loading: false,
      now: NOW,
    });
    expect(html).toContain('暂无动态');
  });
});

// ---------- approvalDetailPage / approvalsPage / taskDetailPage 控制器 ----------

const approvalDetailBody = {
  request: {
    requestId: 'req-27800001', taskId: 'task-27800001', agentVersionId: 'ver-278', toolId: 'l3-op', riskLevel: 'L3',
    requestedAt: '2026-11-01T11:00:00.000Z', decision: 'pending', decidedAt: null,
    timeoutAt: '2026-11-01T13:00:00.000Z', callRef: '1',
  },
  binding: { agentVersionId: 'ver-278', contentHash: 'hash-278', snapshotBytes: 128 },
  snapshot: { savedAt: '2026-11-01T11:00:01.000Z', contextBytes: 96 },
  argsDigest: 'digest-278',
};

describe('wp278 approvalDetailPage：401 短路与写门互斥', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-278' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('挂载即 401 → authFailed；随后 approve 成功反馈，但收尾 refresh 短路（不再重拉详情）', async () => {
    let approvalGets = 0;
    const posts: string[] = [];
    const { ctx, view } = makeCtx(async (p, init) => {
      if (init?.method === 'POST') { posts.push(p); return jsonResponse({ ok: true }); }
      if (p.startsWith('/api/approvals/')) { approvalGets += 1; return approvalGets === 1 ? jsonResponse({ ok: false }, 401) : jsonResponse(approvalDetailBody); }
      return jsonResponse({ status: 'paused', taskId: 'task-27800001' });
    });
    const handle = mountApprovalDetailPage(ctx, 'req-27800001');
    await vi.waitFor(() => expect(view.innerHTML).toContain(AUTH_EXPIRED_TEXT));
    expect(approvalGets).toBe(1);
    view.listeners.get('click')![0](clickEvent({ action: 'approve' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/approvals/req-27800001/approve']));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(approvalGets).toBe(2); // 挂载 401 + decide 前置重查各一次；authFailed 短路收尾 refresh（无第 3 次）
    expect(view.innerHTML).toContain(AUTH_EXPIRED_TEXT); // 短路路径不重渲——写反馈不覆盖登录态错误面
    handle.destroy();
  });

  it('写门互斥：approve 在途时 deny 点击被忽略（无第二次 POST）', async () => {
    let releaseFresh: (r: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => { releaseFresh = resolve; });
    let approvalGets = 0;
    const posts: string[] = [];
    const { ctx, view } = makeCtx(async (p, init) => {
      if (init?.method === 'POST') { posts.push(p); return jsonResponse({ ok: true }); }
      if (p.startsWith('/api/approvals/')) {
        approvalGets += 1;
        return approvalGets === 1 ? gate : jsonResponse(approvalDetailBody);
      }
      return jsonResponse({ status: 'paused', taskId: 'task-27800001' });
    });
    const handle = mountApprovalDetailPage(ctx, 'req-27800001');
    await vi.waitFor(() => expect(view.innerHTML).toContain('加载中'));
    const click = view.listeners.get('click')![0];
    click(clickEvent({ action: 'approve' })); // 占住写门（fresh GET 挂起）
    click(clickEvent({ action: 'deny' })); // 在途 → 互斥忽略
    releaseFresh(jsonResponse(approvalDetailBody));
    await vi.waitFor(() => expect(posts).toEqual(['/api/approvals/req-27800001/approve']));
    await vi.waitFor(() => expect(view.innerHTML).toContain('已批准'));
    expect(posts).toHaveLength(1); // deny 未产生第二次 POST
    handle.destroy();
  });
});

describe('wp278 approvalsPage：401 短路与响应形状过滤', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-278' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('挂载即 401 → authFailed；切「全部决议」视图短路（不再发请求）', async () => {
    const gets: string[] = [];
    const { ctx, view } = makeCtx(async (p) => { gets.push(p); return jsonResponse({ ok: false }, 401); });
    const handle = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain(AUTH_EXPIRED_TEXT));
    expect(gets).toEqual(['/api/approvals?pending=true']);
    view.listeners.get('click')![0](clickEvent({ action: 'view-all' })); // mode 变更触发 refresh → authFailed 短路
    await Promise.resolve(); await Promise.resolve();
    expect(gets).toHaveLength(1); // 短路：无新请求
    handle.destroy();
  });

  it('响应为裸数组混入非对象条目 → asRows 过滤后仅渲染合法行', async () => {
    const row: ApprovalListRow = {
      requestId: 'req-27800002', taskId: 'task-27800002', toolId: 'l3-op', decision: 'pending',
      requestedAt: '2026-11-01T11:00:00.000Z', timeoutAt: '2026-11-01T13:00:00.000Z', callRef: '1',
      agentVersionId: 'ver-278', contentHash: 'hash-278', taskStatus: 'paused', timeoutRemainingMs: 60 * 60_000,
    };
    const { ctx, view } = makeCtx(async () => jsonResponse([row, { junk: true }, null]));
    const handle = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-27800002'));
    expect(view.innerHTML).toContain('待办审批');
    handle.destroy();
  });
});

describe('wp278 taskDetailPage：copy-id 复制', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-278' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('点击「复制」→ navigator.clipboard.writeText 收到任务 ID', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } });
    const taskBody = {
      taskId: 'task-27800009', agentId: 'ag-1', agentVersionId: 'ver-1', input: '{"topic":"t"}', status: 'paused',
      attemptCount: 0, modelCallCount: 1, tokensUsed: 10, createdAt: '2026-11-01T11:00:00.000Z',
      endedAt: null, cancelReason: null, parentTaskId: null,
    };
    const { ctx, view } = makeCtx(async (p) => jsonResponse(
      p.endsWith('/events') ? [] : p.endsWith('/evidence') ? { refs: [] } : p.includes('limit=100') ? { tasks: [], total: 0 } : taskBody,
    ));
    const handle = mountTaskDetailPage(ctx, 'task-27800009');
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-27800009'));
    view.listeners.get('click')![0](clickEvent({ action: 'copy-id', id: 'task-27800009' }));
    expect(copied).toEqual(['task-27800009']);
    handle.destroy();
  });
});

// ---------- main.ts boot：缺省回退路径 ----------

interface BootEl { id: string; innerHTML: string; textContent: string; value: string; className: string; dataset: Record<string, string>; listeners: Map<string, Array<(ev?: unknown) => void>>; addEventListener(t: string, f: (ev?: unknown) => void): void; removeEventListener(t: string, f: (ev?: unknown) => void): void; }

function bootStubElement(id: string, dataset: Record<string, string> = {}): BootEl {
  const el: BootEl = {
    id, innerHTML: '', textContent: '', value: '', className: '', dataset: { ...dataset }, listeners: new Map(),
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { const arr = el.listeners.get(type) ?? []; el.listeners.set(type, arr.filter((f) => f !== fn)); },
  };
  return el;
}

function bootStubDoc() {
  const byId = new Map<string, BootEl>();
  const navEls: BootEl[] = [];
  const docListeners = new Map<string, Array<() => void>>();
  const doc = {
    hidden: false,
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (sel: string) => (sel.includes('data-nav') ? [...navEls] : []),
    addEventListener: (t: string, f: () => void) => { docListeners.set(t, [...(docListeners.get(t) ?? []), f]); },
    removeEventListener: (t: string, f: () => void) => { const arr = docListeners.get(t) ?? []; docListeners.set(t, arr.filter((x) => x !== f)); },
  };
  return {
    doc, docListeners,
    reg(id: string, dataset: Record<string, string> = {}): BootEl { const el = bootStubElement(id, dataset); byId.set(id, el); return el; },
    regNav(key: string): BootEl { const el = bootStubElement(`nav-${key}`, { nav: key }); navEls.push(el); return el; },
  };
}

describe('wp278 main.ts boot：缺省定时器宿主与确认框回退', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub());
    vi.stubGlobal('location', { hash: '#/nope', pathname: '/', search: '', replace: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('不注入 timerHost → 探针用 DEFAULT_TIMER_HOST；页面隐藏 → clearTimeout 撤销在途探针拍', () => {
    const shell = bootStubDoc();
    shell.reg('view');
    const win = { addEventListener: () => {}, confirm: () => true };
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      boot({ document: shell.doc as unknown as Document, window: win as unknown as Window, probeIntervalMs: 60_000 });
      expect(setSpy).toHaveBeenCalled(); // 探针首拍经缺省宿主排程（真实 setTimeout）
      shell.doc.hidden = true;
      shell.docListeners.get('visibilitychange')![0](); // 不可见暂停 → 缺省宿主 clear（行 38）
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('不注入 confirmBox → 任务页取消走 win.confirm 回退，确认后 POST /cancel', async () => {
    const shell = bootStubDoc();
    const view = shell.reg('view');
    shell.regNav('tasks');
    vi.stubGlobal('location', { hash: '#/tasks', pathname: '/', search: '', replace: vi.fn() });
    const confirmTexts: string[] = [];
    const win = { addEventListener: () => {}, confirm: (t: string) => { confirmTexts.push(t); return true; } };
    const posts: string[] = [];
    const listBody = { tasks: [{ taskId: 'task-27800010', agentId: 'ag-1', agentVersionId: 'ver-1', status: 'paused', createdAt: new Date().toISOString(), endedAt: null, attemptCount: 0, modelCallCount: 0, tokensUsed: 0 }], total: 1 };
    const fetchImpl = async (p: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') { posts.push(p); return jsonResponse({ ok: true, mode: 'graceful' }); }
      return jsonResponse(listBody);
    };
    const { host } = fakeTimerHost();
    boot({ document: shell.doc as unknown as Document, window: win as unknown as Window, fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: host as unknown as TimerHost });
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-27800010'));
    view.listeners.get('click')![0](clickEvent({ action: 'cancel', 'task-id': 'task-27800010', 'task-status': 'paused' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/tasks/task-27800010/cancel']));
    expect(confirmTexts).toHaveLength(1); // 缺省回退：ctx.confirmBox = win.confirm（行 127）
    await vi.waitFor(() => expect(view.innerHTML).toContain('取消成功'));
  });
});

// ---------- StdioMcpTransport.close ----------

describe('wp278 StdioMcpTransport.close：优雅退出与宽限超限强杀', () => {
  it('子进程随 stdin 结束退出 → close() 如期收敛；重复 close 幂等短路', { timeout: 20_000 }, async () => {
    const t = new StdioMcpTransport(process.execPath, ['-e', 'process.stdin.on("end", () => process.exit(0))']);
    await expect(t.close()).resolves.toBeUndefined(); // stdin.end → 子进程退出 → exit 事件收敛
    await expect(t.close()).resolves.toBeUndefined(); // 已 closed → 幂等短路（行 139）
  });

  it('子进程忽略 stdin 结束 → 3s 宽限超限后强杀（kill 升级），close() 才收敛', { timeout: 20_000 }, async () => {
    const t = new StdioMcpTransport(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.stdin.resume();']);
    const startedAt = Date.now();
    await expect(t.close()).resolves.toBeUndefined(); // 仅 kill 升级可令其退出——收敛即强杀生效（行 141 定时器臂）
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2500); // 确经宽限窗，而非子进程自行退出
  });
});

// ---------- portal/server.ts 413 ----------

describe('wp278 portal server：POST 请求体超 1 MiB → 413 payload_too_large', () => {
  it('POST /api/tasks 携带 1MiB+1 字节合法 JSON 头 → 413（读取上限防御）', { timeout: 20_000 }, async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-wp278-srv-'));
    const rt = Runtime.withProvider(new MockProvider([]), ['mock-model'], dataDir, process.cwd());
    rt.startup('test');
    const handle: PortalHandle = await startPortalServer(rt, { dataDir, repoRoot: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token-0000000000000000000000000000' });
    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: handle.port, method: 'POST', path: '/api/tasks',
          headers: { Authorization: `Bearer test-token-0000000000000000000000000000`, 'Content-Type': 'application/json' },
        }, (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.write('x'.repeat(1024 * 1024 + 1));
        req.end();
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'payload_too_large' });
      expect(JSON.parse(res.body).message).toContain('1 MiB');
    } finally {
      await stopPortalServer(handle);
    }
  });
});

// ---------- executor.ts:206 native resume 批次 emit_output ----------

describe('wp278 executor：native 策略 resume 批次内 emit_output 提交（行 206）', () => {
  it('批次 [l3-op(挂起), emit_output] → 批准续跑：l3-op 放行后 emit_output 提交 → Succeeded', async () => {
    const h = makeHarness([{
      kind: 'tool_use',
      calls: [
        { id: 'a1', toolId: 'l3-op', args: { target: 'x' } },
        { id: 'e1', toolId: 'emit_output', args: validOutput() },
      ],
    }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('wp278-native-resume'));
    const taskId = h.rt.tasks.createTask('wp278-native-resume', validInput, 't');
    const paused = await h.rt.tasks.runTask(taskId, 'native'); // 首拍：l3-op 未批准 → 挂起（emit_output 未执行）
    expect(paused.status).toBe('paused');
    const pending = h.rt.approvals.pendingForTask(taskId);
    expect(pending).not.toBeNull();
    h.rt.approvals.approve(pending!.requestId, 'human');
    const row = await h.rt.tasks.runTask(taskId, 'native', { resume: true }); // 续跑批次：l3-op 放行 → emit_output 命中提交
    expect(row.status).toBe('succeeded');
    expect(h.rt.approvals.pendingForTask(taskId)).toBeNull(); // 无残留待办
    expect(h.rt.approvals.getSnapshot(taskId)).toBeNull(); // 快照已随离 Paused 清理
  });
});
