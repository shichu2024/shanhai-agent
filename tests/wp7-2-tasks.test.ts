import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_RANGE,
  RANGE_OPTIONS,
  RUNNING_STALE_MS,
  SERVER_STATUSES,
  countByStatus,
  isRunningStale,
  localTaskPass,
  paginate,
  parseTaskFilters,
  rangeStartMs,
  taskFiltersQuery,
  type TaskFilters,
} from '../src/portal/ui/taskFilters.js';
import { tasksPageHtml } from '../src/portal/ui/tasksView.js';
import { mountTasksPage } from '../src/portal/ui/tasksPage.js';
import type { TimerHost } from '../src/portal/ui/poll.js';

// 第七阶段批次二（7-2/4）：任务工作台交互逻辑（设计 V0.3 §5）——
// 筛选口径（服务端六枚举 + created 前端本地过滤）、URL 同步、时间范围前端过滤、
// taskId 前缀搜索、分页数学、running 滞留判定、统计卡聚合、页面装配（轮询/写操作）。
// TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

function taskRow(partial: Partial<Record<string, unknown>> & { taskId: string }): Record<string, unknown> {
  return {
    agentId: 'ag-1',
    agentVersionId: 'ver-1',
    status: 'queued',
    createdAt: '2026-10-01T10:00:00.000Z',
    endedAt: null,
    attemptCount: 0,
    modelCallCount: 0,
    tokensUsed: 0,
    ...partial,
  };
}

// ---------- FR-T-2 筛选口径 ----------

describe('7-2 taskFilters（FR-T-2：六枚举服务端筛选 + created 本地过滤 + URL 同步）', () => {
  it('服务端筛选枚举 = api.ts:33 白名单六值（不含 created）', () => {
    expect([...SERVER_STATUSES]).toEqual(['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled']);
  });

  it('默认筛选：全部状态、全部 Agent、近 7 天', () => {
    expect(parseTaskFilters({})).toEqual({ status: null, agent: null, range: DEFAULT_RANGE });
    expect(DEFAULT_RANGE).toBe('7d');
  });

  it('解析 hash 查询串（status/agent/range；非法 status 忽略；created 保留为本地过滤）', () => {
    expect(parseTaskFilters({ status: 'running', agent: 'ag-9', range: '30d' })).toEqual({ status: 'running', agent: 'ag-9', range: '30d' });
    expect(parseTaskFilters({ status: 'created' }).status).toBe('created');
    expect(parseTaskFilters({ status: 'bogus' }).status).toBeNull();
    expect(parseTaskFilters({ range: 'bogus' }).range).toBe('7d');
  });

  it('URL 同步序列化：默认值省略，非默认逐项写入（FR-T-2）', () => {
    expect(taskFiltersQuery({ status: null, agent: null, range: '7d' })).toBe('');
    expect(taskFiltersQuery({ status: 'running', agent: 'ag-2', range: '7d' })).toBe('status=running&agent=ag-2');
    expect(taskFiltersQuery({ status: null, agent: null, range: '30d' })).toBe('range=30d');
  });

  it('时间范围起点：今天=本地当日零点、7d/30d=滚动窗、all=null（前端过滤，服务端无时间参数）', () => {
    expect(rangeStartMs('all', NOW)).toBeNull();
    const day = rangeStartMs('today', NOW)!;
    expect(new Date(day).getDate()).toBe(new Date(NOW).getDate()); // 本地当日零点
    expect(day).toBeLessThanOrEqual(NOW);
    expect(NOW - day).toBeLessThan(86_400_000);
    expect(NOW - rangeStartMs('7d', NOW)!).toBe(7 * 86_400_000);
    expect(NOW - rangeStartMs('30d', NOW)!).toBe(30 * 86_400_000);
  });

  it('本地过滤：状态 + 时间范围 + taskId 前缀搜索（FR-T-2/FR-T-3 搜索口径）', () => {
    const filters: TaskFilters = { status: 'created', agent: null, range: 'all' };
    const hit = taskRow({ taskId: 'task-abcd1234', status: 'created', createdAt: '2026-09-01T00:00:00.000Z' });
    expect(localTaskPass(hit, filters, '', NOW)).toBe(true);
    expect(localTaskPass(hit, { ...filters, status: 'running' }, '', NOW)).toBe(false);
    expect(localTaskPass(hit, filters, 'task-abc', NOW)).toBe(true);
    expect(localTaskPass(hit, filters, 'zzz', NOW)).toBe(false); // 前缀不匹配
    const recent = taskRow({ taskId: 'task-abcd1234', status: 'created', createdAt: '2026-09-30T00:00:00.000Z' });
    expect(localTaskPass(recent, { status: null, agent: null, range: '7d' }, '', NOW)).toBe(true);
    expect(localTaskPass(recent, { status: null, agent: null, range: 'today' }, '', NOW)).toBe(false);
  });

  it('时间范围选项标签齐全（今天/近 7 天/近 30 天/全部）', () => {
    expect(RANGE_OPTIONS.map((o) => o.label)).toEqual(['今天', '近 7 天', '近 30 天', '全部']);
  });
});

