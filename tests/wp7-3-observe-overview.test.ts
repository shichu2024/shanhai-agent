import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountObserveOverviewPage } from '../src/portal/ui/observeOverviewPage.js';
import { observeOverviewHtml, type OverviewModel } from '../src/portal/ui/observeOverviewView.js';
import {
  OBSERVE_CACHE_TTL_MS,
  createObserveCache,
  resetSharedObserveCache,
  sharedObserveCache,
} from '../src/portal/ui/observeCache.js';
import type { PortalCache } from '../src/portal/ui/cache.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import {
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
  type FakeTimer,
  type StubDoc,
  type StubEl,
} from './wp7-3-mount-stubs.js';

// 第七阶段批次三（7-3/4）：观测·总控（FR-O-1）——三块统计卡客户端聚合、合并时间线、
// 快速入口、轮询 5s 可见性暂停、全局数据缓存（页面切换 5s 内回来不重复拉取）。
// 明示：无 /api/stats 端点，三端点 = /api/tasks?limit=100 + /api/approvals?pending=true + /api/capabilities。
// TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

function taskRow(partial: Partial<Record<string, unknown>> & { taskId: string }): Record<string, unknown> {
  return {
    agentId: 'ag-1',
    status: 'queued',
    createdAt: '2026-10-01T10:00:00.000Z',
    endedAt: null,
    ...partial,
  };
}

function approvalRow(partial: Partial<Record<string, unknown>> & { requestId: string }): Record<string, unknown> {
  return {
    taskId: 'task-1',
    toolId: 'shell',
    decision: 'pending',
    requestedAt: '2026-10-01T11:00:00.000Z',
    timeoutAt: '2026-10-01T12:00:00.000Z',
    taskStatus: 'paused',
    timeoutRemainingMs: 600000,
    ...partial,
  };
}

function capRow(partial: Partial<Record<string, unknown>> & { capabilityId: string }): Record<string, unknown> {
  return {
    capabilityId: 'cap-1',
    agentId: 'ag-1',
    kind: 'capability',
    origin: 'derived',
    statement: 's',
    statementDigest: 'd',
    status: 'candidate',
    evidenceRefs: [],
    evidencePending: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    ...partial,
  };
}

function defaultBodies() {
  return {
    tasks: {
      tasks: [
        taskRow({ taskId: 'task-aaaabbbb', status: 'running', createdAt: '2026-10-01T11:50:00.000Z' }),
        taskRow({ taskId: 'task-ccccdddd', status: 'succeeded', createdAt: '2026-10-01T11:40:00.000Z' }),
        taskRow({ taskId: 'task-eeeeffff', status: 'cancelled', createdAt: '2026-10-01T11:30:00.000Z' }),
      ],
      total: 3,
    },
    approvals: [approvalRow({ requestId: 'req-11112222', requestedAt: '2026-10-01T11:00:00.000Z' })],
    capabilities: [capRow({ capabilityId: 'c1', status: 'candidate' }), capRow({ capabilityId: 'c2', status: 'active' })],
  };
}

type Bodies = ReturnType<typeof defaultBodies>;

function fetchFor(bodies: Bodies) {
  return async (path: string): Promise<Response> => {
    if (path === '/api/tasks?limit=100') return jsonResponse(bodies.tasks);
    if (path === '/api/approvals?pending=true') return jsonResponse(bodies.approvals);
    if (path === '/api/capabilities') return jsonResponse(bodies.capabilities);
    throw new Error(`未预期的请求：${path}`);
  };
}

interface Ctx {
  ctx: PageCtx;
  view: StubEl;
  doc: StubDoc;
  timers: FakeTimer[];
}

function makeCtx(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>, cache?: PortalCache, now: () => number = () => NOW): Ctx {
  const view = stubViewEl();
  const doc = stubDoc();
  const { host, timers } = fakeTimerHost();
  return {
    ctx: {
      doc: doc as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: host,
      confirmBox: () => true,
      now,
    },
    view, doc, timers,
  };
}

function cacheWithClock(at: { now: number }): PortalCache {
  return createObserveCache(() => at.now);
}

// ---------- 缓存（FR-O-1 本批新增设计） ----------

