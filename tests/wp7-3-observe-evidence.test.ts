import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountObserveEvidencePage } from '../src/portal/ui/observeEvidencePage.js';
import { evidenceRowsOf } from '../src/portal/ui/taskDetailView.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import {
  clickEvent,
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
  submitEvent,
  type FakeTimer,
  type StubDoc,
  type StubEl,
} from './wp7-3-mount-stubs.js';

// 第七阶段批次三（7-3/4）：观测·夔牛·证据（FR-O-4）——唯一数据源 GET /api/evidence/:ref，
// 三入口（页内输入框 / ?ref= 直落 / 跨页链接）；六键呈现；payload >2048 折叠；
// 错误面 invalid_ref(400) / not_found(404) 按 FR-WR-5 口径 toast + 页内错误条双呈现。
// 删除项：runs 表格与 integrity 区零引用。TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;
const FORBIDDEN = /integrity|参考完整性/;

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

/** 提交事件：输入框值经 data-input 定位 */
function submitWithValue(value: string): Record<string, unknown> {
  return submitEvent({ value, closest: () => null });
}

describe('7-3 mountObserveEvidencePage（FR-O-4）', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-3' }));
    locationStub = { hash: '#/observe/evidence' };
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('初始：ref 输入框（等宽）+ 查询按钮，无结果区；零占位神兽', async () => {
    const { ctx, view } = makeCtx(async () => { throw new Error('不应发请求'); });
    const handle = mountObserveEvidencePage(ctx, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('查询'));
    expect(view.innerHTML).toMatch(/mono|code/); // 等宽输入
    expect(view.innerHTML).not.toContain('digest');
    expect(PLACEHOLDER_BEASTS.test(view.innerHTML)).toBe(false);
    expect(FORBIDDEN.test(view.innerHTML)).toBe(false);
    handle.destroy();
  });

  it('?ref= 直落：挂载即自动查询', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return jsonResponse(evidenceRow()); });
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345')); // digest 前 12
    expect(paths).toEqual(['/api/evidence/task%3Atask-11112222']);
    handle.destroy();
  });

  it('提交查询：GET /api/evidence/:ref（ref URL 编码）；六键渲染（ref 全文等宽+复制 / kind / status / occurredAt / digest 12+悬停全 / payload 美化）', async () => {
    const paths: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { paths.push(path); return jsonResponse(evidenceRow({ payload: '{"a":1}' })); });
    const handle = mountObserveEvidencePage(ctx, {});
    const submit = view.listeners.get('submit')![0];
    (submit as (ev: unknown) => void)(submitWithValue('task:task-11112222'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    expect(paths).toEqual(['/api/evidence/task%3Atask-11112222']);
    expect(view.innerHTML).toContain('task:task-11112222'); // ref 等宽全文
    expect(view.innerHTML).toContain('复制');
    expect(view.innerHTML).toContain('verified');
    expect(view.innerHTML).toContain('abcdef0123456789abcdef'); // digest 悬停全文
    expect(view.innerHTML).toContain('&quot;a&quot;: 1'); // payload JSON 美化（esc 后引号实体）
    handle.destroy();
  });

  it('非空校验：空输入提交 → 页内提示，不发请求', async () => {
    const fetches: string[] = [];
    const { ctx, view } = makeCtx(async (path) => { fetches.push(path); return jsonResponse(evidenceRow()); });
    const handle = mountObserveEvidencePage(ctx, {});
    const submit = view.listeners.get('submit')![0];
    (submit as (ev: unknown) => void)(submitWithValue('   '));
    await Promise.resolve(); await Promise.resolve();
    expect(fetches).toHaveLength(0);
    await vi.waitFor(() => expect(view.innerHTML).toContain('请输入证据引用'));
    handle.destroy();
  });

  it('payload >2048 字符：默认折叠 + 展开按钮；≤2048 直接展示', async () => {
    const long = evidenceRow({ payload: JSON.stringify({ big: 'x'.repeat(3000) }) });
    const { ctx, view } = makeCtx(async () => jsonResponse(long));
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    expect(view.innerHTML).toContain('展开');
    // 短 payload 直接展示
    const view2 = stubViewEl();
    const doc2 = stubDoc();
    const t2 = fakeTimerHost();
    const handle2 = mountObserveEvidencePage({
      doc: doc2 as unknown as Document, view: view2 as unknown as HTMLElement,
      fetchImpl: (async () => jsonResponse(evidenceRow())) as unknown as typeof fetch,
      timerHost: t2.host, confirmBox: () => true, now: () => NOW,
    }, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view2.innerHTML).toContain('abcdef012345'));
    expect(view2.innerHTML).not.toContain('展开');
    handle2.destroy();
    handle.destroy();
  });

  it('错误面 invalid_ref（400）：toast + 页内错误条双呈现，文案=FR-WR-5 口径', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse({ ok: false, code: 'invalid_ref', message: 'ref 格式非法' }, 400));
    const handle = mountObserveEvidencePage(ctx, {});
    const submit = view.listeners.get('submit')![0];
    (submit as (ev: unknown) => void)(submitWithValue('bogus-ref'));
    await vi.waitFor(() => {
      expect(view.innerHTML).toMatch(/toast--error/); // toast
      expect(view.innerHTML).toMatch(/error-state/); // 页内错误条
      expect(view.innerHTML).toContain('证据 ref 格式非法'); // FR-WR-5 分类文案
    });
    handle.destroy();
  });

  it('错误面 not_found（404）：双呈现 + 「证据不存在」语义', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse({ ok: false, code: 'not_found', message: '证据不存在' }, 404));
    const handle = mountObserveEvidencePage(ctx, {});
    const submit = view.listeners.get('submit')![0];
    (submit as (ev: unknown) => void)(submitWithValue('task:task-none00000'));
    await vi.waitFor(() => {
      expect(view.innerHTML).toMatch(/toast--error/);
      expect(view.innerHTML).toContain('对象不存在');
      expect(view.innerHTML).toContain('not_found'); // 错误码可溯
    });
    handle.destroy();
  });

  it('网络失败：断网口径文案双呈现', async () => {
    const { ctx, view } = makeCtx(async () => { throw new TypeError('fetch failed'); });
    const handle = mountObserveEvidencePage(ctx, {});
    const submit = view.listeners.get('submit')![0];
    (submit as (ev: unknown) => void)(submitWithValue('task:task-11112222'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('连接断开，操作结果未知'));
    handle.destroy();
  });

  it('错误后重查成功：错误区被结果区替换', async () => {
    let fail = true;
    const { ctx, view } = makeCtx(async () => (fail
      ? jsonResponse({ ok: false, code: 'not_found', message: '证据不存在' }, 404)
      : jsonResponse(evidenceRow())));
    const handle = mountObserveEvidencePage(ctx, {});
    const submit = view.listeners.get('submit')![0];
    (submit as (ev: unknown) => void)(submitWithValue('task:task-11112222'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('对象不存在'));
    fail = false;
    (submit as (ev: unknown) => void)(submitWithValue('task:task-11112222'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    expect(view.innerHTML).not.toContain('对象不存在');
    handle.destroy();
  });

  it('复制按钮：剪贴板被拒/缺失 → 如实降级提示（不静默）', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
    const { ctx, view } = makeCtx(async () => jsonResponse(evidenceRow()));
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    const click = view.listeners.get('click')![0];
    (click as (ev: unknown) => void)({ preventDefault: () => {}, target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'copy-ref', ref: 'task:task-11112222' } } : null) } });
    await vi.waitFor(() => expect(view.innerHTML).toContain('复制失败（浏览器剪贴板不可用或未授权）'));
    handle.destroy();
  });

  it('复制按钮：点击写入剪贴板并反馈「已复制」', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => { writes.push(t); } } });
    const { ctx, view } = makeCtx(async () => jsonResponse(evidenceRow()));
    const handle = mountObserveEvidencePage(ctx, { ref: 'task:task-11112222' });
    await vi.waitFor(() => expect(view.innerHTML).toContain('abcdef012345'));
    const click = view.listeners.get('click')![0];
    (click as (ev: unknown) => void)({ preventDefault: () => {}, target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'copy-ref', ref: 'task:task-11112222' } } : null) } });
    await vi.waitFor(() => expect(writes).toEqual(['task:task-11112222']));
    await vi.waitFor(() => expect(view.innerHTML).toContain('已复制'));
    handle.destroy();
  });
});

