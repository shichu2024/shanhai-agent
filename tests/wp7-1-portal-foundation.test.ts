import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  parseHash,
  legacyRedirect,
  type PortalUiRoute,
} from '../src/portal/ui/routes.js';
import {
  PRIMARY_NAV,
  OBSERVE_TABS,
  activeNavKey,
  activeObserveTabKey,
  beastHeaderOf,
} from '../src/portal/ui/nav.js';
import {
  TOKEN_KEY,
  loadToken,
  saveToken,
  clearToken,
  consumeTokenFragment,
} from '../src/portal/ui/token.js';
import {
  outcomeFor,
  nextConnection,
  evaluateConnection,
  initialConnection,
  CONNECTION_LABELS,
  type ConnectionState,
} from '../src/portal/ui/connection.js';
import { createPoller, type TimerHost } from '../src/portal/ui/poll.js';
import { createCache } from '../src/portal/ui/cache.js';
import {
  formatTimestamp,
  relativeTime,
  shortId,
  formatThousands,
} from '../src/portal/ui/format.js';
import {
  esc,
  statusBadgeHtml,
  riskBadgeHtml,
  emptyStateHtml,
  errorStateHtml,
  skeletonHtml,
  cardHtml,
  pageHeaderHtml,
  toastHtml,
} from '../src/portal/ui/components.js';
import { renderContent } from '../src/portal/ui/pages.js';

// 第七阶段批次一（7-1/4）：门户工程化地基交互逻辑（设计 V0.3 §3/§4/§10）——
// 路由表（含旧路由兼容表）、Token 消费（TASK-96 契约镜像）、断连判定（§11-3）、
// 轻量缓存（FR-G-4 TTL≤3s + 去重）、轮询可见性暂停（FR-G-4）、统一组件（§10.4）。
// TDD 红阶段先行：本文件先于实现落库。

const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

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

// ---------- 路由表（§3.1，hash 路由唯一权威定义的 TS 面） ----------

describe('7-1 routes.parseHash（新路由表 + 查询串）', () => {
  it('缺省与一级导航路由', () => {
    expect(parseHash('').route).toEqual({ view: 'tasks' });
    expect(parseHash('#/').route).toEqual({ view: 'tasks' });
    expect(parseHash('#/tasks').route).toEqual({ view: 'tasks' });
    expect(parseHash('#/approvals').route).toEqual({ view: 'approvals' });
    expect(parseHash('#/observe').route).toEqual({ view: 'observe' });
    expect(parseHash('#/agents').route).toEqual({ view: 'agents' });
  });

  it('详情路由与 id 解码', () => {
    expect(parseHash('#/tasks/t-123').route).toEqual({ view: 'task-detail', id: 't-123' });
    expect(parseHash('#/approvals/req-9').route).toEqual({ view: 'approval-detail', id: 'req-9' });
    expect(parseHash('#/observe/evolution/c-1').route).toEqual({ view: 'observe-evolution-detail', id: 'c-1' });
    expect(parseHash('#/agents/smoke-a').route).toEqual({ view: 'agent-detail', id: 'smoke-a' });
    expect(parseHash('#/tasks/a%2Fb').route).toEqual({ view: 'task-detail', id: 'a/b' });
  });

  it('观测二级路由', () => {
    expect(parseHash('#/observe/capabilities').route).toEqual({ view: 'observe-capabilities' });
    expect(parseHash('#/observe/evolution').route).toEqual({ view: 'observe-evolution' });
    expect(parseHash('#/observe/evidence').route).toEqual({ view: 'observe-evidence' });
  });

  it('hash 内查询串解析（FR-T-2 URL 同步 / FR-AG-5 预选 / FR-O-4 ref 直查）', () => {
    expect(parseHash('#/tasks?status=running&agent=ag&range=7d').query).toEqual({ status: 'running', agent: 'ag', range: '7d' });
    expect(parseHash('#/observe/capabilities?agent=ag1').query).toEqual({ agent: 'ag1' });
    expect(parseHash('#/observe/evidence?ref=task%3At-1').query).toEqual({ ref: 'task:t-1' });
    expect(parseHash('#/tasks').query).toEqual({});
  });

  it('未知 hash → not-found（app.js:78 既有行为）', () => {
    const r: PortalUiRoute = parseHash('#/nope/deep').route;
    expect(r).toEqual({ view: 'not-found', hash: '#/nope/deep' });
  });

  it('路由表零占位神兽', () => {
    expect(PLACEHOLDER_BEASTS.test(String(parseHash('#/tasks').route.view))).toBe(false);
  });
});

