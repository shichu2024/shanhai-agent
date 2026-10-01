// 第七阶段批次三（7-3/4）：观测·总控全局数据缓存（FR-O-1 本批新增设计）。
// 页面切换 5s 内回来不重复拉取：直接渲染缓存，后台由页面轮询（下一周期 >TTL）刷新。
// 实现复用 7-1 createCache（TTL + 在途去重 + 失败不落缓存）；共享单例跨页面挂载存活。

import { createCache, type PortalCache } from './cache.js';

/** 「页面切换 5s 内回来不重复拉取」判据（TASK-103 派发口径） */
export const OBSERVE_CACHE_TTL_MS = 5_000;

export function createObserveCache(now: () => number): PortalCache {
  return createCache({ ttlMs: OBSERVE_CACHE_TTL_MS, now });
}

let sharedInstance: PortalCache | null = null;

/** 共享单例（main 装配路径；跨路由切换存活） */
export function sharedObserveCache(): PortalCache {
  if (!sharedInstance) sharedInstance = createObserveCache(() => Date.now());
  return sharedInstance;
}

/** 测试隔离钩子：换新实例（避免跨用例缓存串扰） */
export function resetSharedObserveCache(): void {
  sharedInstance = null;
}
