import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountObserveEvolutionDetailPage } from '../src/portal/ui/observeEvolutionDetailPage.js';
import { mountObserveEvolutionPage } from '../src/portal/ui/observeEvolutionPage.js';
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

// 第七阶段批次三（7-3/4）：观测·女娲·演进（FR-O-3）——列表按 status 三枚举分组 +
// 详情侧栏五区；整页只读无任何操作按钮（confirm/dismiss 属 D-45 延后）。
// 删除项：/api/evolution/status、/api/evolution/suggestions、diff/pattern 字段零引用。
// TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;
const FORBIDDEN = /\/api\/evolution\/status|\/api\/evolution\/suggestions/;

function candidateRow(partial: Partial<Record<string, unknown>> & { candidateId: string }): Record<string, unknown> {
  return {
    candidateId: 'cand-0000aaaa',
    agentId: 'ag-1',
    trigger: 'repeated_failure',
    evidenceRefs: JSON.stringify([
      { taskId: 'task-1111', agentVersionId: 'ver-1', subClass: 'tool.shell.timeout', occurredAt: '2026-10-01T10:00:00.000Z' },
    ]),
    status: 'open',
    proposedChange: '建议人工评审 shell 超时失败模式',
    createdAt: '2026-10-01T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    derivedVersionIds: '[]',
    dismissedAt: null,
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

describe('7-3 mountObserveEvolutionPage（FR-O-3 列表：三状态分组）', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-3' }));
    vi.stubGlobal('location', { hash: '#/observe/evolution' });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const rows = [
    candidateRow({ candidateId: 'cand-0000open1', status: 'open' }),
    candidateRow({ candidateId: 'cand-0000conf1', status: 'confirmed', decidedAt: '2026-10-01T10:30:00.000Z', decidedBy: 'op-x' }),
    candidateRow({ candidateId: 'cand-0000dism1', status: 'dismissed', dismissedAt: '2026-10-01T10:40:00.000Z', decidedAt: '2026-10-01T10:40:00.000Z', decidedBy: 'op-y' }),
    candidateRow({ candidateId: 'cand-0000open2', status: 'open', trigger: 'capability_degradation' }),
  ];

  it('GET /api/evolution 全量 → open/confirmed/dismissed 三组，组头中文计数；行投影齐全', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      expect(path).toBe('/api/evolution');
      return jsonResponse(rows);
    });
    const handle = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('cand-0000'));
    // 三组中文组头
    expect(view.innerHTML).toContain('待决策');
    expect(view.innerHTML).toContain('已确认');
    expect(view.innerHTML).toContain('已驳回');
    // 行投影：candidateId 短码 + 悬停全码、agentId、trigger 中文、proposedChange 摘要、decidedAt（无则 —）
    expect(view.innerHTML).toContain('cand-0000open1');
    expect(view.innerHTML).toContain('ag-1');
    expect(view.innerHTML).toContain('重复失败');
    expect(view.innerHTML).toContain('能力退化');
    expect(view.innerHTML).toContain('建议人工评审 shell 超时失败模式');
    expect(view.innerHTML).toContain('—'); // open 行 decidedAt 为 —
    // 行点击跳详情路由
    expect(view.innerHTML).toContain('href="#/observe/evolution/cand-0000open1"');
    expect(PLACEHOLDER_BEASTS.test(view.innerHTML)).toBe(false);
    expect(FORBIDDEN.test(view.innerHTML)).toBe(false);
    handle.destroy();
  });

  it('proposedChange 首行截断 80 字符 + 悬停全文', async () => {
    const long = candidateRow({ candidateId: 'cand-long0000', proposedChange: `首行${'长'.repeat(100)}\n第二行` });
    const { ctx, view } = makeCtx(async () => jsonResponse([long]));
    const handle = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('cand-long00'));
    expect(view.innerHTML).toContain('首行');
    expect(view.innerHTML).not.toContain('第二行'); // 只取首行
    expect(view.innerHTML).toContain(`首行${'长'.repeat(78)}…`); // 80 字符含前缀「首行」
    handle.destroy();
  });

  it('整页只读：无任何操作按钮（无 confirm/dismiss、无任何写操作 data-action）', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse(rows));
    const handle = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('cand-0000'));
    expect(view.innerHTML).not.toMatch(/data-action="(confirm|dismiss|approve|deny|cancel|resume|crash-recovery)"/);
    expect(view.innerHTML).not.toMatch(/<button[^>]*(确认|驳回|决策)/);
    handle.destroy();
  });

  it('空候选 → 空态；轮询 10s；visibilitychange 暂停；destroy 清计时器', async () => {
    const { ctx, view, timers, doc } = makeCtx(async () => jsonResponse([]));
    const handle = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('暂无演进候选'));
    expect(timers.every((t) => t.ms === 10_000)).toBe(true);
    (doc.listeners.get('visibilitychange')![0] as (ev?: unknown) => void)({ target: { hidden: true } } as unknown as Event);
    expect(timers).toHaveLength(0);
    handle.destroy();
  });

  it('读面 401：认证失效提示并停轮询（§11-2）', async () => {
    const { ctx, view, timers } = makeCtx(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401));
    const handle = mountObserveEvolutionPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('认证失效'));
    expect(timers).toHaveLength(0);
    handle.destroy();
  });
});