describe('7-1 routes.legacyRedirect（旧路由一次性改写，§3.1 兼容表）', () => {
  it('旧观测族路由 → 新观测路由（含 :id 与查询串保留）', () => {
    expect(legacyRedirect('#/capabilities')).toBe('#/observe/capabilities');
    expect(legacyRedirect('#/capabilities?agent=x')).toBe('#/observe/capabilities?agent=x');
    expect(legacyRedirect('#/evolution')).toBe('#/observe/evolution');
    expect(legacyRedirect('#/evolution/c-9')).toBe('#/observe/evolution/c-9');
    expect(legacyRedirect('#/evidence')).toBe('#/observe/evidence');
  });

  it('非旧路由返回 null（原形态保留项与未知项均不改写）', () => {
    expect(legacyRedirect('#/tasks')).toBeNull();
    expect(legacyRedirect('#/tasks/t-1')).toBeNull();
    expect(legacyRedirect('')).toBeNull();
    expect(legacyRedirect('#/nope')).toBeNull();
  });
});

// ---------- 导航与神兽行（§3.1 / §4 FR-G-6 / §15） ----------

describe('7-1 nav（三一级导航 + 观测二级聚合 + 神兽行）', () => {
  it('一级导航恰三项：应龙·任务 / 玄武·审批 / 观测', () => {
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual(['应龙·任务', '玄武·审批', '观测']);
    expect(PRIMARY_NAV.map((n) => n.hash)).toEqual(['#/tasks', '#/approvals', '#/observe']);
  });

  it('观测二级页签：总控 / 白泽·能力 / 女娲·演进 / 夔牛·证据', () => {
    expect(OBSERVE_TABS.map((t) => t.label)).toEqual(['总控', '白泽·能力', '女娲·演进', '夔牛·证据']);
    expect(OBSERVE_TABS.map((t) => t.hash)).toEqual(['#/observe', '#/observe/capabilities', '#/observe/evolution', '#/observe/evidence']);
  });

  it('当前导航高亮派生：详情页归属其一级导航；Agent/未知名不高亮（7-1 无 Agent 导航项）', () => {
    expect(activeNavKey('tasks')).toBe('tasks');
    expect(activeNavKey('task-detail')).toBe('tasks');
    expect(activeNavKey('approvals')).toBe('approvals');
    expect(activeNavKey('approval-detail')).toBe('approvals');
    expect(activeNavKey('observe')).toBe('observe');
    expect(activeNavKey('observe-capabilities')).toBe('observe');
    expect(activeNavKey('agents')).toBeNull();
    expect(activeNavKey('agent-detail')).toBeNull();
    expect(activeNavKey('not-found')).toBeNull();
  });

  it('观测页签高亮派生（总控页无页签高亮标记为 overview）', () => {
    expect(activeObserveTabKey('observe')).toBe('overview');
    expect(activeObserveTabKey('observe-capabilities')).toBe('capabilities');
    expect(activeObserveTabKey('observe-evolution')).toBe('evolution');
    expect(activeObserveTabKey('observe-evidence')).toBe('evidence');
    expect(activeObserveTabKey('tasks')).toBeNull();
  });

  it('神兽行映射：五域有神兽；观测总控与 Agent 页无神兽行（工程视图）', () => {
    expect(beastHeaderOf('tasks')?.beast).toBe('应龙');
    expect(beastHeaderOf('approvals')?.beast).toBe('玄武');
    expect(beastHeaderOf('observe-capabilities')?.beast).toBe('白泽');
    expect(beastHeaderOf('observe-evolution')?.beast).toBe('女娲');
    expect(beastHeaderOf('observe-evidence')?.beast).toBe('夔牛');
    expect(beastHeaderOf('observe')).toBeNull();
    expect(beastHeaderOf('agents')).toBeNull();
    expect(beastHeaderOf('agent-detail')).toBeNull();
    for (const view of ['tasks', 'approvals', 'observe-capabilities', 'observe-evolution', 'observe-evidence'] as const) {
      const h = beastHeaderOf(view)!;
      expect(h.tagline.length).toBeGreaterThan(0);
      expect(h.engineer.length).toBeGreaterThan(0);
      expect(PLACEHOLDER_BEASTS.test(`${h.beast}${h.engineer}${h.tagline}`)).toBe(false);
    }
  });

  it('导航与页签字面零占位神兽（§12-8 硬 DoD）', () => {
    const all = [...PRIMARY_NAV, ...OBSERVE_TABS].map((n) => n.label).join('/');
    expect(PLACEHOLDER_BEASTS.test(all)).toBe(false);
  });
});

