import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { boot } from '../src/portal/ui/main.js';
import type { TimerHost } from '../src/portal/ui/poll.js';

// 每日优化第十二批（TASK-151）：ui/main.ts 分支覆盖加固（基线分支 77.58%，未覆盖 179/183）——
// 连接指示区点击重连（§10.4）与页面可见性轮询暂停/恢复（FR-G-4）两个全局监听回调。
// 依赖注入桩与 wp7-1-portal-shell 同款纪律（本文件自带最小桩，不改动既有测试）。

interface StubEl {
  id: string;
  innerHTML: string;
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
}

function stubEl(id: string): StubEl {
  const el: StubEl = {
    id, innerHTML: '', textContent: '', className: '', dataset: {}, listeners: new Map(),
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { const a = el.listeners.get(type) ?? []; el.listeners.set(type, a.filter((f) => f !== fn)); },
  };
  return el;
}

function stubDoc() {
  const byId = new Map<string, StubEl>();
  const docListeners = new Map<string, Array<() => void>>();
  const doc = {
    hidden: false,
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: () => [] as StubEl[],
    addEventListener: (t: string, f: () => void) => { docListeners.set(t, [...(docListeners.get(t) ?? []), f]); },
    removeEventListener: (t: string, f: () => void) => { const a = docListeners.get(t) ?? []; docListeners.set(t, a.filter((x) => x !== f)); },
  };
  return { doc, byId, docListeners, reg: (id: string) => { const el = stubEl(id); byId.set(id, el); return el; } };
}

function fakeTimerHost() {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let seq = 0;
  const remove = (h: unknown): void => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); };
  const host: TimerHost = {
    set: (fn, ms) => { seq += 1; const id = seq; timers.push({ id, ms, fn: () => { remove(id); fn(); } }); return id; },
    clear: remove,
  };
  return { host, timers };
}

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  };
}

const fakeWindow = { addEventListener: () => {} };

async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('wp151 shell 全局监听回调：连接区点击重连 + 可见性暂停/恢复（ui/main.ts:178-184）', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', fakeStorage()); });

  it('断开态点击连接指示区 → 立即触发探针（携带 Authorization 重连，§10.4）', async () => {
    vi.stubGlobal('location', { hash: '#/nope', pathname: '/', search: '', replace: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    const shell = stubDoc();
    shell.reg('view');
    const conn = shell.reg('connection-indicator');
    sessionStorage.setItem('shanhai-portal-token', 'tok-click');
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    const { host } = fakeTimerHost();
    boot({ document: shell.doc as unknown as Document, window: fakeWindow as unknown as Window, timerHost: host, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled(); // start() 仅排程，探针未发
    const clicks = conn.listeners.get('click')!;
    expect(clicks.length).toBeGreaterThan(0); // 点击监听已接线
    clicks[0]();
    await flushMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe('/api/tasks?limit=1');
    expect(conn.textContent).toContain('已连接');
  });

  it('visibilitychange：不可见暂停轮询（清待发计时器），恢复可见立即拉一次（FR-G-4）', async () => {
    vi.stubGlobal('location', { hash: '#/nope', pathname: '/', search: '', replace: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    const shell = stubDoc();
    shell.reg('view');
    shell.reg('connection-indicator');
    sessionStorage.setItem('shanhai-portal-token', 'tok-vis');
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    const { host, timers } = fakeTimerHost();
    boot({ document: shell.doc as unknown as Document, window: fakeWindow as unknown as Window, timerHost: host, fetchImpl: fetchImpl as unknown as typeof fetch });
    const onVis = shell.docListeners.get('visibilitychange')!;
    expect(onVis.length).toBeGreaterThan(0);
    // 不可见：待发探针计时器被清（不再发请求）
    expect(timers.length).toBeGreaterThan(0);
    shell.doc.hidden = true;
    onVis[0]();
    expect(timers).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    // 恢复可见：立即拉一次并重启周期
    shell.doc.hidden = false;
    onVis[0]();
    await flushMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timers.length).toBeGreaterThan(0); // 周期已重启
  });

  it('骨架元素缺失形态（防御）：无 view/token-input/connection-indicator —— boot 不崩、表单提交走清空路径、路由渲染早退', async () => {
    vi.stubGlobal('location', { hash: '#/tasks', pathname: '/', search: '', replace: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    const shell = stubDoc();
    const form = shell.reg('token-form'); // 仅表单在场，token-input/view/连接指示全缺
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    const { host } = fakeTimerHost();
    boot({ document: shell.doc as unknown as Document, window: fakeWindow as unknown as Window, timerHost: host, fetchImpl: fetchImpl as unknown as typeof fetch });
    sessionStorage.setItem('shanhai-portal-token', 'tok-stale');
    form.listeners.get('submit')![0]({ preventDefault: () => {} }); // input 缺失 → 空值 → clearToken
    await flushMicrotasks();
    expect(sessionStorage.getItem('shanhai-portal-token')).toBeNull(); // 无输入框 → 清空而非保存
  });
});
