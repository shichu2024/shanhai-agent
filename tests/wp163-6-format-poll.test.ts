import { describe, expect, it } from 'vitest';
import { formatTimestamp, relativeTime } from '../src/portal/ui/format.js';
import { createPoller, type TimerHost } from '../src/portal/ui/poll.js';

// 每日优化第十六批（TASK-163）：ui 小项分支覆盖加固。
//  - format.ts:11：formatTimestamp 收到不可解析时间串 → 原样返回（不猜测、不抛）；
//  - format.ts:17：relativeTime 收到无效时间 → '—'；
//  - poll.ts:27：run 触发时已 stop 或不可见 → 直接返回（不调 fn、不再排程）；
//  - poll.ts:38：start 幂等——重复 start 不重复排程。

describe('wp163 formatTimestamp：无效时间串原样返回（format.ts:10-12）', () => {
  it('不可解析字符串 → 原样返回', () => {
    expect(formatTimestamp('不是时间戳')).toBe('不是时间戳');
  });
});

describe('wp163 relativeTime：无效时间 → 占位符（format.ts:16-18）', () => {
  it('NaN 时间 → —', () => {
    expect(relativeTime('definitely-not-a-time', Date.now()).startsWith('—')).toBe(true);
  });
});

function recordingHost(): { host: TimerHost; scheduled: Array<{ fn: () => void; ms: number }>; cleared: unknown[] } {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const host: TimerHost = {
    set: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clear: (h) => { cleared.push(h); },
  };
  return { host, scheduled, cleared };
}

describe('wp163 poller.run：stop/不可见后定时器仍触发 → 直接返回（poll.ts:26-27）', () => {
  it('start 后 stop，再手动触发已排程的回调 → fn 不执行、无新排程', () => {
    const { host, scheduled } = recordingHost();
    let calls = 0;
    const poller = createPoller({ intervalMs: 100, fn: () => { calls++; }, timerHost: host });
    poller.start();
    expect(scheduled.length).toBe(1);
    poller.stop();
    scheduled[0]!.fn(); // 定器回调在 stop 之后到达（真实定时器竞态形态）
    expect(calls).toBe(0); // running=false → run 直接返回
    expect(scheduled.length).toBe(1); // 不再重排
  });

  it('onVisibility(false) 后手动触发已排程回调 → fn 不执行', () => {
    const { host, scheduled } = recordingHost();
    let calls = 0;
    const poller = createPoller({ intervalMs: 100, fn: () => { calls++; }, timerHost: host });
    poller.start();
    poller.onVisibility(false); // 清掉当前句柄
    poller.onVisibility(true); // 恢复：立即 run 一次（可见臂）→ 再排程
    const before = scheduled.length;
    poller.onVisibility(false);
    scheduled[before - 1]!.fn(); // 最新一次排程在不可见后触发
    expect(calls).toBe(1); // 不可见后触发不执行 fn（唯一一次来自恢复可见的立即拉取）
  });
});

describe('wp163 poller.start：幂等——重复 start 不重复排程（poll.ts:37-41）', () => {
  it('连续两次 start → 仅一次排程', () => {
    const { host, scheduled } = recordingHost();
    const poller = createPoller({ intervalMs: 100, fn: () => {}, timerHost: host });
    poller.start();
    poller.start(); // 已运行 → 直接返回
    expect(scheduled.length).toBe(1);
  });
});
