import { describe, expect, it, vi, afterEach } from 'vitest';
import { boot } from '../src/portal/ui/main.js';
import type { TimerHost } from '../src/portal/ui/poll.js';

// 每日优化第十六批（TASK-163）：src/portal/ui/main.ts 分支覆盖加固（基线分支 81.25%）。
// 本文件覆盖 mountPage 路由 switch 未消化臂（132 task-detail / 134 approval-detail /
// 138 observe-evolution-detail / 140 agents / 141 agent-detail）与 Token 预填分支（191）。
// fetchImpl 注入「记录路径 + 永不决议」——boot 同步渲染后控制器挂起在首拉；
// 断言口径 = 控制器加载壳 + 发起的读面端点（switch 臂接线正确 = 正确控制器挂载）。

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
  const doc = {
    hidden: false,
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: () => [] as StubElement[],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  function reg(id: string): StubElement {
    const el = stubElement(id);
    byId.set(id, el);
    return el;
  }
  return { doc, reg, byId };
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

function fakeTimerHost(): TimerHost {
  return { set: () => 1, clear: () => {} }; // 永不触发（控制器轮询挂起，骨架保持）
}

function fakeWindow(): Window {
  return { addEventListener: () => {} } as unknown as Window;
}

/** 永不决议的 fetch（首拉挂起）——同时记录请求路径（switch 臂接线 = 正确控制器发起正确读面） */
function recordingNeverFetch(paths: string[]): typeof fetch {
  return ((input: RequestInfo | URL) => {
    paths.push(String(input));
    return new Promise(() => {}) as unknown as Promise<Response>;
  }) as unknown as typeof fetch;
}

function stubGlobals(hash: string, token?: string) {
  vi.stubGlobal('sessionStorage', fakeStorage());
  if (token) sessionStorage.setItem('shanhai-portal-token', token);
  vi.stubGlobal('location', { hash, pathname: '/', search: '', replace: vi.fn() });
  vi.stubGlobal('history', { replaceState: vi.fn() });
}

afterEach(() => { vi.unstubAllGlobals(); });

function bootShell(hash: string, token?: string) {
  stubGlobals(hash, token);
  const shell = stubDocument();
  const view = shell.reg('view');
  const tokenInput = shell.reg('token-input');
  shell.reg('token-form');
  shell.reg('token-state');
  shell.reg('connection-indicator');
  shell.reg('app-version');
  const paths: string[] = [];
  boot({
    document: shell.doc as unknown as Document,
    window: fakeWindow(),
    timerHost: fakeTimerHost(),
    fetchImpl: recordingNeverFetch(paths),
  });
  return { view, tokenInput, paths };
}

describe('wp163 main.ts mountPage 路由 switch 臂：详情/目录族挂载（main.ts:132/134/138/140/141）', () => {
  it('#/tasks/<id> → 任务详情控制器挂载并发起 /api/tasks/<id> 三读面', () => {
    const { view, paths } = bootShell('#/tasks/task-abcdef123456');
    expect(view.innerHTML).toContain('loading-state'); // 控制器加载壳
    expect(paths).toContain('/api/tasks/task-abcdef123456');
    expect(paths).toContain('/api/tasks/task-abcdef123456/events');
    expect(paths).toContain('/api/tasks/task-abcdef123456/evidence');
  });

  it('#/approvals/<id> → 审批详情控制器挂载并发起 /api/approvals/<id>', () => {
    const { view, paths } = bootShell('#/approvals/appr-00123456');
    expect(view.innerHTML).toContain('loading-state');
    expect(paths).toContain('/api/approvals/appr-00123456');
  });

  it('#/observe/evolution/<id> → 演进详情骨架（观测页签 + 详情标题）', () => {
    const { view } = bootShell('#/observe/evolution/evo-987654321');
    expect(view.innerHTML).toContain('观测·女娲·演进·详情（evo-987');
    expect(view.innerHTML).toContain('观测二级导航');
  });

  it('#/agents → Agent 目录控制器挂载并发起任务/能力读面', () => {
    const { view, paths } = bootShell('#/agents');
    expect(view.innerHTML).toContain('loading-state');
    expect(paths.some((p) => p.startsWith('/api/tasks?limit='))).toBe(true);
    expect(paths).toContain('/api/capabilities');
  });

  it('#/agents/<id> → Agent 详情骨架', () => {
    const { view } = bootShell('#/agents/ag-1234567890');
    expect(view.innerHTML).toContain('Agent 详情（ag-12345');
  });
});

describe('wp163 main.ts Token 预填：会话已有 Token → 输入框回填（main.ts:190-191）', () => {
  it('boot 前 sessionStorage 已有 Token → token-input.value 回填该 Token', () => {
    const { tokenInput } = bootShell('#/tasks', 'wp163-prefilled-token');
    expect(tokenInput.value).toBe('wp163-prefilled-token');
  });
});
