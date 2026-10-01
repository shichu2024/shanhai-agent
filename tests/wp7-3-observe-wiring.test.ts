import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { boot } from '../src/portal/ui/main.js';
import { parseHash } from '../src/portal/ui/routes.js';
import { renderContent } from '../src/portal/ui/pages.js';
import { resetSharedObserveCache } from '../src/portal/ui/observeCache.js';
import type { TimerHost } from '../src/portal/ui/poll.js';

// 第七阶段批次三（7-3/4）：观测面接线——renderContent 观测族由「建设中」占位换为
// 数据页加载壳（随批契约迁移：wp7-1 占位断言同步收窄到 agents 族）；main.boot
// mountPage 五路由接线（总控/能力/演进/演进详情/证据）。TDD 红阶段先行。

const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

// ---------- renderContent（pages.ts） ----------

describe('7-3 pages.renderContent（观测族占位 → 数据页加载壳）', () => {
  it('观测五路由渲染页签 + 加载态（建设中占位已由本批交付替换）', () => {
    for (const hash of ['#/observe', '#/observe/capabilities', '#/observe/evolution', '#/observe/evolution/c-1', '#/observe/evidence']) {
      const { route } = parseHash(hash);
      const html = renderContent(route, {});
      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain('加载中');
      expect(html).not.toContain('建设中'); // 观测族不再是占位
      expect(html).toContain('总控'); // 二级页签组随页渲染
      expect(PLACEHOLDER_BEASTS.test(html)).toBe(false);
    }
  });

  it('agents 族已由批次 7-4 交付：渲染加载态壳（随批契约迁移：本断言由占位断言收窄而来）', () => {
    for (const hash of ['#/agents', '#/agents/ag-1']) {
      const { route } = parseHash(hash);
      const html = renderContent(route, {});
      expect(html).toContain('加载中');
      expect(html).not.toContain('建设中');
    }
  });
});

// ---------- boot mountPage 接线 ----------

interface StubElement {
  id: string;
  innerHTML: string;
  textContent: string;
  value: string;
  className: string;
  dataset: Record<string, string>;
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
}

function stubElement(id: string, dataset: Record<string, string> = {}): StubElement {
  const el: StubElement = {
    id, innerHTML: '', textContent: '', value: '', className: '',
    dataset: { ...dataset }, listeners: new Map(),
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { const arr = el.listeners.get(type) ?? []; el.listeners.set(type, arr.filter((f) => f !== fn)); },
  };
  return el;
}

function stubDocument() {
  const byId = new Map<string, StubElement>();
  const navEls: StubElement[] = [];
  const doc = {
    hidden: false,
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (sel: string) => (sel.includes('data-nav') ? [...navEls] : []),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  function reg(id: string, dataset: Record<string, string> = {}): StubElement {
    const el = stubElement(id, dataset);
    byId.set(id, el);
    return el;
  }
  function regNav(key: string): StubElement {
    const el = stubElement(`nav-${key}`, { nav: key });
    navEls.push(el);
    return el;
  }
  return { doc, reg, regNav, byId, navEls };
}

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => { map.clear(); },
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  };
}

function fakeTimerHost(): { host: TimerHost; timers: Array<{ fn: () => void; ms: number }> } {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const host: TimerHost = {
    set: (fn: () => void, ms: number) => {
      const id = nextId++;
      const t = { fn, ms, id };
      timers.push(t);
      return id;
    },
    clear: (h: unknown) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return { host, timers };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe('7-3 boot mountPage（观测五路由接线）', () => {
  beforeEach(() => {
    resetSharedObserveCache();
    vi.stubGlobal('sessionStorage', fakeStorage());
    vi.stubGlobal('history', { replaceState: vi.fn() });
  });
  afterEach(() => { vi.unstubAllGlobals(); resetSharedObserveCache(); });

  function makeShell(hash: string, fetchImpl: (path: string) => Promise<Response>) {
    vi.stubGlobal('location', { hash, pathname: '/', search: '', replace: vi.fn() });
    const shell = stubDocument();
    shell.reg('view');
    shell.reg('token-state');
    shell.reg('connection-indicator');
    shell.reg('app-version');
    shell.reg('token-form');
    shell.reg('token-input');
    shell.regNav('tasks'); shell.regNav('approvals'); shell.regNav('observe');
    const { host } = fakeTimerHost();
    boot({ document: shell.doc as unknown as Document, window: { addEventListener: () => {} } as unknown as Window, timerHost: host, fetchImpl: fetchImpl as unknown as typeof fetch });
    return shell;
  }

  it('#/observe → 总控控制器挂载（三端点拉取渲染任务统计）', async () => {
    const shell = makeShell('#/observe', async (path) => {
      if (path === '/api/tasks?limit=100' || path === '/api/tasks?limit=1') return jsonResponse({ tasks: [{ taskId: 'task-99998888', agentId: 'ag', status: 'running', createdAt: '2026-10-01T10:00:00.000Z', endedAt: null }], total: 1 });
      if (path === '/api/approvals?pending=true') return jsonResponse([]);
      if (path === '/api/capabilities') return jsonResponse([]);
      return jsonResponse([]);
    });
    await vi.waitFor(() => expect(shell.byId.get('view')!.innerHTML).toContain('task-9999'));
    expect(shell.navEls.find((n) => n.dataset.nav === 'observe')!.className).toContain('active');
  });

  it('#/observe/capabilities → 能力页挂载；#/observe/evolution → 演进页挂载（三组渲染）', async () => {
    const cap = makeShell('#/observe/capabilities', async (path) => {
      if (path === '/api/tasks?limit=100' || path === '/api/tasks?limit=1') return jsonResponse({ tasks: [], total: 0 });
      if (path === '/api/capabilities') return jsonResponse([{ capabilityId: 'cap-77776666', agentId: 'ag-1', kind: 'capability', origin: 'derived', statement: 's', statementDigest: 'd', status: 'active', evidenceRefs: [], evidencePending: true, createdAt: '2026-10-01T09:00:00.000Z', decidedAt: null, decidedBy: null }]);
      return jsonResponse([]);
    });
    await vi.waitFor(() => expect(cap.byId.get('view')!.innerHTML).toContain('cap-7777'));

    const evo = makeShell('#/observe/evolution', async (path) => {
      if (path === '/api/evolution') return jsonResponse([{ candidateId: 'cand-55554444', agentId: 'ag-1', trigger: 'repeated_failure', evidenceRefs: '[]', status: 'open', proposedChange: 'p', createdAt: '2026-10-01T09:00:00.000Z', decidedAt: null, decidedBy: null, derivedVersionIds: '[]', dismissedAt: null }]);
      if (path === '/api/tasks?limit=1') return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse([]);
    });
    await vi.waitFor(() => expect(evo.byId.get('view')!.innerHTML).toContain('cand-5555'));
  });

  it('#/observe/evidence?ref= 直落查询（详情路由同理经 mountPage）', async () => {
    const shell = makeShell('#/observe/evidence?ref=task%3Atask-11112222', async (path) => {
      if (path === '/api/evidence/task%3Atask-11112222') return jsonResponse({ ref: 'task:task-11112222', kind: 'task', status: 'verified', occurredAt: '2026-10-01T10:00:00.000Z', digest: 'abcdef0123456789', payload: '{}' });
      if (path === '/api/tasks?limit=1') return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse([]);
    });
    await vi.waitFor(() => expect(shell.byId.get('view')!.innerHTML).toContain('abcdef012345'));
  });
});