describe('7-3 观测全局缓存（页面切换 5s 内回来不重复拉取）', () => {
  it('TTL = 5s（「5s 内回来不重复拉取」判据）', () => {
    expect(OBSERVE_CACHE_TTL_MS).toBe(5_000);
  });

  it('TTL 内命中不重拉；过期后重拉；失败不落缓存', async () => {
    const clock = { now: NOW };
    const cache = cacheWithClock(clock);
    let fetches = 0;
    const fetcher = async (): Promise<string> => {
      fetches += 1;
      return `v${fetches}`;
    };
    await expect(cache.get('k', fetcher)).resolves.toBe('v1');
    await expect(cache.get('k', fetcher)).resolves.toBe('v1'); // TTL 内不重拉
    expect(fetches).toBe(1);
    clock.now = NOW + 5_001;
    await expect(cache.get('k', fetcher)).resolves.toBe('v2'); // 过期重拉
    expect(fetches).toBe(2);
    let rejectOnce = true;
    await expect(cache.get('bad', async (): Promise<string> => {
      if (rejectOnce) { rejectOnce = false; throw new Error('网络失败'); }
      return 'ok';
    })).rejects.toThrow('网络失败');
    await expect(cache.get('bad', async () => 'ok')).resolves.toBe('ok'); // 失败未落缓存
  });

  it('sharedObserveCache 单例：同实例复用；reset 后换新（测试隔离钩子）', () => {
    resetSharedObserveCache();
    const a = sharedObserveCache();
    expect(sharedObserveCache()).toBe(a);
    resetSharedObserveCache();
    expect(sharedObserveCache()).not.toBe(a);
    resetSharedObserveCache();
  });
});

// ---------- 总控页装配 ----------

describe('7-3 mountObserveOverviewPage（FR-O-1）', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-3' }));
    locationStub = { hash: '#/observe' };
    vi.stubGlobal('location', locationStub);
    resetSharedObserveCache();
  });
  afterEach(() => { vi.unstubAllGlobals(); resetSharedObserveCache(); });

  it('挂载拉取三端点（均携带 Bearer Token），三卡 + 时间线 + 快速入口渲染', async () => {
    const calls: string[] = [];
    const bodies = defaultBodies();
    const clock = { now: NOW };
    const { ctx, view } = makeCtx(async (path, init) => {
      calls.push(path);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-7-3');
      return fetchFor(bodies)(path);
    }, cacheWithClock(clock));
    const handle = mountObserveOverviewPage(ctx, { cache: cacheWithClock(clock) });
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    expect(calls).toEqual(expect.arrayContaining(['/api/tasks?limit=100', '/api/approvals?pending=true', '/api/capabilities']));
    // 任务统计卡：三状态计数 + 合计 3 + 成功率（1/(3-1)=50%）
    expect(view.innerHTML).toContain('50%');
    // 待办审批卡：计数 1 + 最老待办相对时间（60 分钟 → 「1 小时前」）
    expect(view.innerHTML).toContain('最老待办 1 小时前');
    // 能力统计卡：待确认 1 / 已生效 1 / 已退场 0
    expect(view.innerHTML).toContain('待确认');
    expect(view.innerHTML).toContain('已退场');
    // 合并时间线：任务与审批条目各带详情跳转链接
    expect(view.innerHTML).toContain('href="#/tasks/task-aaaabbbb"');
    expect(view.innerHTML).toContain('href="#/approvals/req-11112222"');
    // 快速入口四卡
    expect(view.innerHTML).toContain('href="#/tasks"');
    expect(view.innerHTML).toContain('href="#/approvals"');
    expect(view.innerHTML).toContain('href="#/agents"');
    expect(view.innerHTML).toContain('href="#/observe/evidence"');
    expect(PLACEHOLDER_BEASTS.test(view.innerHTML)).toBe(false);
    handle.destroy();
  });

  it('「基于最近 100 条」标注：total > 100 时出现，≤100 时不出现', async () => {
    const bodies = defaultBodies();
    bodies.tasks = { tasks: [], total: 137 };
    const clock = { now: NOW };
    const { ctx, view } = makeCtx(fetchFor(bodies));
    const handle = mountObserveOverviewPage(ctx, { cache: cacheWithClock(clock) });
    await vi.waitFor(() => expect(view.innerHTML).toContain('基于最近 100 条'));
    handle.destroy();

    const view2 = stubViewEl();
    const doc2 = stubDoc();
    const t2 = fakeTimerHost();
    const bodies2 = defaultBodies();
    const clock2 = { now: NOW + 10_000 }; // 新缓存键窗口
    const handle2 = mountObserveOverviewPage({
      doc: doc2 as unknown as Document, view: view2 as unknown as HTMLElement,
      fetchImpl: fetchFor(bodies2) as unknown as typeof fetch, timerHost: t2.host,
      confirmBox: () => true, now: () => NOW,
    }, { cache: cacheWithClock(clock2) });
    await vi.waitFor(() => expect(view2.innerHTML).toContain('task-aaaa'));
    expect(view2.innerHTML).not.toContain('基于最近 100 条');
    handle2.destroy();
  });

  it('缓存行为：销毁重挂（5s 内）不重复拉取，直接渲染缓存；后台由下轮轮询刷新', async () => {
    const bodies = defaultBodies();
    let fetches = 0;
    const counterFetch = async (path: string): Promise<Response> => {
      fetches += 1;
      return fetchFor(bodies)(path);
    };
    const clock = { now: NOW };
    const cache = cacheWithClock(clock);
    const first = makeCtx(counterFetch);
    const h1 = mountObserveOverviewPage(first.ctx, { cache });
    await vi.waitFor(() => expect(first.view.innerHTML).toContain('task-aaaa'));
    expect(fetches).toBe(3);
    h1.destroy();

    const second = makeCtx(counterFetch);
    const h2 = mountObserveOverviewPage(second.ctx, { cache }); // 5s 内回来：同缓存
    await vi.waitFor(() => expect(second.view.innerHTML).toContain('task-aaaa')); // 直接渲染缓存
    expect(fetches).toBe(3); // 未重复拉取
    h2.destroy();
  });

  it('轮询 5s；visibilitychange 不可见暂停；destroy 清计时器', async () => {
    const bodies = defaultBodies();
    const clock = { now: NOW };
    const cache = cacheWithClock(clock);
    let taskFetches = 0;
    const { ctx, view, timers, doc } = makeCtx(async (path) => {
      if (path === '/api/tasks?limit=100') taskFetches += 1;
      return fetchFor(bodies)(path);
    });
    const handle = mountObserveOverviewPage(ctx, { cache });
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    expect(timers.every((t) => t.ms === 5_000)).toBe(true);
    clock.now = NOW + 6_000; // 越过 TTL，轮询重拉生效
    timers[0].fn();
    await vi.waitFor(() => expect(taskFetches).toBe(2));
    await vi.waitFor(() => expect(timers).toHaveLength(1)); // refresh 完成后重排下一周期
    (doc.listeners.get('visibilitychange')![0] as (ev?: unknown) => void)({ target: { hidden: true } } as unknown as Event);
    expect(timers).toHaveLength(0);
    handle.destroy();
  });

  it('单端点失败（非 401）：其余两卡照常渲染（某一段失败不影响其他段，§11-10）', async () => {
    const bodies = defaultBodies();
    const clock = { now: NOW };
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/approvals?pending=true') return jsonResponse({ ok: false, code: 'internal', message: 'm' }, 500);
      return fetchFor(bodies)(path);
    });
    const handle = mountObserveOverviewPage(ctx, { cache: cacheWithClock(clock) });
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    expect(view.innerHTML).toContain('已生效'); // 能力卡照常
    handle.destroy();
  });

  it('读面 401：登录状态失效提示（去技术化，TASK-128）并停轮询（§11-2）', async () => {
    const clock = { now: NOW };
    const { ctx, view, timers } = makeCtx(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401));
    const handle = mountObserveOverviewPage(ctx, { cache: cacheWithClock(clock) });
    await vi.waitFor(() => expect(view.innerHTML).toContain('登录状态已失效'));
    expect(timers).toHaveLength(0);
    handle.destroy();
  });
});

