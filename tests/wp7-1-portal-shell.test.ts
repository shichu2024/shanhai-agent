import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { boot, realDeps } from '../src/portal/ui/main.js';
import type { TimerHost } from '../src/portal/ui/poll.js';

// 第七阶段批次一（7-1/4）：全局框架接线（FR-G-1..6）——
// boot 装配：fragment Token 消费 → 旧路由 location.replace → 骨架渲染与导航高亮 →
// Token 表单 → 连接状态指示（探针轮询 + 可见性暂停）。依赖全注入，node 环境可测。

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
  const docListeners = new Map<string, Array<() => void>>();
  const doc = {
    hidden: false,
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (sel: string) => (sel.includes('data-nav') ? [...navEls] : []),
    addEventListener: (t: string, f: () => void) => { docListeners.set(t, [...(docListeners.get(t) ?? []), f]); },
    removeEventListener: (t: string, f: () => void) => { const arr = docListeners.get(t) ?? []; docListeners.set(t, arr.filter((x) => x !== f)); },
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
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

function fakeTimerHost(): { host: TimerHost; timers: Array<{ fn: () => void; ms: number }> } {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  const handles = new Set<unknown>();
  let nextId = 1;
  const host: TimerHost = {
    set: (fn: () => void, ms: number) => {
      const id = nextId++;
      handles.add(id);
      const t = { fn: () => {
        handles.delete(id);
        const i = timers.findIndex((x) => x.id === id);
        if (i >= 0) timers.splice(i, 1); // 触发即出队（真实定时器语义）
        fn();
      }, ms, id };
      timers.push(t);
      return id;
    },
    clear: (h: unknown) => {
      handles.delete(h);
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return { host, timers };
}

function fakeWindow(): { win: Window; listeners: Map<string, () => void> } {
  const listeners = new Map<string, () => void>();
  const win = {
    addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
  };
  return { win: win as unknown as Window, listeners };
}

function stubGlobals(hash: string) {
  const replace = vi.fn();
  vi.stubGlobal('sessionStorage', fakeStorage());
  vi.stubGlobal('location', { hash, pathname: '/', search: '', replace });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  return { replace };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('7-1 shell boot（FR-G 全局框架接线）', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', fakeStorage()); });

  it('缺省 hash 渲染任务页加载壳（应龙神兽行 + 加载态，7-2 数据页由控制器挂载），一级导航高亮 tasks', () => {
    const { replace } = stubGlobals('');
    const shell = stubDocument();
    const view = shell.reg('view');
    const navTasks = shell.regNav('tasks');
    const navApprovals = shell.regNav('approvals');
    const tokenForm = shell.reg('token-form');
    const tokenState = shell.reg('token-state');
    const conn = shell.reg('connection-indicator');
    boot({ document: shell.doc as unknown as Document, window: fakeWindow().win, timerHost: fakeTimerHost().host });
    expect(view.innerHTML).toContain('应龙');
    expect(view.innerHTML).toContain('加载中');
    expect(replace).not.toHaveBeenCalled();
    expect(navTasks.className).toContain('active');
    expect(navApprovals.className).not.toContain('active');
    expect(tokenForm.listeners.size).toBeGreaterThan(0); // Token 表单已接线
    expect(tokenState.textContent).toBe('未设置');
    expect(conn.textContent.length).toBeGreaterThan(0); // 连接指示有初始文案
  });

  it('旧路由 location.replace 一次性改写（#/capabilities → #/observe/capabilities），服务端零变更', () => {
    const { replace } = stubGlobals('#/capabilities');
    const shell = stubDocument();
    shell.reg('view');
    boot({ document: shell.doc as unknown as Document, window: fakeWindow().win, timerHost: fakeTimerHost().host });
    expect(replace).toHaveBeenCalledWith('#/observe/capabilities');
  });

  it('hashchange 重渲染并切换导航高亮（tasks → approvals）', () => {
    stubGlobals('#/tasks');
    const shell = stubDocument();
    const view = shell.reg('view');
    const navTasks = shell.regNav('tasks');
    const navApprovals = shell.regNav('approvals');
    let hashFn: (() => void) | undefined;
    const win = { addEventListener: (t: string, f: () => void) => { if (t === 'hashchange') hashFn = f; } };
    boot({ document: shell.doc as unknown as Document, window: win as unknown as Window, timerHost: fakeTimerHost().host });
    expect(view.innerHTML).toContain('应龙');
    (globalThis.location as unknown as { hash: string }).hash = '#/approvals';
    hashFn!();
    expect(view.innerHTML).toContain('玄武');
    expect(navApprovals.className).toContain('active');
    expect(navTasks.className).not.toContain('active');
  });

  it('Token 表单提交：存 sessionStorage、状态文案「已设置」、触发重渲染；清空则移除', () => {
    stubGlobals('#/tasks');
    const shell = stubDocument();
    const form = shell.reg('token-form');
    const input = shell.reg('token-input');
    const state = shell.reg('token-state');
    boot({ document: shell.doc as unknown as Document, window: fakeWindow().win, timerHost: fakeTimerHost().host });
    input.value = 'tok-xyz';
    const submit = form.listeners.get('submit')![0];
    submit({ preventDefault: () => {} });
    expect(sessionStorage.getItem('shanhai-portal-token')).toBe('tok-xyz');
    expect(state.textContent).toBe('已设置');
    input.value = '';
    submit({ preventDefault: () => {} });
    expect(sessionStorage.getItem('shanhai-portal-token')).toBeNull();
    expect(state.textContent).toBe('未设置');
  });

  it('连接指示探针：带 Token 请求 GET /api/tasks?limit=1 携 Authorization；成功→已连接；连续 2 次网络失败→重连中（§11-3）', async () => {
    stubGlobals('#/nope'); // not-found 无数据控制器——探针为唯一 fetch 源（随批迁移：#/agents 已由 7-4 挂目录控制器，#/observe 已由 7-3 挂总控控制器）
    const shell = stubDocument();
    shell.reg('view');
    const conn = shell.reg('connection-indicator');
    sessionStorage.setItem('shanhai-portal-token', 'tok-1');
    const calls: Array<{ path: string; init: RequestInit }> = [];
    let mode: 'ok' | 'net-error' = 'ok';
    const fetchImpl = vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      if (mode === 'net-error') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const { host, timers } = fakeTimerHost();
    boot({ document: shell.doc as unknown as Document, window: fakeWindow().win, timerHost: host, fetchImpl: fetchImpl as unknown as typeof fetch });
    timers[0].fn(); // 探针首拍
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe('/api/tasks?limit=1');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(conn.textContent).toContain('已连接');
    mode = 'net-error';
    timers[timers.length - 1].fn(); // 失败 1
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(conn.textContent).toContain('已连接'); // 第 1 次失败仍算已连接
    timers[timers.length - 1].fn(); // 失败 2
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(conn.textContent).toContain('重连中');
  });

  it('无 Token 时探针不发请求，指示为未认证提示', async () => {
    stubGlobals('#/nope'); // not-found 无数据控制器（随批迁移：#/agents 已由 7-4 挂目录控制器）
    const shell = stubDocument();
    shell.reg('view');
    const conn = shell.reg('connection-indicator');
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    const { host, timers } = fakeTimerHost();
    boot({ document: shell.doc as unknown as Document, window: fakeWindow().win, timerHost: host, fetchImpl: fetchImpl as unknown as typeof fetch });
    timers[0].fn();
    await Promise.resolve();
    const probeCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('limit=1'));
    expect(probeCalls).toHaveLength(0);
    expect(conn.textContent).toContain('Token');
  });

  it('realDeps：从全局环境装配（浏览器实跑路径）', () => {
    const shell = stubDocument();
    vi.stubGlobal('document', shell.doc);
    vi.stubGlobal('location', { hash: '#/tasks', pathname: '/', search: '', replace: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    const deps = realDeps();
    expect(deps.document).toBe(shell.doc);
    expect(typeof deps.timerHost.set).toBe('function');
  });
});