// ---------- FR-O-4 入口②：任务详情证据区（7-3 随批修复） ----------

describe('7-3 evidenceRowsOf（TaskEvidenceChain 实测形状 → 证据 ref 行）', () => {
  it('任务链派生：task:<id> + trace_event:<eventId> + failure:<recordId> + memory:<memoryId>', () => {
    const rows = evidenceRowsOf({
      ok: true,
      taskId: 'task-1111',
      trace: { eventIds: ['evt-1', 'evt-2'] },
      failures: [{ recordId: 'rec-1', subClass: 'x', occurredAt: '2026-10-01T10:00:00.000Z' }],
      memories: [{ memoryId: 'mem-1', status: 'active', createdAt: '2026-10-01T10:00:00.000Z' }],
    });
    expect(rows).toEqual([
      { ref: 'task:task-1111', kind: 'task' },
      { ref: 'trace_event:evt-1', kind: 'trace_event' },
      { ref: 'trace_event:evt-2', kind: 'trace_event' },
      { ref: 'failure:rec-1', kind: 'failure' },
      { ref: 'memory:mem-1', kind: 'memory' },
    ]);
  });

  it('空链/异常形状防御 → 空数组（空态「本任务未登记证据引用」判据）', () => {
    expect(evidenceRowsOf(null)).toEqual([]);
    expect(evidenceRowsOf({ ok: true, taskId: 'task-x', trace: { eventIds: [] }, failures: [], memories: [] })).toEqual([{ ref: 'task:task-x', kind: 'task' }]);
    expect(evidenceRowsOf('junk')).toEqual([]);
  });
});