// ---------- FR-T-1 统计 / FR-T-3 分页 / FR-T-4 滞留 ----------

describe('7-2 任务统计与分页（FR-T-1 前端聚合 / FR-T-3 page size 20）', () => {
  it('七状态聚合计数（缺省状态计 0，保持八格稳定）', () => {
    const counts = countByStatus([
      taskRow({ taskId: 'a', status: 'running' }),
      taskRow({ taskId: 'b', status: 'running' }),
      taskRow({ taskId: 'c', status: 'created' }),
    ]);
    expect(counts).toEqual({ created: 1, queued: 0, running: 2, paused: 0, succeeded: 0, failed: 0, cancelled: 0 });
  });

  it('分页数学：page size 20，页码夹取，页数向上取整，空表 1 页', () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ i }));
    expect(paginate(rows, 0, 20)).toEqual({ rows: rows.slice(0, 20), page: 0, pageCount: 3 });
    expect(paginate(rows, 2, 20).rows).toHaveLength(5);
    expect(paginate(rows, 99, 20).page).toBe(2); // 越界夹取
    expect(paginate([], 0, 20)).toEqual({ rows: [], page: 0, pageCount: 1 });
  });

  it('running 滞留判定：running 且未结束且运行超阈值（FR-T-4，与 runningWarning 同口径）', () => {
    const stale = taskRow({ taskId: 's', status: 'running', endedAt: null, createdAt: new Date(NOW - RUNNING_STALE_MS - 1).toISOString() });
    const fresh = taskRow({ taskId: 'f', status: 'running', endedAt: null, createdAt: new Date(NOW - 60_000).toISOString() });
    const ended = taskRow({ taskId: 'e', status: 'running', endedAt: '2026-10-01T11:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z' });
    expect(isRunningStale(stale, NOW)).toBe(true);
    expect(isRunningStale(fresh, NOW)).toBe(false);
    expect(isRunningStale(ended, NOW)).toBe(false);
  });
});

// ---------- 页面 HTML 构建 ----------

describe('7-2 tasksPageHtml（FR-T-1 统计卡 / FR-T-3 列表与行内操作）', () => {
  const base = {
    stats: countByStatus([]),
    rows: [
      taskRow({ taskId: 'task-11112222', status: 'running', agentId: 'ag-x', attemptCount: 2, modelCallCount: 5, tokensUsed: 123456, createdAt: '2026-10-01T11:00:00.000Z' }),
      taskRow({ taskId: 'task-33334444', status: 'paused', agentId: 'ag-y' }),
    ],
    runningStaleIds: ['task-11112222'],
    total: 2,
    page: 0,
    pageCount: 1,
    filters: { status: null, agent: null, range: '7d' } as TaskFilters,
    agentOptions: ['ag-x', 'ag-y'],
    search: '',
  };

  it('统计卡：七状态 + 合计，created 卡 tooltip 明示本地过滤', () => {
    const html = tasksPageHtml(base);
    for (const label of ['已创建', '排队中', '运行中', '已暂停', '已完成', '失败', '已取消', '合计']) expect(html).toContain(label);
    expect(html).toContain('created 不支持服务端筛选');
  });

  it('列表列与行内操作：短码、Agent、徽章、尝试/模型调用/Token 千分位、创建时间；取消仅非滞留行、续跑仅 paused、滞留行出崩溃恢复', () => {
    const html = tasksPageHtml(base);
    expect(html).toContain('task-1111');
    expect(html).toContain('ag-x');
    expect(html).toContain('badge--status-running');
    expect(html).toContain('123,456');
    expect(html).toContain('2026-10-01');
    // 滞留 running 行：显式崩溃恢复出现、取消不出现；正常 paused 行：取消 + 续跑出现
    expect(html).toContain('显式崩溃恢复');
    expect(html).toMatch(/data-action="crash-recovery"/);
    const pausedRow = html.slice(html.indexOf('task-3333'));
    expect(pausedRow).toMatch(/data-action="cancel"/);
    expect(pausedRow).toMatch(/data-action="resume"/);
  });

  it('滞留警告标记与 tooltip（FR-T-4）', () => {
    const html = tasksPageHtml(base);
    expect(html).toContain('该任务运行时间异常，可能是孤儿运行');
  });

  it('空态：无结果显示「当前筛选无任务」+ 清除筛选', () => {
    const html = tasksPageHtml({ ...base, rows: [], runningStaleIds: [] });
    expect(html).toContain('当前筛选无任务');
    expect(html).toContain('清除筛选');
  });

  it('占位神兽零出现', () => {
    expect(PLACEHOLDER_BEASTS.test(tasksPageHtml(base))).toBe(false);
  });
});

