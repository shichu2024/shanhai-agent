// 第七阶段批次三（7-3/4）：页面控制器挂载测试共用桩（与 7-2 wp7-2-* 测试同款纪律——
// node 环境无 DOM，view/doc/timerHost 全注入桩；listeners Map 供测试直接派发事件）。

export interface StubEl {
  innerHTML: string;
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
}

export function stubViewEl(): StubEl {
  const el: StubEl = {
    innerHTML: '',
    listeners: new Map(),
    addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { const arr = el.listeners.get(type) ?? []; el.listeners.set(type, arr.filter((f) => f !== fn)); },
  };
  return el;
}

export interface StubDoc {
  hidden: boolean;
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
}

export function stubDoc(): StubDoc {
  const listeners = new Map<string, Array<(ev?: unknown) => void>>();
  return {
    hidden: false,
    addEventListener: (t, f) => { listeners.set(t, [...(listeners.get(t) ?? []), f]); },
    removeEventListener: (t, f) => { const arr = listeners.get(t) ?? []; listeners.set(t, arr.filter((x) => x !== f)); },
    listeners,
  };
}

export interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
}

/** 触发即出队（7-1 经验：fakeTimerHost 须「触发即出队」——真实定时器语义） */
export function fakeTimerHost(): { host: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }; timers: FakeTimer[] } {
  const timers: FakeTimer[] = [];
  let seq = 0;
  const removeById = (h: unknown): void => {
    const i = timers.findIndex((x) => x.id === h);
    if (i >= 0) timers.splice(i, 1);
  };
  const host = {
    set: (fn: () => void, ms: number): unknown => {
      seq += 1;
      const id = seq;
      timers.push({
        id,
        ms,
        fn: () => {
          removeById(id); // 触发即出队
          fn();
        },
      });
      return id;
    },
    clear: removeById,
  };
  return { host, timers };
}

export function clickEvent(dataset: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    preventDefault: () => {},
    ...extra,
    target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset } : null) },
  };
}

export function submitEvent(target?: unknown): Record<string, unknown> {
  return { preventDefault: () => {}, ...(target !== undefined ? { target } : {}) };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

export function makeSessionStorageStub(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => { map.clear(); },
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, v); },
  };
}
