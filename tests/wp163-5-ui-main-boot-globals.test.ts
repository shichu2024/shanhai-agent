import { describe, expect, it, vi, afterEach } from 'vitest';

// 每日优化第十六批（TASK-163）：src/portal/ui/main.ts 模块级副作用与缺省依赖解析分支
// （main.ts:71-74 opts.* ?? 全局回退 + 197 `typeof document !== 'undefined'` 真臂）。
// 本文件【不得】静态 import main.js——须在全局 document/location/sessionStorage 就绪后
// 动态 import，模块求值即触发 boot(realDeps())。vi.useFakeTimers 吞掉探针 10s 真实定时器；
// 全局 fetch 桩为永不决议——控制器首拉挂起，不产生网络请求。

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

function stubElement(id: string): StubElement {
  const el: StubElement = {
    id, innerHTML: '', textContent: '', value: '', className: '',
    dataset: {}, listeners: new Map(),
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { const arr = el.listeners.get(type) ?? []; el.listeners.set(type, arr.filter((f) => f !== fn)); },
  };
  return el;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('wp163 main.ts 模块副作用：全局依赖形态 boot(realDeps())（main.ts:71-74/197）', () => {
  it('document 存在于全局 → import 即 boot：骨架渲染 + Token 状态文案（缺省依赖四臂全回退）', async () => {
    const byId = new Map<string, StubElement>();
    const doc = {
      hidden: false,
      getElementById: (id: string) => byId.get(id) ?? null,
      querySelectorAll: () => [] as StubElement[],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const view = stubElement('view');
    const tokenState = stubElement('token-state');
    const appVersion = stubElement('app-version');
    const conn = stubElement('connection-indicator');
    byId.set('view', view);
    byId.set('token-state', tokenState);
    byId.set('app-version', appVersion);
    byId.set('connection-indicator', conn);

    const storageMap = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => { storageMap.set(k, v); },
      removeItem: (k: string) => { storageMap.delete(k); },
    });
    vi.stubGlobal('location', { hash: '#/agents', pathname: '/', search: '', replace: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    vi.stubGlobal('addEventListener', vi.fn()); // win=globalThis 的 hashchange 注册
    vi.stubGlobal('document', doc);
    const fetchPaths: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      fetchPaths.push(String(input));
      return new Promise(() => {}) as unknown as Promise<Response>;
    }); // realDeps().fetchImpl → 全局 fetch 桩（记录 + 永不决议）
    vi.useFakeTimers(); // DEFAULT_TIMER_HOST 的 10s 探针定时器不落地

    await import('../src/portal/ui/main.js'); // 模块求值 → boot(realDeps())（197 真臂）

    expect(view.innerHTML).toContain('loading-state'); // Agent 目录控制器以全局 view 挂载加载壳
    expect(fetchPaths.some((p) => p.startsWith('/api/tasks?limit='))).toBe(true); // 控制器首拉已发起（全局 fetch 面）
    expect(fetchPaths).toContain('/api/capabilities');
    expect(tokenState.textContent).toBe('未设置'); // 无 Token 会话态
    expect(appVersion.textContent).toBe(''); // __PORTAL_APP_VERSION__ 未定义（测试形态，非 bundle）
    expect(conn.textContent).toBe('检测中'); // 连接指示初值（探针未触发）

    // 无参形态 boot()：opts.document/window/timerHost/fetchImpl 四路缺省回退（71-74 右臂）
    // ——直接取全局 document/location/sessionStorage/fetch（与 realDeps 同源口径）。
    const mod = await import('../src/portal/ui/main.js');
    const view2 = stubElement('view');
    byId.set('view', view2); // 换新 view 元素，验证无参 boot 的全局解析独立完成渲染
    mod.boot();
    expect(view2.innerHTML).toContain('loading-state'); // boot() 缺省依赖全回退 → Agent 目录控制器再次挂载
    expect(fetchPaths.filter((p) => p.startsWith('/api/tasks?limit=')).length).toBeGreaterThanOrEqual(2);
  });
});
