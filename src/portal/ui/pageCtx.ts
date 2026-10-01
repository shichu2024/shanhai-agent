// 第七阶段批次二（7-2/4）：页面控制器装配契约——依赖全注入（node 环境直测，7-1 boot 同款纪律）。

import type { TimerHost } from './poll.js';

export interface PageCtx {
  doc: Document;
  /** 内容区根元素（#view）——控制器 innerHTML 重渲染 + 事件委托 */
  view: HTMLElement;
  fetchImpl: typeof fetch;
  timerHost: TimerHost;
  confirmBox: (text: string) => boolean;
  now(): number;
}

export interface PageHandle {
  destroy(): void;
}

/**
 * dataset 键取值（kebab-case 安全）：真实 DOM 将 data-task-status 驼化为 dataset.taskStatus，
 * 测试桩用原样 kebab 键——两态兼容。
 */
export function ds(dataset: Record<string, string>, kebab: string): string {
  const camel = kebab.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return dataset[kebab] ?? dataset[camel] ?? '';
}