// ---------- 页面装配（轮询 / URL 同步 / 写操作） ----------

function fakeTimerHost(): { host: TimerHost; timers: Array<{ fn: () => void; ms: number }> } {
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

interface StubEl {
  innerHTML: string;
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
}

function stubViewEl(): StubEl {
  const el: StubEl = {
    innerHTML: '',
    listeners: new Map(),
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { const arr = el.listeners.get(type) ?? []; el.listeners.set(type, arr.filter((f) => f !== fn)); },
  };
  return el;
}

function stubDoc() {
  const listeners = new Map<string, Array<(ev?: unknown) => void>>();
  return {
    hidden: false,
    addEventListener: (t: string, f: (ev?: unknown) => void) => { listeners.set(t, [...(listeners.get(t) ?? []), f]); },
    removeEventListener: (t: string, f: (ev?: unknown) => void) => { const arr = listeners.get(t) ?? []; listeners.set(t, arr.filter((x) => x !== f)); },
    listeners,
  };
}

function clickEvent(dataset: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    preventDefault: () => {},
    ...extra,
    target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset } : null) },
  };
}

function changeEvent(value: string) {
  return { preventDefault: () => {}, target: { value, closest: () => null } };
}

describe('7-2 mountTasksPage（FR-T-5 轮询 / URL 同步 / §8 写操作）', () => {
  let locationStub: { hash: string };
  let sessionStorageStub: Storage;

  beforeEach(() => {
    const map = new Map<string, string>();
    sessionStorageStub = {
      get length() { return map.size; },
      clear: () => map.clear(),
      getItem: (k) => map.get(k) ?? null,
      key: (i) => [...map.keys()][i] ?? null,
      removeItem: (k) => { map.delete(k); },
      setItem: (k, v) => { map.set(k, v); },
    };
    sessionStorageStub.setItem('shanhai-portal-token', 'tok-7-2');
    locationStub = { hash: '#/tasks' };
    vi.stubGlobal('sessionStorage', sessionStorageStub);
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function makeCtx(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>, confirmBox: (t: string) => boolean = () => true) {
    const view = stubViewEl();
    const doc = stubDoc();
    const { host, timers } = fakeTimerHost();
    return {
      ctx: {
        doc: doc as unknown as Document,
        view: view as unknown as HTMLElement,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timerHost: host,
        confirmBox,
        now: () => NOW,
      },
      view, doc, timers,
    };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status < 400, status, json: async () => body } as unknown as Response;
  }

  const listBody = {
    tasks: [
      taskRow({ taskId: 'task-aaaabbbb', status: 'paused', agentId: 'ag-1' }),
      taskRow({ taskId: 'task-ccccdddd', status: 'queued', agentId: 'ag-2' }),
    ],
    total: 2,
  };

  it('挂载拉取：统计面 limit=100 + 列表面 limit=20&offset=0，均携带 Bearer Token；渲染数据行', async () => {
    const calls: string[] = [];
    const { ctx, view, timers } = makeCtx(async (path, init) => {
      calls.push(path);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-7-2');
      return jsonResponse(listBody);
    });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    expect(calls).toContain('/api/tasks?limit=100');
    expect(calls).toContain('/api/tasks?limit=20&offset=0');
    handle.destroy();
    expect(timers).toHaveLength(0); // destroy 停轮询
  });

  it('FR-T-5 轮询：5s 周期重拉；visibilitychange 不可见暂停', async () => {
    let listReads = 0;
    const { ctx, view, timers, doc } = makeCtx(async (path) => {
      if (path.includes('limit=20')) listReads++;
      return jsonResponse(listBody);
    });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(listReads).toBe(1));
    expect(timers.every((t) => t.ms === 5_000)).toBe(true);
    timers[0].fn();
    await vi.waitFor(() => expect(listReads).toBe(2));
    (doc.listeners.get('visibilitychange')![0] as (ev?: unknown) => void)({ target: { hidden: true } } as unknown as Event);
    expect(timers).toHaveLength(0);
    handle.destroy();
  });

  it('筛选变更 → URL 同步写 hash（FR-T-2）', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse(listBody));
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    const change = view.listeners.get('change')![0];
    // 状态选中 running（经 data-filter 控件事件）
    change({ preventDefault: () => {}, target: { value: 'running', closest: (sel: string) => (sel === '[data-filter]' ? { dataset: { filter: 'status' } } : null) } });
    expect(locationStub.hash).toBe('#/tasks?status=running');
    handle.destroy();
  });

  it('统计卡点击联动筛选（再点取消）；created 卡走本地过滤 hash', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse(listBody));
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    const click = view.listeners.get('click')![0];
    click(clickEvent({ action: 'stat', status: 'running' }));
    expect(locationStub.hash).toBe('#/tasks?status=running');
    click(clickEvent({ action: 'stat', status: 'running' }));
    expect(locationStub.hash).toBe('#/tasks');
    click(clickEvent({ action: 'stat', status: 'created' }));
    expect(locationStub.hash).toBe('#/tasks?status=created');
    handle.destroy();
  });

  it('搜索框 taskId 前缀本地过滤（不清 hash）', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse(listBody));
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    const input = view.listeners.get('input')![0];
    input({ preventDefault: () => {}, target: { value: 'task-cccc', closest: (sel: string) => (sel === '[data-filter]' ? { dataset: { filter: 'search' } } : null) } });
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-cccc'));
    expect(view.innerHTML).not.toContain('task-aaaa');
    handle.destroy();
  });

  it('取消（paused）：confirm 文案逐字=cancelModeFor 非 running 分支 hint；成功绿条局部刷新', async () => {
    const confirmTexts: string[] = [];
    const posts: Array<{ path: string; body: unknown }> = [];
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') { posts.push({ path, body: JSON.parse(String(init.body)) }); return jsonResponse({ ok: true, taskId: 'task-aaaabbbb', mode: 'graceful', note: 'n' }); }
      return jsonResponse(listBody);
    }, (t) => { confirmTexts.push(t); return true; });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickEvent({ action: 'cancel', 'task-id': 'task-aaaabbbb', 'task-status': 'paused' }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: '/api/tasks/task-aaaabbbb/cancel', body: { mode: 'graceful' } });
    expect(confirmTexts).toEqual(['queued/paused 立即取消（既有 CAS 语义）；paused 取消将连带 pending 审批作废']);
    await vi.waitFor(() => expect(view.innerHTML).toMatch(/feedback--success/));
    handle.destroy();
  });

  it('取消（running）：confirm 文案=cancelModeFor running 分支 hint，mode=force；409 cross_process_graceful_unsupported → 红条分类文案', async () => {
    const confirmTexts: string[] = [];
    const posts: string[] = [];
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({ ok: false, code: 'cross_process_graceful_unsupported', message: 'm' }, 409); }
      return jsonResponse(listBody);
    }, (t) => { confirmTexts.push(t); return true; });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickEvent({ action: 'cancel', 'task-id': 'task-aaaabbbb', 'task-status': 'running' }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(confirmTexts).toEqual(['该任务运行于独立进程，仅支持强制中止（下一个原子调用边界生效，模型调用不打断；graceful 仅执行进程内可见）']);
    await vi.waitFor(() => expect(view.innerHTML).toContain('cross_process_graceful_unsupported'));
    expect(view.innerHTML).toMatch(/feedback--error/);
    handle.destroy();
  });

  it('confirm 取消（用户点「取消」）不发请求', async () => {
    const posts: string[] = [];
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({ ok: true }); }
      return jsonResponse(listBody);
    }, () => false);
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickEvent({ action: 'cancel', 'task-id': 'task-aaaabbbb', 'task-status': 'paused' }));
    await Promise.resolve(); await Promise.resolve();
    expect(posts).toHaveLength(0);
    handle.destroy();
  });

  it('续跑（paused）：无 confirm（FR-WR-1 四级无 resume 项）→ POST resume；成功条含 resumeNote 原文 + CLI 兜底命令 + 日志链接', async () => {
    const confirms: string[] = [];
    const posts: string[] = [];
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({ ok: true, taskId: 'task-aaaabbbb', spawned: true, resumedBy: 'manual-resume', pid: 4321, logFile: 'C:\\data\\resume-task-aaaabbbb.log' }); }
      return jsonResponse(listBody);
    }, (t) => { confirms.push(t); return true; });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickEvent({ action: 'resume', 'task-id': 'task-aaaabbbb' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/tasks/task-aaaabbbb/resume']));
    expect(confirms).toEqual([]);
    await vi.waitFor(() => {
      expect(view.innerHTML).toContain('已 spawn 续跑子进程（resumedBy=manual-resume；日志 resume-task-aaaabbbb.log）——状态以任务页为准，子进程 CAS 失败时日志留因');
      expect(view.innerHTML).toContain('shanhai task run task-aaaabbbb --resume --resumed-by manual-resume');
      expect(view.innerHTML).toContain('/api/tasks/task-aaaabbbb/resume-log');
    });
    handle.destroy();
  });

  it('崩溃恢复：confirm 文案逐字=confirmCrashRecoveryText(当前 Running 数)；POST 全局端点无 :id', async () => {
    const confirmTexts: string[] = [];
    const posts: string[] = [];
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({ ok: true, report: {} }); }
      return jsonResponse(listBody);
    }, (t) => { confirmTexts.push(t); return true; });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickEvent({ action: 'crash-recovery', 'running-count': '2' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/portal/crash-recovery']));
    expect(confirmTexts).toEqual(['将把所有 Running 任务（当前 2 个）标记为 Failed(CrashRecovery)，并执行孤儿快照清理、pending 审批作废与 trace 索引对账。请先确认这些任务的执行进程确实已不存在——正在执行的任务会被误杀且不可恢复。确认继续？']);
    handle.destroy();
  });

  it('FR-WR-2 乐观禁用：在途期间重复点击只发 1 个请求', async () => {
    let resolvePost: ((r: Response) => void) | null = null;
    let postCount = 0;
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') {
        postCount++;
        return new Promise<Response>((resolve) => { resolvePost = resolve; });
      }
      return jsonResponse(listBody);
    });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    const click = view.listeners.get('click')![0];
    const ev = clickEvent({ action: 'resume', 'task-id': 'task-aaaabbbb' });
    click(ev); click(ev); click(ev);
    await Promise.resolve(); await Promise.resolve();
    expect(postCount).toBe(1);
    resolvePost!(jsonResponse({ ok: true, taskId: 'task-aaaabbbb', spawned: false, logFile: '' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('续跑子进程未启动'));
    handle.destroy();
  });

  it('读面 401：内容区显示登录状态失效（去技术化，TASK-128）并停止轮询（§11-2）', async () => {
    let reads = 0;
    const { ctx, view, timers } = makeCtx(async (path, init) => {
      if (init?.method !== 'POST') { reads++; return jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401); }
      return jsonResponse({});
    });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('登录状态已失效'));
    expect(view.innerHTML).not.toContain('Token'); // 401 态不向用户暴露口令概念
    expect(reads).toBe(2); // 两个读面各失败一次后不再拉取
    expect(timers).toHaveLength(0);
    handle.destroy();
  });

  it('分页：翻页请求带 offset（FR-T-3）', async () => {
    const calls: string[] = [];
    const big = { tasks: Array.from({ length: 20 }, (_, i) => taskRow({ taskId: `task-p${String(i).padStart(4, '0')}`, status: 'queued' })), total: 25 };
    const { ctx, view } = makeCtx(async (path) => { calls.push(path); return jsonResponse(big); });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-p0000'));
    view.listeners.get('click')![0](clickEvent({ action: 'page-next' }));
    await vi.waitFor(() => expect(calls.some((c) => c.includes('offset=20'))).toBe(true));
    handle.destroy();
  });
});
