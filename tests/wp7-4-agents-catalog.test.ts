import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountAgentsPage } from '../src/portal/ui/agentsPage.js';
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

// 第七阶段批次四（7-4/4）：Agent 目录（设计 V0.3 §7.5 Agent 目录）——轻量列表页。
// 复用 FR-O-2 双源聚合（/api/tasks?limit=100 + /api/capabilities 去重）；
// 每行 agentId + 能力计数（前端按 /api/capabilities 聚合）+「详情」链接；无新增端点。
// TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

function capRow(partial: Partial<Record<string, unknown>> & { capabilityId: string; agentId: string }): Record<string, unknown> {
  return {
    capabilityId: partial.capabilityId,
    agentId: partial.agentId,
    kind: 'capability',
    origin: 'derived',
    statement: '能稳定完成回显',
    statementDigest: 'digest-abc',
    status: 'candidate',
    evidenceRefs: ['task:t-1'],
    evidencePending: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
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

describe('7-4 mountAgentsPage（Agent 目录，§7.5）', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-4' }));
    locationStub = { hash: '#/agents' };
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const defaultFetch = async (path: string): Promise<Response> => {
    if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [taskRow('ag-bravo'), taskRow('ag-bravo'), taskRow('ag-alpha')], total: 3 });
    if (path === '/api/capabilities') return jsonResponse([
      capRow({ capabilityId: 'cap-1', agentId: 'ag-alpha', status: 'active' }),
      capRow({ capabilityId: 'cap-2', agentId: 'ag-alpha', status: 'retired' }),
      capRow({ capabilityId: 'cap-3', agentId: 'ag-alpha', status: 'candidate' }),
      capRow({ capabilityId: 'cap-4', agentId: 'ag-charlie', status: 'candidate', evidenceRefs: [], evidencePending: true }),
    ]);
    throw new Error(`未预期的请求：${path}`);
  };

  it('挂载：双源去重行 + 能力计数（candidate/active/retired）+ 详情链接（encode 形态）', async () => {
    const { ctx, view } = makeCtx(defaultFetch);
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('ag-alpha'));
    expect(view.innerHTML).toContain('Agent 目录');
    expect(view.innerHTML).toContain('无 /api/agents 端点'); // 聚合口径明示
    // 三行去重排序；计数逐行正确
    expect(view.innerHTML.match(/ag-alpha|ag-bravo|ag-charlie/g)?.length).toBeGreaterThanOrEqual(3);
    expect(view.innerHTML).toContain('待确认');
    expect(view.innerHTML).toContain('已生效');
    expect(view.innerHTML).toContain('已退场');
    // 详情链接：#/agents/<encodeURIComponent(id)>（P3-2 备案：断言按 decodeURIComponent 比对）
    const hrefs = [...view.innerHTML.matchAll(/href="#\/agents\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
    expect(hrefs).toContain('ag-alpha');
    expect(hrefs).toContain('ag-bravo');
    expect(hrefs).toContain('ag-charlie');
    expect(PLACEHOLDER_BEASTS.test(view.innerHTML)).toBe(false);
    handle.destroy();
  });

  it('空态：两源均无 agentId → 暂无 Agent 数据出口', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [], total: 0 });
      if (path === '/api/capabilities') return jsonResponse([]);
      throw new Error(`未预期的请求：${path}`);
    });
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('暂无 Agent 数据'));
    handle.destroy();
  });

  it('401 → 登录状态失效提示（去技术化，TASK-128）并停轮询（§11-2）', async () => {
    const { ctx, view, timers } = makeCtx(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'Token 无效' }, 401));
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('登录状态已失效'));
    expect(view.innerHTML).toContain('自动完成登录'); // 恢复路径指向自动送达，非要求用户操作口令
    expect(view.innerHTML).not.toContain('Token'); // 401 态不向用户暴露口令概念
    expect(timers.length).toBe(0); // 轮询已停（authFailed 短路，无后续请求）
    handle.destroy();
  });

  it('destroy：移除监听并停轮询', async () => {
    const { ctx, view, timers } = makeCtx(defaultFetch);
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('ag-alpha'));
    handle.destroy();
    expect(view.listeners.get('click')?.length ?? 0).toBe(0);
    expect(timers.length).toBe(0);
  });
});

describe('7-4 mountAgentsPage 边界面（形状防御 / 可见性）', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-4' }));
    locationStub = { hash: '#/agents' };
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('capabilities 响应非数组 → 目录按 tasks 单源渲染不崩溃', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [taskRow('ag-only')], total: 1 });
      if (path === '/api/capabilities') return jsonResponse({ nope: true });
      throw new Error(`未预期的请求：${path}`);
    });
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('ag-only'));
    expect(view.innerHTML).toContain('待确认 0 / 已生效 0 / 已退场 0');
    handle.destroy();
  });

  it('单源失败降级：capabilities 500 → tasks 单源渲染（下一轮轮询补齐）', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [taskRow('ag-1')], total: 1 });
      if (path === '/api/capabilities') return jsonResponse({ ok: false, code: 'internal_error', message: 'x' }, 500);
      throw new Error(`未预期的请求：${path}`);
    });
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('ag-1'));
    expect(view.innerHTML).toContain('待确认 0 / 已生效 0 / 已退场 0');
    handle.destroy();
  });

  it('两源均失败 → 错误条 + 重试按钮（点击重发恢复）', async () => {
    let fail = true;
    const { ctx, view } = makeCtx(async (path) => {
      if (fail) return jsonResponse({ ok: false, code: 'internal_error', message: 'db down' }, 500);
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [taskRow('ag-1')], total: 1 });
      if (path === '/api/capabilities') return jsonResponse([]);
      throw new Error(`未预期的请求：${path}`);
    });
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('目录加载失败'));
    expect(view.innerHTML).toContain('internal_error：db down');
    expect(view.innerHTML).toContain('重试');
    fail = false;
    const click = view.listeners.get('click')?.[0];
    click?.(clickEvent({ action: 'retry' }));
    await vi.waitFor(() => expect(view.innerHTML).toContain('ag-1'));
    handle.destroy();
  });

  it('visibilitychange：不可见暂停、恢复可见立即拉取', async () => {
    const { ctx, view, doc, timers } = makeCtx(async (path) => {
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [taskRow('ag-1')], total: 1 });
      if (path === '/api/capabilities') return jsonResponse([]);
      throw new Error(`未预期的请求：${path}`);
    });
    const handle = mountAgentsPage(ctx);
    await vi.waitFor(() => expect(view.innerHTML).toContain('ag-1'));
    const vis = doc.listeners.get('visibilitychange')![0];
    vis({ target: { hidden: true } });
    expect(timers.length).toBe(0);
    vis({ target: { hidden: false } });
    await vi.waitFor(() => expect(timers.length).toBe(1));
    handle.destroy();
  });
});
