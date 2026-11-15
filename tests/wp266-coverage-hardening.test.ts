import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountObserveEvidencePage } from '../src/portal/ui/observeEvidencePage.js';
import { mountObserveEvolutionDetailPage } from '../src/portal/ui/observeEvolutionDetailPage.js';
import { mountTasksPage } from '../src/portal/ui/tasksPage.js';
import { RUNNING_STALE_MS } from '../src/portal/ui/taskFilters.js';
import type { TimerHost } from '../src/portal/ui/poll.js';
import { AUTH_EXPIRED_TEXT, NETWORK_ERROR_TEXT } from '../src/portal/ui/errors.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import {
  clickEvent,
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
  submitEvent,
  type StubDoc,
  type StubEl,
} from './wp7-3-mount-stubs.js';

// wp266（第五十二批 · 覆盖加固蓄余量）：纯测试触达的低风险分支补测，零 src 改动。
// 覆盖面分组：observeEvidencePage 响应形状异常/真实 form 提交回退/输入同步+
// evidence-search/无 data-action 点击/剪贴板缺失/展开 payload（×6）/
// observeEvolutionDetailPage 响应形状异常 + destroy 在途丢弃（×2）/
// tasksPage 裸数组统计面/agentId 列表参数/running 滞留/401 后写操作收尾刷新
// 短路+崩溃恢复 running-count/写操作网络失败/无 data-action 点击/page-prev/
// 无 data-filter change + agent+range 筛选导航/非 search 输入过滤忽略（×9）。
// 每条用例均为实质断言。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

// ---------- 共用桩 ----------

function makeCtx(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  confirmBox: (t: string) => boolean = () => true,
): { ctx: PageCtx; view: StubEl; doc: StubDoc; timers: Array<{ fn: () => void; ms: number }> } {
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

function evidenceRow(partial: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ref: 'task:task-11112222',
    kind: 'task',
    status: 'verified',
    occurredAt: '2026-10-01T10:00:00.000Z',
    digest: 'abcdef0123456789abcdef',
    payload: '{"result":"ok"}',
    ...partial,
  };
}

function clickNoHit(): Record<string, unknown> {
  return { preventDefault: () => {}, target: { closest: () => null } };
}

// ---------- observeEvidencePage ----------

describe('wp266 observeEvidencePage：响应形状与交互边界', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-266' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('200 响应缺 digest 键 → 形状异常页内错误条（不渲染结果区）', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse({ ref: 'task:task-11112222', kind: 'task' }));
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('响应形状异常（缺 ref/digest 键）'));
    expect(view.innerHTML).not.toContain('abcdef012345'); // 无结果区
    handle.destroy();
  });

  it('真实 DOM 提交（target=form 无 value）→ 回退输入态续查当前 inputValue', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return jsonResponse(evidenceRow()); });
    const handle = mountObserveEvidencePage(ctx, {});
    const input = view.listeners.get('input')![0];
    (input as (ev: unknown) => void)({ preventDefault: () => {}, target: { value: 'task:form00001' } });
    const submit = view.listeners.get('submit')![0];
    (submit as (ev: unknown) => void)(submitEvent({ closest: () => null })); // form 无 value → 回退
    await vi.waitFor(() => expect(paths).toEqual(['/api/evidence/task%3Aform00001']));
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    handle.destroy();
  });

  it('input 事件同步输入态；evidence-search 按钮点击以当前输入发起查询', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return jsonResponse(evidenceRow()); });
    const handle = mountObserveEvidencePage(ctx, {});
    expect(paths).toHaveLength(0); // 挂载无 ?ref= 不自动查询
    const input = view.listeners.get('input')![0];
    (input as (ev: unknown) => void)({ preventDefault: () => {}, target: { value: 'task:btn000001' } });
    const click = view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'evidence-search' }));
    await vi.waitFor(() => expect(paths).toEqual(['/api/evidence/task%3Abtn000001']));
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    handle.destroy();
  });

  it('点击未命中 [data-action] → 无操作（不重渲、不发请求）', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return jsonResponse(evidenceRow()); });
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    const before = view.innerHTML;
    const click = view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickNoHit());
    expect(view.innerHTML).toBe(before); // 无重渲
    expect(paths).toHaveLength(1); // 无新请求
    handle.destroy();
  });

  it('navigator 无 clipboard API → 复制降级提示（不静默）', async () => {
    vi.stubGlobal('navigator', {}); // 无 clipboard 键
    const { ctx, view } = makeCtx(async () => jsonResponse(evidenceRow()));
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    const click = view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'copy-ref', ref: 'task:task-11112222' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('复制失败（浏览器剪贴板不可用或未授权）'));
    handle.destroy();
  });

  it('payload 折叠区「展开全部」→ 全文渲染（折叠标记消失）', async () => {
    const long = evidenceRow({ payload: JSON.stringify({ big: 'x'.repeat(3000), tail: 'WP266-TAIL' }) });
    const { ctx, view } = makeCtx(async () => jsonResponse(long));
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('展开全部'));
    expect(view.innerHTML).not.toContain('WP266-TAIL'); // 折叠态只见前缀
    const click = view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'expand-payload' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('WP266-TAIL'));
    expect(view.innerHTML).not.toContain('展开全部');
    handle.destroy();
  });
});

