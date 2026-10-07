import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountTasksPage } from '../src/portal/ui/tasksPage.js';
import { mountTaskDetailPage } from '../src/portal/ui/taskDetailPage.js';
import { mountApprovalsPage } from '../src/portal/ui/approvalsPage.js';
import { mountApprovalDetailPage } from '../src/portal/ui/approvalDetailPage.js';
import type { TimerHost } from '../src/portal/ui/poll.js';
import { ds } from '../src/portal/ui/pageCtx.js';

// 第七阶段批次二（7-2/4）：页面控制器边路分支补测——
// 分页翻页、清除筛选、resume 日志展开、事件过滤勾选、input 折叠展开、复制 ID、
// 404/401 错误出口、visibility 暂停、destroy 清理、非 JSON 响应体兜底（覆盖率单调门）。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function fakeTimerHost() {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const host: TimerHost = {
    set: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn: () => {
        const i = timers.findIndex((x) => x.id === id);
        if (i >= 0) timers.splice(i, 1);
        fn();
      }, ms, id });
      return id;
    },
    clear: (h: unknown) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return { host, timers };
}

interface FakeEl {
  attributes: Record<string, boolean>;
  removeAttribute(k: string): void;
  setAttribute(k: string, _v: string): void;
}

function stubViewEl() {
  const el = {
    innerHTML: '',
    listeners: new Map<string, Array<(ev?: unknown) => void>>(),
    _fake: { removeAttribute: function (this: FakeEl & { attributes: Record<string, boolean> }, k: string) { this.attributes[k] = false; }, setAttribute: function (this: FakeEl & { attributes: Record<string, boolean> }, k: string) { this.attributes[k] = true; }, attributes: {} as Record<string, boolean> } as FakeEl,
    querySelector: (sel: string) => (sel ? (el._fake as unknown as HTMLElement) : null),
    addEventListener(type: string, fn: (ev?: unknown) => void) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type: string, fn: (ev?: unknown) => void) { const a = el.listeners.get(type) ?? []; el.listeners.set(type, a.filter((f) => f !== fn)); },
  };
  return el;
}

function stubDoc() {
  const listeners = new Map<string, Array<(ev?: unknown) => void>>();
  return {
    hidden: false,
    addEventListener: (t: string, f: (ev?: unknown) => void) => { listeners.set(t, [...(listeners.get(t) ?? []), f]); },
    removeEventListener: (t: string, f: (ev?: unknown) => void) => { const a = listeners.get(t) ?? []; listeners.set(t, a.filter((x) => x !== f)); },
    listeners,
  } as unknown as Document & { listeners: Map<string, Array<(ev?: unknown) => void>> };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function clickEvent(dataset: Record<string, string>) {
  return {
    preventDefault: () => {},
    target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset } : null) },
  };
}

function makePage(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>, confirmBox: (t: string) => boolean = () => true) {
  const view = stubViewEl();
  const doc = stubDoc();
  const timersHost = fakeTimerHost();
  const ctx = {
    doc: doc as unknown as Document,
    view: view as unknown as HTMLElement,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    timerHost: timersHost.host,
    confirmBox,
    now: () => NOW,
  };
  return { ctx, view, doc, timers: timersHost.timers };
}

const taskRow = {
  taskId: 'task-aaaabbbbccccdddd', agentId: 'ag-1', agentVersionId: 'ver-9', specContentHash: 'h',
  input: JSON.stringify({ goal: 'x' }, null, 2), status: 'paused', attemptCount: 1, modelCallCount: 3,
  tokensUsed: 98765, consecutiveDenialCount: 0, createdAt: '2026-10-01T10:00:00.000Z', startedAt: null,
  endedAt: null, traceFile: 't.jsonl', terminalFailureClass: null, abortRequested: 0, pausedDurationMs: 0,
  cancelReason: null, assignmentSource: null, parentTaskId: null, delegationDepth: 0,
};

const listBody = { tasks: [{ ...taskRow, status: 'queued' }, { ...taskRow, taskId: 'task-ccccdddd' }], total: 2 };

beforeEach(() => {
  const map = new Map<string, string>();
  map.set('shanhai-portal-token', 'tok-e');
  vi.stubGlobal('sessionStorage', {
    get length() { return map.size; }, clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null, key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); }, setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage);
  vi.stubGlobal('location', { hash: '#/tasks' });
});
afterEach(() => vi.unstubAllGlobals());

