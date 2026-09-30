// 第七阶段批次一（7-1/4）：轻量数据缓存（FR-G-4：TTL ≤3s + 同页在途请求去重）。
// 现状 app.js 无任何缓存机制，属本次新增设计（§7.1 FR-O-1 缓存口径同源）；
// 时钟注入可测；失败请求不落缓存（下轮重取）。

interface Entry<T> {
  value: T | undefined;
  at: number;
  inflight: Promise<T> | null;
}

export interface PortalCache<T = unknown> {
  get(key: string, fetcher: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  clear(): void;
  size(): number;
}

export function createCache<T>(opts: { ttlMs: number; now: () => number }): PortalCache<T> {
  const store = new Map<string, Entry<T>>();

  return {
    get(key: string, fetcher: () => Promise<T>): Promise<T> {
      const hit = store.get(key);
      if (hit) {
        if (hit.inflight) return hit.inflight;
        if (opts.now() - hit.at <= opts.ttlMs) return Promise.resolve(hit.value as T);
      }
      store.set(key, { value: undefined, at: 0, inflight: null });
      const entry = store.get(key)!;
      const p = (async () => {
        try {
          const value = await fetcher();
          store.set(key, { value, at: opts.now(), inflight: null });
          return value;
        } catch (err) {
          if (store.get(key) === entry) store.delete(key); // 失败不落缓存
          throw err;
        }
      })();
      entry.inflight = p;
      return p;
    },
    invalidate(key: string): void {
      const cur = store.get(key);
      if (cur && cur.inflight) return; // 在途请求不撤销（去重语义优先）
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    size(): number {
      return store.size;
    },
  };
}
