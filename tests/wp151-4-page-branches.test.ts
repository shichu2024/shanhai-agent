import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountApprovalsPage } from '../src/portal/ui/approvalsPage.js';
import { mountObserveEvolutionPage } from '../src/portal/ui/observeEvolutionPage.js';
import { apiErrorPayload } from '../src/portal/errormap.js';
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

// 每日优化第十二批（TASK-151）：次级梯队分支收窄——approvalsPage（基线分支 84.61%：
// 非动作点击早退 / 空 decision 过滤回退 null / 非 decision 过滤源早退 / 可见性回退
// ctx.doc.hidden）、observeEvolutionPage（81.25%：非数组响应回退空集 / 可见性回退）、
// errormap（91.66%：非 Error 抛出物归 500 字符串化）。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function approvalRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-0001',
    taskId: 't-1',
    toolId: 'l3-op',
    riskLevel: 'L3',
    decision: 'pending',
    taskStatus: 'paused',
    requestedAt: '2026-10-01T10:00:00.000Z',
    timeoutRemainingMs: 120_000,
    ...partial,
  };
}

function candidateRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateId: 'cand-0001',
    agentId: 'ag-1',
    trigger: 'repeated_failure',
    evidenceRefs: '[]',
    status: 'open',
    proposedChange: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    ...partial,
  };
}

function makeCtx(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>): {
  ctx: PageCtx; view: StubEl; doc: StubDoc; timers: FakeTimer[];
} {
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

function clickEventOn(closestResult: { dataset: Record<string, string> } | null, value?: string): Record<string, unknown> {
  return {
    preventDefault: () => {},
    target: {
      ...(value !== undefined ? { value } : {}),
      closest: () => closestResult,
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); handleForCleanup?.destroy(); handleForCleanup = null; });
let handleForCleanup: { destroy(): void } | null = null;

describe('wp151 approvalsPage 分支：本地过滤守卫与可见性回退（approvalsPage.ts:80-113）', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-a' }));
    vi.stubGlobal('location', { hash: '#/approvals' });
  });

  it('非 [data-action] 命中的点击 → 早退不切视图不发请求', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([approvalRow()]));
    const { ctx, view } = makeCtx(fetchImpl);
    handleForCleanup = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-0001'));
    const callsBefore = fetchImpl.mock.calls.length;
    view.listeners.get('click')![0](clickEventOn(null));
    expect(fetchImpl.mock.calls.length).toBe(callsBefore); // 无新请求、无切视图
  });

  it('decision 过滤：空值 → 过滤回退 null（全量恢复）；非 decision 过滤源 → 早退', async () => {
    const rows = [approvalRow(), approvalRow({ requestId: 'req-0002', decision: 'denied' })];
    const fetchImpl = vi.fn(async (path: string) => jsonResponse(path.includes('pending=true') ? rows.filter((r) => r.decision === 'pending') : rows));
    const { ctx, view } = makeCtx(fetchImpl);
    handleForCleanup = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-0001'));
    view.listeners.get('click')![0](clickEventOn({ dataset: { action: 'view-all' } }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-0002'));
    // 设过滤 denied → 仅 req-0002
    view.listeners.get('change')![0](clickEventOn({ dataset: { filter: 'decision' } }, 'denied'));
    await vi.waitFor(() => {
      expect(view.innerHTML).toContain('req-0002');
      expect(view.innerHTML).not.toContain('req-0001');
    });
    // 空值 → decisionFilter 回退 null，全量恢复
    view.listeners.get('change')![0](clickEventOn({ dataset: { filter: 'decision' } }, ''));
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-0001'));
    // 非 decision 过滤源（如未来其它 data-filter）→ 早退不改动
    const htmlBefore = view.innerHTML;
    view.listeners.get('change')![0](clickEventOn({ dataset: { filter: 'other' } }, 'denied'));
    expect(view.innerHTML).toBe(htmlBefore);
  });

  it('visibilitychange：事件 target 无布尔 hidden → 回退 ctx.doc.hidden（FR-G-4）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([approvalRow()]));
    const { ctx, doc, view } = makeCtx(fetchImpl);
    handleForCleanup = mountApprovalsPage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-0001'));
    doc.hidden = false;
    const onVis = doc.listeners.get('visibilitychange')![0];
    onVis({ target: {} }); // target.hidden 非布尔 → 回退 doc.hidden=false → 恢复可见立即拉一次
    await vi.waitFor(() => expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('approvals')).length).toBeGreaterThanOrEqual(2));
  });
});

describe('wp151 observeEvolutionPage 分支：非数组响应回退与可见性回退（observeEvolutionPage.ts:20-56）', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-e' }));
    vi.stubGlobal('location', { hash: '#/observe/evolution' });
  });

  it('ok 响应但 data 非数组（形状漂移）→ 回退空集渲染空态，页面不崩', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: 'shape' }));
    const { ctx, view } = makeCtx(fetchImpl);
    handleForCleanup = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('暂无演进候选'));
  });

  it('数组内混入非候选形态行 → 过滤后仅保留合法行', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      null,
      42,
      { candidateId: 9, status: 'open' },
      candidateRow(),
    ]));
    const { ctx, view } = makeCtx(fetchImpl);
    handleForCleanup = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('cand-0001'));
  });

  it('visibilitychange：target 携带布尔 hidden=true → 暂停；doc.hidden 回退路径同触发', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([candidateRow()]));
    const { ctx, doc, view, timers } = makeCtx(fetchImpl);
    handleForCleanup = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('cand-0001'));
    const onVis = doc.listeners.get('visibilitychange')![0];
    onVis({ target: { hidden: true } }); // 布尔直取路径
    const timersAfterPause = timers.length;
    onVis({ target: {} }); // 回退路径：doc.hidden=false → 恢复 → 立即拉一次
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(timers.length).toBeGreaterThanOrEqual(timersAfterPause);
  });
});

describe('wp151 errormap：非 Error 抛出物归 internal_error 字符串化（errormap.ts:53）', () => {
  it('字符串/数字抛出物 → message 字符串化、status 500', () => {
    const s1 = apiErrorPayload('boom-string');
    expect(s1.status).toBe(500);
    expect(s1.body).toMatchObject({ ok: false, code: 'internal_error', message: 'boom-string' });
    const s2 = apiErrorPayload(42);
    expect(s2.body.message).toBe('42');
  });
});