describe('7-2 tasksPage 边路分支', () => {
  it('清除筛选按钮 → hash 回 #/tasks 且 range=all（空态出口）', async () => {
    const { ctx, view } = makePage(async () => jsonResponse({ tasks: [], total: 0 }));
    const handle = mountTasksPage(ctx, { status: 'running' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('当前筛选无任务'));
    view.listeners.get('click')![0](clickEvent({ action: 'clear-filters' }));
    expect(location.hash).toBe('#/tasks');
    handle.destroy();
  });

  it('page-prev 在第 0 页为 no-op（不重拉）', async () => {
    let reads = 0;
    const { ctx, view } = makePage(async () => { reads++; return jsonResponse(listBody); });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    const before = reads;
    view.listeners.get('click')![0](clickEvent({ action: 'page-prev' }));
    expect(reads).toBe(before);
    handle.destroy();
  });

  it('resume 成功后「查看续跑日志」→ GET resume-log 展示内容', async () => {
    const { ctx, view } = makePage(async (path, init) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', spawned: true, resumedBy: 'manual-resume', pid: 1, logFile: 'd/r.log' });
      if (path.endsWith('/resume-log')) return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', logFile: 'd/r.log', content: 'LINE-1\nLINE-2', truncated: false });
      return jsonResponse(listBody);
    });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickEvent({ action: 'resume', 'task-id': 'task-aaaabbbbccccdddd' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('查看续跑日志'));
    view.listeners.get('click')![0](clickEvent({ action: 'view-resume-log', 'task-id': 'task-aaaabbbbccccdddd' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('LINE-1'));
    handle.destroy();
  });

  it('读面网络失败（非 401）：保留初始壳不炸，轮询照常排程', async () => {
    const { ctx, view, timers } = makePage(async () => { throw new TypeError('Failed to fetch'); });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('任务列表')); // 初始壳保留，不崩溃
    expect(timers.every((t) => t.ms === 5_000)).toBe(true); // 失败不终止轮询（§11-3 连接指示另行呈现）
    handle.destroy();
  });
});

describe('7-2 taskDetailPage 边路分支', () => {
  function detailCtx(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>) {
    return makePage(fetchImpl);
  }

  const defaultFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', spawned: true, resumedBy: 'manual-resume', pid: 2, logFile: 'd/x.log' });
    if (path.endsWith('/events')) return jsonResponse([{ eventId: 'e-1', eventType: 'task_created', timestamp: '2026-10-01T10:00:00.000Z', callNo: 0, callKind: null, attemptNo: 1 }]);
    if (path.endsWith('/evidence')) return jsonResponse({ ok: true, refs: [] });
    if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [], total: 0 });
    return jsonResponse(taskRow);
  };

  it('复制 ID：点击不炸（clipboard 缺省环境兜底）', async () => {
    const { ctx, view } = detailCtx(defaultFetch);
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('任务信息'));
    expect(() => view.listeners.get('click')![0](clickEvent({ action: 'copy-id', id: 'task-aaaabbbbccccdddd' }))).not.toThrow();
    handle.destroy();
  });

  it('事件类型勾选过滤：取消勾选后该类型行消失', async () => {
    const { ctx, view } = detailCtx(defaultFetch);
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('task_created'));
    view.listeners.get('change')![0]({ preventDefault: () => {}, target: { dataset: { 'event-type': 'task_created' }, checked: false } });
    await vi.waitFor(() => expect(view.innerHTML).not.toContain('>task_created</td>'));
    handle.destroy();
  });

  it('任务不存在（404）：错误态 + 返回列表出口', async () => {
    const fetchImpl = async (path: string): Promise<Response> => {
      if (path.endsWith('/events') || path.endsWith('/evidence')) return jsonResponse([]);
      if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse({ ok: false, code: 'not_found', message: '任务不存在' }, 404);
    };
    const { ctx, view, timers } = detailCtx(fetchImpl);
    const handle = mountTaskDetailPage(ctx, 'task-none');
    await vi.waitFor(() => expect(view.innerHTML).toContain('任务不存在'));
    expect(view.innerHTML).toContain('#/tasks');
    expect(timers).toHaveLength(0); // 404 即停轮询
    handle.destroy();
  });

  it('读面 401：登录状态失效提示（去技术化，TASK-128）并停轮询', async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401);
    const { ctx, view, timers } = detailCtx(fetchImpl);
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('登录状态已失效'));
    expect(timers).toHaveLength(0);
    handle.destroy();
  });

  it('visibilitychange 不可见暂停轮询', async () => {
    const { ctx, view, timers, doc } = detailCtx(defaultFetch);
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('任务信息'));
    expect(timers.every((t) => t.ms === 3_000)).toBe(true);
    (doc.listeners.get('visibilitychange')![0] as (ev?: unknown) => void)({ target: { hidden: true } } as unknown as Event);
    expect(timers).toHaveLength(0);
    handle.destroy();
  });
});