// ---------- 总控视图纯函数 ----------

describe('7-3 observeOverviewHtml（视图纯函数）', () => {
  const model: OverviewModel = {
    taskCounts: { created: 0, queued: 1, running: 2, paused: 0, succeeded: 4, failed: 2, cancelled: 2 },
    taskTotal: 11,
    taskTotalAll: 11,
    successRate: 4 / 8,
    pendingCount: 2,
    oldestPending: '最老待办 3 分钟前',
    capabilityCounts: { candidate: 3, active: 2, retired: 1 },
    timeline: [
      { kind: 'task', at: '2026-10-01T11:50:00.000Z', taskId: 'task-aaaabbbb', status: 'running' },
      { kind: 'approval', at: '2026-10-01T11:45:00.000Z', requestId: 'req-11112222', toolId: 'shell' },
    ],
    loading: false,
    now: NOW,
  };

  it('七状态计数 + 合计 + 成功率百分比', () => {
    const html = observeOverviewHtml(model);
    expect(html).toContain('运行中');
    expect(html).toContain('已完成');
    expect(html).toContain('50%');
    expect(html).toContain('合计');
  });

  it('无分母（null 成功率）显「—」不假装', () => {
    const html = observeOverviewHtml({ ...model, taskCounts: { created: 0, queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 2 }, taskTotal: 2, successRate: null });
    expect(html).toContain('—');
  });

  it('占位神兽零出现', () => {
    expect(PLACEHOLDER_BEASTS.test(observeOverviewHtml(model))).toBe(false);
  });
});