// ---------- observeEvolutionDetailPage ----------

describe('wp266 observeEvolutionDetailPage：形状防御与在途丢弃', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-266' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('200 响应缺 candidateId → unknown 码错误面 + 返回列表出口', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse({ nope: true }));
    const handle = mountObserveEvolutionDetailPage(ctx, 'cand-shape');
    await vi.waitFor(() => {
      expect(view.innerHTML).toMatch(/error-state/);
      expect(view.innerHTML).toContain('unknown：响应形状异常');
      expect(view.innerHTML).toContain('返回演进列表');
    });
    handle.destroy();
  });

  it('destroy 后在途响应到达 → settled 短路，不再渲染', async () => {
    let release: (r: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    const { ctx, view } = makeCtx(async () => gate);
    const handle = mountObserveEvolutionDetailPage(ctx, 'cand-late');
    handle.destroy(); // 路由已切走
    release(jsonResponse({ candidateId: 'cand-late', agentId: 'ag-1', trigger: 'repeated_failure', status: 'open', createdAt: '2026-10-01T10:00:00.000Z' }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(view.innerHTML).toBe(''); // 在途响应被丢弃
  });
});

// ---------- tasksPage ----------

describe('wp266 tasksPage：数据面口径与交互边界', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-266' }));
    locationStub = { hash: '#/tasks' };
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

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

  const listBody = {
    tasks: [
      taskRow({ taskId: 'task-aaaabbbb', status: 'paused', agentId: 'ag-1' }),
      taskRow({ taskId: 'task-ccccdddd', status: 'queued', agentId: 'ag-2' }),
    ],
    total: 2,
  };

  function listFetcher(): { calls: string[]; fn: (path: string, init?: RequestInit) => Promise<Response> } {
    const calls: string[] = [];
    return {
      calls,
      fn: async (path) => { calls.push(path); return jsonResponse(listBody); },
    };
  }

  it('统计面返回裸数组 → asRows 数组分支聚合（running=3 渲染）', async () => {
    const rows3 = [1, 2, 3].map((i) => taskRow({ taskId: `task-run00000${i}`, status: 'running' }));
    const { ctx, view } = makeCtx(async (path) => jsonResponse(path.includes('limit=100') ? rows3 : { tasks: rows3, total: 3 }));
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-run0000'));
    expect(view.innerHTML).toContain('<span class="stat-card__value">3</span>'); // running 卡计数 3
    handle.destroy();
  });

  it('agent 筛选挂载 → 列表请求携带 agentId 参数', async () => {
    const { calls, fn } = listFetcher();
    const { ctx } = makeCtx(fn);
    const handle = mountTasksPage(ctx, { agent: 'ag-1' });
    await vi.waitFor(() => expect(calls).toContain('/api/tasks?agentId=ag-1&limit=20&offset=0'));
    handle.destroy();
  });

  it('running 滞留行 → 滞留警告 + 显式崩溃恢复出口（取消不出现）', async () => {
    const stale = taskRow({
      taskId: 'task-stale0001',
      status: 'running',
      endedAt: null,
      createdAt: new Date(NOW - RUNNING_STALE_MS - 60_000).toISOString(),
    });
    const body = { tasks: [stale, ...listBody.tasks], total: 3 };
    const { ctx, view } = makeCtx(async (path) => jsonResponse(path.includes('limit=100') ? body.tasks : body));
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('该任务运行时间异常，可能是孤儿运行'));
    expect(view.innerHTML).toContain('显式崩溃恢复');
    const staleRowHtml = view.innerHTML.slice(view.innerHTML.indexOf('task-stale'), view.innerHTML.indexOf('</tr>', view.innerHTML.indexOf('task-stale')));
    expect(staleRowHtml).not.toMatch(/data-action="cancel"/); // 滞留行不出取消
    handle.destroy();
  });

  it('401 后写操作收尾 refresh 短路：崩溃恢复成功仍反馈，且不再重拉读面', async () => {
    const getReads: string[] = [];
    const posts: string[] = [];
    const confirmTexts: string[] = [];
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({ ok: true, recovered: 0 }); }
      getReads.push(path);
      return jsonResponse({ ok: false, code: 'unauthorized', message: 'expired' }, 401);
    }, (t) => { confirmTexts.push(t); return true; });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain(AUTH_EXPIRED_TEXT));
    const readsAfterMount = getReads.length;
    view.listeners.get('click')![0](clickEvent({ action: 'crash-recovery', 'running-count': '3' }));
    await vi.waitFor(() => expect(posts).toEqual(['/api/portal/crash-recovery']));
    expect(confirmTexts[0]).toContain('3'); // running-count 数据集值进入确认文案
    await vi.waitFor(() => expect(view.innerHTML).toContain('崩溃恢复已执行'));
    await Promise.resolve(); await Promise.resolve();
    expect(getReads.length).toBe(readsAfterMount); // authFailed 短路：refresh 不再发读请求
    handle.destroy();
  });

  it('写操作网络失败（POST 抛异常）→ 断网口径红条', async () => {
    const { ctx, view } = makeCtx(async (path, init) => {
      if (init?.method === 'POST') throw new TypeError('fetch failed');
      return jsonResponse(listBody);
    });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickEvent({ action: 'cancel', 'task-id': 'task-aaaabbbb', 'task-status': 'paused' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain(NETWORK_ERROR_TEXT));
    expect(view.innerHTML).toMatch(/feedback--error/);
    handle.destroy();
  });

  it('点击未命中 [data-action] → 无操作不炸', async () => {
    const { ctx, view } = makeCtx(listFetcher().fn);
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    view.listeners.get('click')![0](clickNoHit());
    expect(locationStub.hash).toBe('#/tasks');
    handle.destroy();
  });

  it('分页：page-next（total=25 两页）后 page-prev → offset 20 再回 0', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => taskRow({ taskId: `task-page${String(i).padStart(4, '0')}` }));
    const paged = { tasks: rows, total: 25 };
    const calls: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { calls.push(path); return jsonResponse(paged); });
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-page'));
    const listCalls = () => calls.filter((p) => p.includes('limit=20'));
    expect(listCalls()).toEqual(['/api/tasks?limit=20&offset=0']);
    const click = view.listeners.get('click')![0];
    click(clickEvent({ action: 'page-next' }));
    await vi.waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1]).toBe('/api/tasks?limit=20&offset=20');
    click(clickEvent({ action: 'page-prev' }));
    await vi.waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(listCalls()[2]).toBe('/api/tasks?limit=20&offset=0');
    handle.destroy();
  });

  it('change 未命中 [data-filter] → 无操作；agent/range 筛选导航写 hash', async () => {
    const { ctx, view } = makeCtx(listFetcher().fn);
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    const change = view.listeners.get('change')![0];
    (change as (ev: unknown) => void)({ preventDefault: () => {}, target: { value: 'x', closest: () => null } });
    expect(locationStub.hash).toBe('#/tasks'); // 未命中不动
    (change as (ev: unknown) => void)({ preventDefault: () => {}, target: { value: 'ag-2', closest: (sel: string) => (sel === '[data-filter]' ? { dataset: { filter: 'agent' } } : null) } });
    expect(locationStub.hash).toBe('#/tasks?agent=ag-2');
    (change as (ev: unknown) => void)({ preventDefault: () => {}, target: { value: '30d', closest: (sel: string) => (sel === '[data-filter]' ? { dataset: { filter: 'range' } } : null) } });
    expect(locationStub.hash).toBe('#/tasks?agent=ag-2&range=30d');
    handle.destroy();
  });

  it('input 事件非 search 过滤控件 → 忽略（本地搜索态不被污染）', async () => {
    const { ctx, view } = makeCtx(listFetcher().fn);
    const handle = mountTasksPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-aaaa'));
    const input = view.listeners.get('input')![0];
    (input as (ev: unknown) => void)({ preventDefault: () => {}, target: { value: 'ag-2', closest: (sel: string) => (sel === '[data-filter]' ? { dataset: { filter: 'status' } } : null) } });
    expect(view.innerHTML).toContain('task-aaaa');
    expect(view.innerHTML).toContain('task-cccc'); // 两行仍在——值未进入搜索过滤
    handle.destroy();
  });
});