// ---------- Token（FR-G-1：sessionStorage + fragment 一次性消费，TASK-96 契约镜像） ----------

describe('7-1 token（sessionStorage 会话级存取）', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', fakeStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('loadToken 缺省空串；save/clear 往返；键名与现实现一致', () => {
    expect(loadToken()).toBe('');
    saveToken('tok-1');
    expect(loadToken()).toBe('tok-1');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('tok-1');
    clearToken();
    expect(loadToken()).toBe('');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(TOKEN_KEY).toBe('shanhai-portal-token');
  });

  it('fragment 消费：#token=<v> → 存储并抹除地址栏；非 token hash 不动作', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('location', { hash: '#token=abc-def', pathname: '/', search: '' });
    vi.stubGlobal('history', { replaceState });
    expect(consumeTokenFragment()).toBe('abc-def');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('abc-def');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');

    const replace2 = vi.fn();
    vi.stubGlobal('location', { hash: '#/tasks', pathname: '/', search: '' });
    vi.stubGlobal('history', { replaceState: replace2 });
    expect(consumeTokenFragment()).toBeNull();
    expect(replace2).not.toHaveBeenCalled();

    vi.stubGlobal('location', { hash: '#token=', pathname: '/', search: '' });
    expect(consumeTokenFragment()).toBeNull();
  });
});

// ---------- 断连判定（§11-3 / FR-G-3：三态，401/403 不计入） ----------

describe('7-1 connection（三态判定，§11-3 口径）', () => {
  it('outcomeFor：网络错误与 5xx 计失败；401/403 不计入；其余响应视为连通', () => {
    expect(outcomeFor('network-error')).toBe('fail');
    expect(outcomeFor(500)).toBe('fail');
    expect(outcomeFor(503)).toBe('fail');
    expect(outcomeFor(401)).toBe('ignored');
    expect(outcomeFor(403)).toBe('ignored');
    expect(outcomeFor(200)).toBe('ok');
    expect(outcomeFor(404)).toBe('ok');
    expect(outcomeFor(409)).toBe('ok');
  });

  it('连续 2 次失败 → 重连中；成功 → 恢复已连接', () => {
    let s = initialConnection();
    expect(s.phase).toBe('connected');
    s = nextConnection(s, 'fail', 1000);
    expect(s.phase).toBe('connected'); // 第 1 次失败仍在已连接态
    expect(s.failStreak).toBe(1);
    s = nextConnection(s, 'fail', 2000);
    expect(s.phase).toBe('reconnecting');
    expect(CONNECTION_LABELS[s.phase]).toBe('重连中');
    s = nextConnection(s, 'ok', 3000);
    expect(s.phase).toBe('connected');
    expect(s.failStreak).toBe(0);
  });

  it('重连中持续 30s 未恢复 → 已断开；ignored 不改变状态', () => {
    let s = initialConnection();
    s = nextConnection(s, 'fail', 1000);
    s = nextConnection(s, 'fail', 2000);
    expect(evaluateConnection(s, 21000).phase).toBe('reconnecting');
    const red = evaluateConnection(s, 32000);
    expect(red.phase).toBe('disconnected');
    expect(CONNECTION_LABELS[red.phase]).toBe('已断开');
    const ignored: ConnectionState = nextConnection(red, 'ignored', 33000);
    expect(ignored.phase).toBe('disconnected');
    // 断开后服务恢复 → 回到已连接并清计数
    expect(nextConnection(red, 'ok', 34000).phase).toBe('connected');
  });

  it('成功结果穿插会重置失败连击（1 次失败 + 1 次成功 + 1 次失败 ≠ 断连）', () => {
    let s = initialConnection();
    s = nextConnection(s, 'fail', 1000);
    s = nextConnection(s, 'ok', 2000);
    s = nextConnection(s, 'fail', 3000);
    expect(s.phase).toBe('connected');
  });
});

