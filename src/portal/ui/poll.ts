// 第七阶段批次一（7-1/4）：轮询机制（FR-G-4，纯逻辑可测——定时器宿主注入）。
// 页面不可见（visibilitychange）时暂停；恢复可见时立即拉一次并重启计时器；
// fn 抛错/拒绝不终止轮询（下轮照常）。

export interface TimerHost {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface Poller {
  start(): void;
  stop(): void;
  onVisibility(visible: boolean): void;
}

export function createPoller(opts: { intervalMs: number; fn: () => unknown; timerHost: TimerHost }): Poller {
  let handle: unknown = null;
  let running = false;
  let visible = true;

  function schedule(): void {
    handle = opts.timerHost.set(run, opts.intervalMs);
  }

  async function run(): Promise<void> {
    handle = null;
    if (!running || !visible) return;
    try {
      await opts.fn();
    } catch {
      /* 轮询 fn 异常不终止轮询（下一周期照常） */
    }
    if (running && visible) schedule();
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      if (visible) schedule();
    },
    stop(): void {
      running = false;
      if (handle !== null) {
        opts.timerHost.clear(handle);
        handle = null;
      }
    },
    onVisibility(visibleNext: boolean): void {
      visible = visibleNext;
      if (!running) return;
      if (!visibleNext) {
        if (handle !== null) {
          opts.timerHost.clear(handle);
          handle = null;
        }
        return;
      }
      void run(); // 恢复可见：立即拉一次并重启周期
    },
  };
}
