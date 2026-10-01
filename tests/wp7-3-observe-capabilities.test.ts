import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountObserveCapabilitiesPage } from '../src/portal/ui/observeCapabilitiesPage.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import {
  clickEvent,
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
  type FakeTimer,
  type StubDoc,
  type StubEl,
} from './wp7-3-mount-stubs.js';

// 第七阶段批次三（7-3/4）：观测·白泽·能力（FR-O-2）——Agent 选择器（双源去重）+
// 能力矩阵只读（capabilityListRow 实测投影）+ kind/status 筛选走同一端点查询参数。
// 明示：无 /api/agents 列表端点；V0.1 虚构字段（reflection_count 族 / /api/agents/:id/capability）零引用。
// TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;
const FORBIDDEN_FIELDS = /reflection_count|last_reflection_at|pending_reflections|patterns|\/api\/agents\/:id\/capability/;

function capRow(partial: Partial<Record<string, unknown>> & { capabilityId: string }): Record<string, unknown> {
  return {
    capabilityId: 'cap-00001111',
    agentId: 'ag-1',
    kind: 'capability',
    origin: 'derived',
    statement: '能稳定完成 shell 调用',
    statementDigest: 'digest-abc',
    status: 'candidate',
    evidenceRefs: ['task:t-1', 'task:t-2'],
    evidencePending: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    decidedAt: '2026-10-01T10:00:00.000Z',
    decidedBy: 'operator-x',
    ...partial,
  };
}

function taskRow(agentId: string): Record<string, unknown> {
  return { taskId: `t-${agentId}`, agentId, status: 'queued', createdAt: '2026-10-01T10:00:00.000Z', endedAt: null };
}

function makeCtx(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>): { ctx: PageCtx; view: StubEl; doc: StubDoc; timers: FakeTimer[] } {
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
      now: () => NOW,
    },
    view, doc, timers,
  };
}

function changeEvent(value: string, filter: string): Record<string, unknown> {
  return {
    preventDefault: () => {},
    target: { value, closest: (sel: string) => (sel === '[data-filter]' ? { dataset: { filter } } : null) },
  };
}