// ---------- 轮询与可见性暂停（FR-G-4） ----------

interface FakeTimer { fn: () => void; ms: number; id: number }

function fakeTimerHost(): { host: TimerHost; timers: FakeTimer[] } {
  const timers: FakeTimer[] = [];
  const nextId = { v: 1 };
  const host: TimerHost = {
    set: (fn: () => void, ms: number) => {
      const t: FakeTimer = { fn: () => {}, ms, id: nextId.v++ };
      t.fn = () => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1); // 触发即出队（真实定时器语义）
        fn();
      };
      timers.push(t);
      return t.id;
    },
    clear: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return { host, timers };
}

describe('7-1 poller（周期执行 + 可见性暂停/恢复立即拉取）', () => {
  it('start 后按周期执行；fn 抛错不终止轮询', async () => {
    const ctx = fakeTimerHost();
    const calls: number[] = [];
    let n = 0;
    const poller = createPoller({
      intervalMs: 5000,
      fn: () => { n += 1; calls.push(n); if (n === 1) throw new Error('boom'); return Promise.resolve(); },
      timerHost: ctx.host,
    });
    poller.start();
    expect(ctx.timers.length).toBe(1);
    ctx.timers[0].fn(); // 第 1 次执行（抛错）
    await Promise.resolve();
    expect(calls).toEqual([1]);
    expect(ctx.timers.length).toBe(1); // 抛错后仍重新排队
    ctx.timers[0].fn();
    await Promise.resolve();
    expect(calls).toEqual([1, 2]);
    poller.stop();
    expect(ctx.timers.length).toBe(0);
  });

  it('onVisibility(false) 暂停（清定时器不再执行）；onVisibility(true) 立即执行一次并重启周期', async () => {
    const ctx = fakeTimerHost();
    const calls: number[] = [];
    const poller = createPoller({
      intervalMs: 5000,
      fn: () => { calls.push(calls.length + 1); return Promise.resolve(); },
      timerHost: ctx.host,
    });
    poller.start();
    ctx.timers[0].fn();
    await Promise.resolve();
    expect(calls.length).toBe(1);
    poller.onVisibility(false);
    expect(ctx.timers.length).toBe(0);
    poller.onVisibility(false); // 幂等
    expect(ctx.timers.length).toBe(0);
    poller.onVisibility(true);
    expect(calls.length).toBe(2); // 恢复立即拉一次
    await Promise.resolve(); // fn 完成后重启周期（异步续段）
    expect(ctx.timers.length).toBe(1); // 并重启周期
    poller.stop();
  });

  it('未 start 时 onVisibility 不触发执行', () => {
    const ctx = fakeTimerHost();
    const calls: number[] = [];
    const poller = createPoller({ intervalMs: 5000, fn: () => { calls.push(1); return Promise.resolve(); }, timerHost: ctx.host });
    poller.onVisibility(true);
    expect(calls.length).toBe(0);
  });
});

// ---------- 轻量缓存（FR-G-4：TTL ≤3s + 同页去重） ----------