describe('7-3 mountObserveEvolutionDetailPage（FR-O-3 详情五区）', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-3' }));
    vi.stubGlobal('location', { hash: '#/observe/evolution/cand-0000aaaa' });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const detail = candidateRow({
    evidenceRefs: JSON.stringify([
      { taskId: 'task-1111', agentVersionId: 'ver-1', subClass: 'tool.shell.timeout', occurredAt: '2026-10-01T10:00:00.000Z' },
      { taskId: 'task-2222', agentVersionId: 'ver-1', subClass: 'tool.http.dns', occurredAt: '2026-10-01T10:05:00.000Z' },
    ]),
    proposedChange: '第一行\n第二行全文保留',
  });

  it('五区渲染：状态徽章 / trigger+createdAt / proposedChange 全文等宽 / evidenceRefs 可点击跳证据页 / 决定信息', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      expect(path).toBe('/api/evolution/cand-0000aaaa');
      return jsonResponse(detail);
    });
    const handle = mountObserveEvolutionDetailPage(ctx, 'cand-0000aaaa');
    await vi.waitFor(() => expect(view.innerHTML).toContain('待决策')); // ① 状态徽章（open）
    // ② trigger + createdAt
    expect(view.innerHTML).toContain('重复失败');
    expect(view.innerHTML).toContain('2026-10-01'); // 本地化 createdAt（时区随宿主，仅断言日期段）
    // ③ proposedChange 全文（等宽预格式化，含第二行）
    expect(view.innerHTML).toContain('第二行全文保留');
    expect(view.innerHTML).toMatch(/<pre/); // 等宽预格式化
    // ④ evidenceRefs：每条可点击跳 #/observe/evidence?ref=task:<taskId>
    expect(view.innerHTML).toContain('href="#/observe/evidence?ref=task%3Atask-1111"');
    expect(view.innerHTML).toContain('href="#/observe/evidence?ref=task%3Atask-2222"');
    expect(view.innerHTML).toContain('tool.shell.timeout');
    // ⑤ open 态显「尚未决策」
    expect(view.innerHTML).toContain('尚未决策');
    expect(PLACEHOLDER_BEASTS.test(view.innerHTML)).toBe(false);
    handle.destroy();
  });

  it('已决议候选：决定信息显 decidedAt/decidedBy，不显「尚未决策」', async () => {
    const decided = candidateRow({ candidateId: 'cand-dead0000', status: 'confirmed', decidedAt: '2026-10-01T10:30:00.000Z', decidedBy: 'op-x' });
    const { ctx, view } = makeCtx(async () => jsonResponse(decided));
    const handle = mountObserveEvolutionDetailPage(ctx, 'cand-dead0000');
    await vi.waitFor(() => expect(view.innerHTML).toContain('已确认'));
    expect(view.innerHTML).toContain('op-x');
    expect(view.innerHTML).not.toContain('尚未决策');
    handle.destroy();
  });

  it('404 not_found：错误条显分类文案 + 返回列表出口', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse({ ok: false, code: 'not_found', message: '演进候选不存在：x' }, 404));
    const handle = mountObserveEvolutionDetailPage(ctx, 'cand-missing0');
    await vi.waitFor(() => expect(view.innerHTML).toContain('对象不存在'));
    expect(view.innerHTML).toContain('#/observe/evolution');
    handle.destroy();
  });

  it('evidenceRefs 异常形态防御：非 JSON → 空列表渲染，页面不崩', async () => {
    const broken = candidateRow({ candidateId: 'cand-broken0', evidenceRefs: 'not-json' });
    const { ctx, view } = makeCtx(async () => jsonResponse(broken));
    const handle = mountObserveEvolutionDetailPage(ctx, 'cand-broken0');
    await vi.waitFor(() => expect(view.innerHTML).toContain('cand-broken0'.slice(0, 8)));
    handle.destroy();
  });

  it('无写操作按钮（只读边界同列表页）', async () => {
    const { ctx, view } = makeCtx(async () => jsonResponse(detail));
    const handle = mountObserveEvolutionDetailPage(ctx, 'cand-0000aaaa');
    await vi.waitFor(() => expect(view.innerHTML).toContain('待决策'));
    expect(view.innerHTML).not.toMatch(/data-action="(confirm|dismiss|approve|deny|cancel|resume)"/);
    handle.destroy();
  });
});