describe('7-3 mountObserveCapabilitiesPage（FR-O-2）', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-3' }));
    locationStub = { hash: '#/observe/capabilities' };
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const defaultFetch = async (path: string): Promise<Response> => {
    if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [taskRow('ag-bravo'), taskRow('ag-bravo'), taskRow('ag-alpha')], total: 3 });
    if (path === '/api/capabilities') return jsonResponse([capRow({ capabilityId: 'cap-00002222', agentId: 'ag-charlie' }), capRow({ capabilityId: 'cap-00003333', agentId: 'ag-alpha', kind: 'limitation', origin: 'manual', status: 'retired', evidenceRefs: [], evidencePending: true, statement: 'x'.repeat(100), decidedAt: null, decidedBy: null })]);
    if (path.startsWith('/api/capabilities?')) return jsonResponse([]);
    throw new Error(`未预期的请求：${path}`);
  };

  it('挂载：选择器双源去重排序（tasks + capabilities 的 agentId）；矩阵按实测投影渲染', async () => {
    const { ctx, view } = makeCtx(defaultFetch);
    const handle = mountObserveCapabilitiesPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('cap-0000'));
    // 选择器：ag-alpha/ag-bravo/ag-charlie 去重排序 + 标注
    expect(view.innerHTML).toContain('ag-alpha');
    expect(view.innerHTML).toContain('ag-charlie');
    expect(view.innerHTML).toContain('仅含近期有任务或有能力登记的 Agent');
    // 矩阵列：短码 + 悬停全码；kind/origin 中文；status 中文；evidenceRefs 计数；待补证据徽章；decidedAt/decidedBy
    expect(view.innerHTML).toContain('cap-00002222'); // 悬停全文（默认矩阵行）
    expect(view.innerHTML).toContain('能力');
    expect(view.innerHTML).toContain('局限');
    expect(view.innerHTML).toContain('派生');
    expect(view.innerHTML).toContain('人工');
    expect(view.innerHTML).toContain('待确认');
    expect(view.innerHTML).toContain('已退场');
    expect(view.innerHTML).toContain('待补证据'); // evidencePending=true 黄色徽章
    expect(view.innerHTML).toContain('operator-x');
    expect(PLACEHOLDER_BEASTS.test(view.innerHTML)).toBe(false);
    expect(FORBIDDEN_FIELDS.test(view.innerHTML)).toBe(false); // V0.1 虚构字段零出现
    handle.destroy();
  });

  it('statement 截断 80 字符 + 悬停全文（超长 100 字符行）', async () => {
    const { ctx, view } = makeCtx(defaultFetch);
    const handle = mountObserveCapabilitiesPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('cap-0000'));
    expect(view.innerHTML).toContain(`${'x'.repeat(80)}…`);
    expect(view.innerHTML).toContain('x'.repeat(100)); // title 悬停全文
    handle.destroy();
  });

  it('只读边界：页面无任何写操作按钮（无 data-action 发 POST 的交互）', async () => {
    const { ctx, view } = makeCtx(defaultFetch);
    const handle = mountObserveCapabilitiesPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('cap-0000'));
    expect(view.innerHTML).not.toMatch(/data-action="(approve|deny|cancel|resume|crash-recovery)"/);
    handle.destroy();
  });

  it('筛选变更 → URL 同步写 hash 查询串（agent/kind/status 同端点参数）', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return defaultFetch(path); });
    const handle = mountObserveCapabilitiesPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('cap-0000'));
    const change = view.listeners.get('change')![0];
    (change as (ev: unknown) => void)(changeEvent('ag-alpha', 'agent'));
    expect(locationStub.hash).toBe('#/observe/capabilities?agent=ag-alpha');
    (change as (ev: unknown) => void)(changeEvent('limitation', 'kind'));
    expect(locationStub.hash).toBe('#/observe/capabilities?agent=ag-alpha&kind=limitation');
    (change as (ev: unknown) => void)(changeEvent('retired', 'status'));
    expect(locationStub.hash).toBe('#/observe/capabilities?agent=ag-alpha&kind=limitation&status=retired');
    handle.destroy();
  });

  it('?agent= 预选（FR-AG-5 前向链接）：矩阵请求带 agent 参数，选择器选中态', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return defaultFetch(path); });
    const handle = mountObserveCapabilitiesPage(ctx, { agent: 'ag-alpha' });
    await vi.waitFor(() => expect(paths.some((p) => p === '/api/capabilities?agent=ag-alpha')).toBe(true));
    expect(view.innerHTML).toMatch(/value="ag-alpha" selected/);
    handle.destroy();
  });

  it('kind/status 查询参数随矩阵请求下发（api.ts:141-158 实测参数面）', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return defaultFetch(path); });
    const handle = mountObserveCapabilitiesPage(ctx, { kind: 'capability', status: 'candidate' });
    await vi.waitFor(() => expect(paths).toContain('/api/capabilities?kind=capability&status=candidate'));
    handle.destroy();
  });

  it('两源皆空 → 选择器空态「暂无 Agent 数据」', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse([]);
    });
    const handle = mountObserveCapabilitiesPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('暂无 Agent 数据'));
    handle.destroy();
  });

  it('矩阵空结果 → 空态「当前筛选无匹配」', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [taskRow('ag-1')], total: 1 });
      if (path === '/api/capabilities?agent=ag-1') return jsonResponse([]);
      return jsonResponse([capRow({ agentId: 'ag-1' })]);
    });
    const handle = mountObserveCapabilitiesPage(ctx, { agent: 'ag-1' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('当前筛选无匹配'));
    handle.destroy();
  });

  it('轮询 10s（FR-G-4 观测各页档）；visibilitychange 不可见暂停；destroy 清计时器', async () => {
    const { ctx, view, timers, doc } = makeCtx(defaultFetch);
    const handle = mountObserveCapabilitiesPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('cap-0000'));
    expect(timers.every((t) => t.ms === 10_000)).toBe(true);
    (doc.listeners.get('visibilitychange')![0] as (ev?: unknown) => void)({ target: { hidden: true } } as unknown as Event);
    expect(timers).toHaveLength(0);
    handle.destroy();
  });

  it('读面 401：认证失效提示并停轮询（§11-2）', async () => {
    const { ctx, view, timers } = makeCtx(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401));
    const handle = mountObserveCapabilitiesPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('认证失效'));
    expect(timers).toHaveLength(0);
    handle.destroy();
  });

  it('clear-filters 出口：空态/筛选态可一键回全量', async () => {
    const { ctx, view } = makeCtx(defaultFetch);
    const handle = mountObserveCapabilitiesPage(ctx, { agent: 'ag-none' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('当前筛选无匹配'));
    const click = view.listeners.get('click')![0];
    // 点击清除筛选按钮（data-action=clear-filters）
    (click as (ev: unknown) => void)({ preventDefault: () => {}, target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'clear-filters' } } : null) } });
    expect(locationStub.hash).toBe('#/observe/capabilities');
    handle.destroy();
  });
});