describe('7-1 cache（TTL 过期 + 在途请求去重）', () => {
  it('TTL 内命中缓存不重复拉取；过期后重新拉取', async () => {
    let now = 0;
    let fetches = 0;
    const cache = createCache<number>({ ttlMs: 3000, now: () => now });
    const get = () => cache.get('k', async () => { fetches += 1; return 42; });
    expect(await get()).toBe(42);
    now = 2000;
    expect(await get()).toBe(42);
    expect(fetches).toBe(1);
    now = 3500; // 超过 3s
    expect(await get()).toBe(42);
    expect(fetches).toBe(2);
  });

  it('并发同键请求共享同一在途 Promise（去重）', async () => {
    let now = 0;
    let fetches = 0;
    const cache = createCache<number>({ ttlMs: 3000, now: () => now });
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => { release = r; });
    const p1 = cache.get('k', () => gate.then((v) => { fetches += 1; return v; }));
    const p2 = cache.get('k', () => gate.then((v) => { fetches += 1; return v; }));
    release(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
    expect(fetches).toBe(1);
  });

  it('不同键互不影响；invalidate 后强制重取', async () => {
    let now = 0;
    const fetches: string[] = [];
    const cache = createCache<number>({ ttlMs: 3000, now: () => now });
    expect(await cache.get('a', async () => { fetches.push('a'); return 1; })).toBe(1);
    expect(await cache.get('b', async () => { fetches.push('b'); return 2; })).toBe(2);
    expect(await cache.get('a', async () => { fetches.push('a'); return 1; })).toBe(1);
    expect(fetches).toEqual(['a', 'b']);
    cache.invalidate('a');
    expect(await cache.get('a', async () => { fetches.push('a'); return 1; })).toBe(1);
    expect(fetches).toEqual(['a', 'b', 'a']);
    cache.clear();
    expect(await cache.get('b', async () => { fetches.push('b'); return 2; })).toBe(2);
  });

  it('失败请求不落缓存（下轮重取）；invalidate 不撤销在途请求', async () => {
    let now = 0;
    let fails = 0;
    const cache = createCache<number>({ ttlMs: 3000, now: () => now });
    await expect(cache.get('k', async () => { fails += 1; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fails).toBe(1);
    expect(await cache.get('k', async () => { fails += 1; return 9; })).toBe(9); // 失败后重取成功
    expect(fails).toBe(2);
    expect(cache.size()).toBe(1);
    // 在途请求 invalidate：条目保留，随后 get 复用在途 Promise
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => { release = r; });
    const p = cache.get('g', () => gate);
    cache.invalidate('g');
    const p2 = cache.get('g', () => gate);
    release(5);
    expect(await p).toBe(5);
    expect(await p2).toBe(5);
  });
});

// ---------- 格式化（FR-G-5：YYYY-MM-DD HH:mm:ss + 相对时间） ----------

describe('7-1 format（全局唯一时间格式化函数）', () => {
  it('本地时区 YYYY-MM-DD HH:mm:ss；空值显示 —', () => {
    const d = new Date(2026, 9, 1, 12, 34, 56);
    expect(formatTimestamp(d.toISOString())).toBe('2026-10-01 12:34:56');
    expect(formatTimestamp('')).toBe('—');
    expect(formatTimestamp(null as unknown as string)).toBe('—');
  });

  it('相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前', () => {
    const now = new Date(2026, 9, 1, 12, 0, 0).getTime();
    expect(relativeTime(new Date(now - 5_000).toISOString(), now)).toBe('刚刚');
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe('30 秒前');
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 分钟前');
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 小时前');
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2 天前');
    expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe('刚刚');
  });

  it('shortId 前 8 位；千分位', () => {
    expect(shortId('abcdefghijklmnop')).toBe('abcdefgh');
    expect(shortId('abc')).toBe('abc');
    expect(shortId('')).toBe('');
    expect(formatThousands(1234567)).toBe('1,234,567');
    expect(formatThousands(0)).toBe('0');
  });
});

// ---------- 统一组件（§10.4：徽章/空态/错误态/骨架屏/卡片/弹层/页头） ----------

describe('7-1 components（§10.4 组件规范字符串面）', () => {
  it('esc 转义 HTML 危险字符', () => {
    expect(esc('<img src=x>&"\'')).toBe('&lt;img src=x&gt;&amp;&quot;&#39;');
    expect(esc(null as unknown as string)).toBe('');
  });

  it('任务状态徽章：七状态中文文案 + 圆点（不单独依赖颜色）', () => {
    const pairs: Array<[string, string]> = [
      ['created', '已创建'], ['queued', '排队中'], ['running', '运行中'], ['paused', '已暂停'],
      ['succeeded', '已完成'], ['failed', '失败'], ['cancelled', '已取消'],
    ];
    for (const [status, label] of pairs) {
      const html = statusBadgeHtml(status);
      expect(html).toContain(label);
      expect(html).toContain('badge__dot');
    }
    expect(statusBadgeHtml('weird')).toContain('weird'); // 未知回退原文
  });

  it('风险徽章 L0..L4；L3/L4 高危加危险类名', () => {
    for (const lv of ['L0', 'L1', 'L2', 'L3', 'L4']) expect(riskBadgeHtml(lv)).toContain(lv);
    expect(riskBadgeHtml('L3')).toContain('badge--danger');
    expect(riskBadgeHtml('L4')).toContain('badge--danger');
    expect(riskBadgeHtml('L0')).not.toContain('badge--danger');
  });

  it('空态组件：说明 + 可选主操作', () => {
    const html = emptyStateHtml({ title: '当前筛选无任务', actionLabel: '清除筛选' });
    expect(html).toContain('当前筛选无任务');
    expect(html).toContain('清除筛选');
    expect(emptyStateHtml({ title: '暂无 Agent 数据' })).not.toContain('button');
  });

  it('错误态组件：错误码 + 消息 + 重试', () => {
    const html = errorStateHtml({ code: 'not_found', message: '对象不存在', retryLabel: '重试' });
    expect(html).toContain('not_found');
    expect(html).toContain('对象不存在');
    expect(html).toContain('重试');
  });

  it('骨架屏行数；卡片标题与内容；Toast 三型', () => {
    expect(skeletonHtml(3)).toMatch(/skeleton/g);
    const card = cardHtml({ title: '任务统计', body: '<p>x</p>' });
    expect(card).toContain('任务统计');
    expect(card).toContain('<p>x</p>');
    expect(toastHtml('saved', 'success')).toContain('toast--success');
    expect(toastHtml('boom', 'error')).toContain('toast--error');
    expect(toastHtml('hi', 'info')).toContain('toast--info');
  });

  it('页头组件：神兽行（图标 + 神兽名·工程名 + 定位语）+ 页面标题；无神兽域只出标题', () => {
    const h = pageHeaderHtml({ view: 'tasks', title: '任务列表' });
    expect(h).toContain('应龙');
    expect(h).toContain('任务列表');
    const plain = pageHeaderHtml({ view: 'observe', title: '观测·总控' });
    expect(plain).not.toContain('beast-row');
    expect(plain).toContain('观测·总控');
  });

  it('按钮/表格/模态确认框/加载态（§10.4 四态按钮与表格规范）', async () => {
    const { buttonHtml, tableHtml, confirmModalHtml, loadingStateHtml } = await import('../src/portal/ui/components.js');
    expect(buttonHtml('保存', 'primary')).toContain('btn--primary');
    expect(buttonHtml('删除', 'danger', 'data-x="1"')).toContain('data-x="1"');
    const table = tableHtml({ columns: ['任务', '状态'], rowsHtml: '<tr><td>a</td></tr>', caption: '任务列表' });
    expect(table).toContain('<th scope="col">任务</th>');
    expect(table).toContain('<caption>任务列表</caption>');
    expect(table).toContain('<tr><td>a</td></tr>');
    const modal = confirmModalHtml({ title: '强制中止确认', bodyHtml: '<p>影响说明</p>', confirmLabel: '强制中止' });
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('强制中止');
    expect(modal).toContain('取消');
    expect(loadingStateHtml()).toContain('加载中');
  });
});

// ---------- 骨架页（7-1 占位内容：神兽页头 + 建设中卡片 + 观测页签） ----------

describe('7-1 pages.renderContent（骨架页）', () => {
  it('任务/审批/观测各页渲染页头与建设中占位（批次 7-2/7-3 交付内容）', () => {
    for (const hash of ['#/tasks', '#/approvals', '#/observe', '#/observe/capabilities', '#/observe/evolution', '#/observe/evidence']) {
      const html = renderContent(parseHash(hash).route, {});
      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain('建设中');
      expect(PLACEHOLDER_BEASTS.test(html)).toBe(false);
    }
  });

  it('详情路由（7-2/7-3/7-4 交付）同样有骨架占位而非死链', () => {
    for (const hash of ['#/tasks/t-1', '#/approvals/r-1', '#/observe/evolution/c-1', '#/agents', '#/agents/ag-1']) {
      const html = renderContent(parseHash(hash).route, {});
      expect(html).toContain('建设中');
    }
  });

  it('观测族页面带二级页签且当前页签高亮', () => {
    const cap = renderContent(parseHash('#/observe/capabilities').route, {});
    expect(cap).toContain('白泽·能力');
    expect(cap).toContain('女娲·演进'); // 页签组完整
    expect(cap).toMatch(/tab[^\s"]*active|active[^\s"]*tab|aria-current="page"/);
    const overview = renderContent(parseHash('#/observe').route, {});
    expect(overview).toContain('总控');
  });

  it('not-found：未知 hash + 返回首页出口', () => {
    const html = renderContent({ view: 'not-found', hash: '#/nope' }, {});
    expect(html).toContain('#/nope');
    expect(html).toContain('#/tasks');
  });
});