describe('7-2 approvalsPage 边路分支', () => {
  const rows = [{ requestId: 'req-1', taskId: 't-1', toolId: 'tool', decision: 'pending', requestedAt: '2026-10-01T11:00:00.000Z', timeoutAt: '2026-10-01T12:10:00.000Z', callRef: 'c1', agentVersionId: 'v', contentHash: 'h', taskStatus: 'paused', timeoutRemainingMs: 600000 }];

  it('前端分页翻页（>20 行）与 destroy 清理', async () => {
    const big = Array.from({ length: 25 }, (_, i) => ({ ...rows[0], requestId: `req-${String(i).padStart(3, '0')}` }));
    const { ctx, view, timers } = makePage(async () => jsonResponse(big));
    const handle = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-000'));
    expect(view.innerHTML).toContain('第 1 / 2 页');
    view.listeners.get('click')![0](clickEvent({ action: 'page-next' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('第 2 / 2 页'));
    view.listeners.get('click')![0](clickEvent({ action: 'page-prev' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('第 1 / 2 页'));
    handle.destroy();
    expect(timers).toHaveLength(0);
  });

  it('同视图重复点击不重拉；读面 401 停轮询', async () => {
    let reads = 0;
    const { ctx, view, timers } = makePage(async () => { reads++; return jsonResponse(rows); });
    const handle = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-1'));
    view.listeners.get('click')![0](clickEvent({ action: 'view-pending' })); // 同模式 no-op
    expect(reads).toBe(1);
    handle.destroy();

    const { ctx: c2, view: v2, timers: t2 } = makePage(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401));
    const h2 = mountApprovalsPage(c2, {});
    await vi.waitFor(() => expect(v2.innerHTML).toContain('登录状态已失效'));
    expect(t2).toHaveLength(0);
    h2.destroy();
  });
});

describe('7-2 approvalDetailPage 边路分支', () => {
  const showBody = {
    request: { requestId: 'req-1', taskId: 't-1', agentVersionId: 'v', toolId: 'tool', riskLevel: 'L1', requestedAt: '2026-10-01T11:00:00.000Z', decision: 'pending', decidedAt: null, timeoutAt: '2026-10-01T12:10:00.000Z', callRef: 'c1' },
    binding: { agentVersionId: 'v', contentHash: 'h', snapshotBytes: 10 },
    snapshot: { savedAt: '2026-10-01T11:00:01.000Z', contextBytes: 20 },
    argsDigest: 'abc',
  };

  it('审批不存在（404）：错误态 + 返回列表出口', async () => {
    const { ctx, view } = makePage(async (path) => (path.startsWith('/api/approvals') ? jsonResponse({ ok: false, code: 'not_found', message: '审批请求不存在' }, 404) : jsonResponse({ status: 'paused' })));
    const handle = mountApprovalDetailPage(ctx, 'req-none');
    await vi.waitFor(() => expect(view.innerHTML).toContain('审批请求不存在'));
    expect(view.innerHTML).toContain('#/approvals');
    handle.destroy();
  });

  it('读面 401：登录状态失效提示（去技术化，TASK-128）', async () => {
    const { ctx, view } = makePage(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401));
    const handle = mountApprovalDetailPage(ctx, 'req-1');
    await vi.waitFor(() => expect(view.innerHTML).toContain('登录状态已失效'));
    handle.destroy();
  });

  it('approve 成功流：提交前重查仍 pending → POST → 反馈 + 刷新', async () => {
    const posts: string[] = [];
    let decision = 'pending';
    const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') { posts.push(path); decision = 'approved'; return jsonResponse({ ok: true, requestId: 'req-1', taskId: 't-1', decision: 'approved', taskStatus: 'paused' }); }
      if (path.startsWith('/api/tasks/')) return jsonResponse({ status: 'paused' });
      return jsonResponse({ ...showBody, request: { ...showBody.request, decision, decidedAt: decision === 'approved' ? '2026-10-01T11:30:00.000Z' : null } });
    };
    const { ctx, view } = makePage(fetchImpl);
    const handle = mountApprovalDetailPage(ctx, 'req-1');
    await vi.waitFor(() => expect(view.innerHTML).toContain('决议操作'));
    view.listeners.get('click')![0](clickEvent({ action: 'approve' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/approvals/req-1/approve']));
    await vi.waitFor(() => expect(view.innerHTML).toContain('已批准（approve 只写决议，任务保持挂起）'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('shanhai task run t-1 --resume --resumed-by manual-resume'));
    handle.destroy();
  });

  it('断网（post 抛/网络归一）：红条断网文案', async () => {
    const { ctx, view } = makePage(async (path, init) => {
      if (init?.method === 'POST') throw new TypeError('Failed to fetch');
      if (path.startsWith('/api/tasks/')) return jsonResponse({ status: 'paused' });
      return jsonResponse(showBody);
    });
    const handle = mountApprovalDetailPage(ctx, 'req-1');
    await vi.waitFor(() => expect(view.innerHTML).toContain('决议操作'));
    view.listeners.get('click')![0](clickEvent({ action: 'approve' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('连接断开，操作结果未知——刷新核对后重试'));
    handle.destroy();
  });
});

describe('7-2 taskDetailPage 写操作与折叠展开', () => {
  it('detail 取消（queued）：confirm 文案逐字（cancelModeFor 非 running hint）→ POST → 反馈', async () => {
    const confirms: string[] = [];
    const posts: string[] = [];
    const { ctx, view } = makePage(async (path, init) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', mode: 'graceful', note: 'n' }); }
      if (path.endsWith('/events')) return jsonResponse([]);
      if (path.endsWith('/evidence')) return jsonResponse({ ok: true, refs: [] });
      if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse({ ...taskRow, status: 'queued' });
    }, (t) => { confirms.push(t); return true; });
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('任务信息'));
    view.listeners.get('click')![0](clickEvent({ action: 'cancel', 'task-id': 'task-aaaabbbbccccdddd', 'task-status': 'queued' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/tasks/task-aaaabbbbccccdddd/cancel']));
    expect(confirms).toEqual(['queued/paused 立即取消（既有 CAS 语义）；paused 取消将连带 pending 审批作废']);
    await vi.waitFor(() => expect(view.innerHTML).toMatch(/feedback--success/));
    handle.destroy();
  });

  it('detail 崩溃恢复（滞留 running）：全局端点 + 超危确认文案', async () => {
    const confirms: string[] = [];
    const posts: string[] = [];
    const staleRow = { ...taskRow, status: 'running', createdAt: new Date(NOW - 11 * 60_000).toISOString() };
    const { ctx, view } = makePage(async (path, init) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({ ok: true, report: {} }); }
      if (path.endsWith('/events')) return jsonResponse([]);
      if (path.endsWith('/evidence')) return jsonResponse({ ok: true, refs: [] });
      if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [staleRow], total: 1 });
      return jsonResponse(staleRow);
    }, (t) => { confirms.push(t); return true; });
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('显式崩溃恢复'));
    view.listeners.get('click')![0](clickEvent({ action: 'crash-recovery' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/portal/crash-recovery']));
    expect(confirms[0]).toContain('将把所有 Running 任务（当前 1 个）标记为 Failed(CrashRecovery)');
    handle.destroy();
  });

  it('长 input 折叠 + 展开全部点击路径', async () => {
    const longRow = { ...taskRow, input: Array.from({ length: 80 }, (_, i) => `"k${i}": "v${i}"`).join('\n') };
    const fetchImpl = async (path: string): Promise<Response> => {
      if (path.endsWith('/events')) return jsonResponse([]);
      if (path.endsWith('/evidence')) return jsonResponse({ ok: true, refs: [] });
      if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse(longRow);
    };
    const { ctx, view } = makePage(fetchImpl);
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('展开全部'));
    view.listeners.get('click')![0]({
      preventDefault: () => {},
      target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'expand-input' } } : null), setAttribute: () => {} },
    });
    handle.destroy();
  });

  it('detail resume 后查看续跑日志（读取失败路径含分类文案）', async () => {
    const { ctx, view } = makePage(async (path, init) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', spawned: true, resumedBy: 'manual-resume', pid: 3, logFile: 'd/y.log' });
      if (path.endsWith('/resume-log')) return jsonResponse({ ok: false, code: 'not_found', message: '该任务无 resume 日志' }, 404);
      if (path.endsWith('/events')) return jsonResponse([]);
      if (path.endsWith('/evidence')) return jsonResponse({ ok: true, refs: [] });
      if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse(taskRow);
    });
    const handle = mountTaskDetailPage(ctx, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('任务信息'));
    view.listeners.get('click')![0](clickEvent({ action: 'resume', 'task-id': 'task-aaaabbbbccccdddd' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('查看续跑日志'));
    view.listeners.get('click')![0](clickEvent({ action: 'view-resume-log', 'task-id': 'task-aaaabbbbccccdddd' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('续跑日志读取失败'));
    handle.destroy();
  });
});

describe('7-2 approvalsPage 视图切换与可见性', () => {
  const rows = [{ requestId: 'req-1', taskId: 't-1', toolId: 'tool', decision: 'pending', requestedAt: '2026-10-01T11:00:00.000Z', timeoutAt: '2026-10-01T12:10:00.000Z', callRef: 'c1', agentVersionId: 'v', contentHash: 'h', taskStatus: 'paused', timeoutRemainingMs: 600000 }];

  it('全部 → 待办往返切换（各触发一次重拉）；不可见暂停', async () => {
    const calls: string[] = [];
    const { ctx, view, timers, doc } = makePage(async (path) => { calls.push(path); return jsonResponse(rows); });
    const handle = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-1'));
    view.listeners.get('click')![0](clickEvent({ action: 'view-all' }));
    await vi.waitFor(() => expect(calls.filter((c) => c === '/api/approvals').length).toBeGreaterThan(0));
    view.listeners.get('click')![0](clickEvent({ action: 'view-pending' }));
    await vi.waitFor(() => expect(calls.filter((c) => c === '/api/approvals?pending=true').length).toBeGreaterThanOrEqual(2));
    (doc.listeners.get('visibilitychange')![0] as (ev?: unknown) => void)({ target: { hidden: true } } as unknown as Event);
    expect(timers).toHaveLength(0);
    handle.destroy();
  });
});

describe('7-2 approvalDetailPage FR-AD-5 拦截路径（按钮已渲染后竞态）', () => {
  it('初次 pending+paused 渲染按钮；点击时重查已 approved → 不 POST，提示已被处理', async () => {
    const posts: string[] = [];
    let showCalls = 0;
    const showBody = {
      request: { requestId: 'req-1', taskId: 't-1', agentVersionId: 'v', toolId: 'tool', riskLevel: 'L1', requestedAt: '2026-10-01T11:00:00.000Z', decision: 'pending', decidedAt: null, timeoutAt: '2026-10-01T12:10:00.000Z', callRef: 'c1' },
      binding: null, snapshot: null, argsDigest: null,
    };
    const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({}); }
      if (path.startsWith('/api/tasks/')) return jsonResponse({ status: 'paused' });
      showCalls += 1;
      if (showCalls === 1) return jsonResponse(showBody); // 首拉：pending + paused（按钮渲染）
      return jsonResponse({ ...showBody, request: { ...showBody.request, decision: 'approved', decidedAt: '2026-10-01T11:20:00.000Z' } }); // 重查：已被决议
    };
    const { ctx, view } = makePage(fetchImpl);
    const handle = mountApprovalDetailPage(ctx, 'req-1');
    await vi.waitFor(() => expect(view.innerHTML).toMatch(/data-action="deny"/));
    view.listeners.get('click')![0](clickEvent({ action: 'deny' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('该审批已被处理'));
    expect(posts).toHaveLength(0);
    handle.destroy();
  });
});

describe('7-2 ds（dataset 键驼峰/kebab 双态兼容——真实浏览器走查发现的缺陷回归钉）', () => {
  it('真实 DOM 驼化键（taskStatus）与测试桩 kebab 键（task-status）均可读', () => {
    expect(ds({ taskStatus: 'running' }, 'task-status')).toBe('running');
    expect(ds({ 'task-status': 'running' }, 'task-status')).toBe('running');
    expect(ds({ runningCount: '2' }, 'running-count')).toBe('2');
    expect(ds({ eventType: 'task_created' }, 'event-type')).toBe('task_created');
    expect(ds({}, 'task-id')).toBe('');
  });
});

describe('7-2 client 非 JSON 响应体兜底', () => {
  it('错误体非 JSON → unknown 码；成功体非 JSON → network 归一', async () => {
    const { apiGet } = await import('../src/portal/ui/client.js');
    const bad: unknown = { ok: false, status: 500, json: async () => { throw new SyntaxError('bad'); } };
    const r1 = await apiGet('/api/x', { fetchImpl: vi.fn(async () => bad) as unknown as typeof fetch, token: () => 't' });
    expect(r1).toMatchObject({ ok: false, status: 500, code: 'unknown' });
    const badOk: unknown = { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } };
    const r2 = await apiGet('/api/x', { fetchImpl: vi.fn(async () => badOk) as unknown as typeof fetch, token: () => 't' });
    expect(r2).toEqual({ ok: false, kind: 'network' });
  });
});
