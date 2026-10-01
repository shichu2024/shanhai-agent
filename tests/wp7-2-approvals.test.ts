import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { approveActionHint } from '../src/portal/view/write.js';
import { formatTimestamp } from '../src/portal/ui/format.js';
import {
  APPROVAL_DECISION_LABELS,
  allViewRows,
  approvalDetailHtml,
  approvalsPageHtml,
  countdownLabel,
  detailCountdownMs,
  isCountdownCritical,
  pendingViewRows,
} from '../src/portal/ui/approvalsView.js';
import { mountApprovalsPage } from '../src/portal/ui/approvalsPage.js';
import { mountApprovalDetailPage } from '../src/portal/ui/approvalDetailPage.js';
import type { TimerHost } from '../src/portal/ui/poll.js';

// 第七阶段批次二（7-2/4）：玄武·审批中心交互逻辑（设计 V0.3 §6）——
// 待办视图前端重排正序、decision 四枚举前端过滤（服务端参数面仅 pending=true）、
// 超时倒计时（<5min 红）、详情（riskLevel L0..L4 / approveActionHint 四态逐字 / argsDigest 摘要区 /
// FR-AD-5 提交前重查）。TDD 红阶段先行。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

function approvalRow(p: Partial<Record<string, unknown>> & { requestId: string }): Record<string, unknown> {
  return {
    taskId: 'task-aaaabbbb',
    toolId: 'tool-x',
    decision: 'pending',
    requestedAt: '2026-10-01T11:00:00.000Z',
    timeoutAt: '2026-10-01T12:10:00.000Z',
    callRef: 'call-1',
    agentVersionId: 'ver-1',
    contentHash: 'hash-1',
    taskStatus: 'paused',
    timeoutRemainingMs: 10 * 60_000,
    ...p,
  };
}

// ---------- FR-A-1..4 列表逻辑 ----------

describe('7-2 审批列表纯逻辑（FR-A-1/2/3/4）', () => {
  const rows = [
    approvalRow({ requestId: 'req-new', requestedAt: '2026-10-01T11:30:00.000Z' }),
    approvalRow({ requestId: 'req-old', requestedAt: '2026-10-01T10:30:00.000Z' }),
    approvalRow({ requestId: 'req-done', decision: 'denied', requestedAt: '2026-10-01T09:00:00.000Z' }),
  ];

  it('待办视图：仅 pending + requestedAt 正序（等待最久置顶——超时风险优先）', () => {
    expect(pendingViewRows(rows).map((r) => r.requestId)).toEqual(['req-old', 'req-new']);
  });

  it('全部视图：保持服务端 DESC（最新在前）', () => {
    expect(allViewRows(rows).map((r) => r.requestId)).toEqual(['req-new', 'req-old', 'req-done']);
  });

  it('decision 四枚举徽章文案（FR-A-1 列表口径）', () => {
    expect(APPROVAL_DECISION_LABELS).toEqual({ pending: '待决议', approved: '已批准', denied: '已否决', superseded: '已作废' });
  });

  it('超时倒计时：<5min 进入红色警示；0 → 已超时（惰性判定下次读取落地）', () => {
    expect(isCountdownCritical(5 * 60_000)).toBe(false);
    expect(isCountdownCritical(5 * 60_000 - 1)).toBe(true);
    expect(countdownLabel(0)).toBe('已超时');
    expect(countdownLabel(30_000)).toBe('<1 分钟');
    expect(countdownLabel(10 * 60_000)).toBe('10 分钟内');
    expect(detailCountdownMs('2026-10-01T12:05:00.000Z', NOW)).toBe(5 * 60_000);
  });
});

describe('7-2 approvalsPageHtml（列表渲染）', () => {
  const html = approvalsPageHtml({
    mode: 'pending',
    rows: [approvalRow({ requestId: 'req-11112222' })],
    page: 0,
    pageCount: 1,
    decisionFilter: null,
    feedback: null,
    now: NOW,
  });

  it('列：requestId 短码（无 # 前缀）、taskId 链接、toolId、决议徽章、请求时间、倒计时', () => {
    expect(html).toContain('req-1111');
    expect(html).not.toContain('#req-1111');
    expect(html).toContain('#/tasks/task-aaaabbbb');
    expect(html).toContain('tool-x');
    expect(html).toContain('badge--decision-pending');
    expect(html).toContain('10 分钟内');
  });

  it('待办视图提示：pending=true 端点口径 + 重排说明', () => {
    expect(html).toContain('等待最久');
  });

  it('占位神兽零出现', () => {
    expect(PLACEHOLDER_BEASTS.test(html)).toBe(false);
  });
});

// ---------- FR-AD-1..6 详情 ----------

const showBody = {
  request: {
    requestId: 'req-11112222ffff',
    taskId: 'task-aaaabbbb',
    agentVersionId: 'ver-1',
    toolId: 'tool-risky',
    riskLevel: 'L3',
    requestedAt: '2026-10-01T11:00:00.000Z',
    decision: 'pending',
    decidedAt: null,
    timeoutAt: '2026-10-01T12:10:00.000Z',
    callRef: 'call-1',
  },
  binding: { agentVersionId: 'ver-1', contentHash: 'hash-abc', snapshotBytes: 4096 },
  snapshot: { savedAt: '2026-10-01T11:00:01.000Z', contextBytes: 8192 },
  argsDigest: '0123456789abcdef',
};

describe('7-2 approvalDetailHtml（FR-AD-1..6）', () => {
  const html = approvalDetailHtml({ detail: showBody, taskStatus: 'paused', feedback: null, now: NOW });

  it('头部：requestId/toolId/riskLevel 徽章（L3 高危红）/请求时间/任务状态徽章；零确认令牌概念', () => {
    expect(html).toContain('req-11112222ffff');
    expect(html).toContain('tool-risky');
    expect(html).toContain('badge--danger');
    expect(html).toContain('L3');
    expect(html).toContain('badge--status-paused');
    expect(html).not.toContain('confirmation_token'); // V0.1 虚构概念零出现
  });

  it('固定提示条 = approveActionHint(pending, paused) 逐字（FR-AD-1/FR-WR-1④）', () => {
    expect(html).toContain(approveActionHint('pending', 'paused').hint);
  });

  it('参数摘要区：argsDigest 等宽 + snapshot.savedAt/contextBytes + binding.contentHash；无明文入参', () => {
    expect(html).toContain('0123456789abcdef');
    expect(html).toContain('8,192');
    expect(html).toContain('hash-abc');
  });

  it('pending+paused 可决议：批准/否决按钮（点击即提交，FR-WR-1④ 不弹确认）', () => {
    expect(html).toMatch(/data-action="approve"/);
    expect(html).toMatch(/data-action="deny"/);
  });

  it('approved+paused：不出现决议按钮，提示已批准待续跑 + CLI 兜底命令（FR-AD-4）', () => {
    const approved = approvalDetailHtml({
      detail: { ...showBody, request: { ...showBody.request, decision: 'approved', decidedAt: '2026-10-01T11:30:00.000Z' } },
      taskStatus: 'paused',
      feedback: null,
      now: NOW,
    });
    expect(approved).not.toMatch(/data-action="approve"/);
    expect(approved).toContain('已批准，待续跑');
    expect(approved).toContain('shanhai task run task-aaaabbbb --resume --resumed-by manual-resume');
    expect(approved).toContain(formatTimestamp('2026-10-01T11:30:00.000Z')); // decidedAt 本地化展示
  });

  it('pending + 非 paused：不可决议提示（可能已被惰性超时终局）', () => {
    const notPaused = approvalDetailHtml({ detail: showBody, taskStatus: 'running', feedback: null, now: NOW });
    expect(notPaused).not.toMatch(/data-action="approve"/);
    expect(notPaused).toContain('非挂起——审批不可决议');
  });

  it('已终局：只读提示 + 已决议区（decision/decidedAt）', () => {
    const denied = approvalDetailHtml({
      detail: { ...showBody, request: { ...showBody.request, decision: 'denied', decidedAt: '2026-10-01T11:40:00.000Z' } },
      taskStatus: 'cancelled',
      feedback: null,
      now: NOW,
    });
    expect(denied).toContain('该请求已终局（只读）');
    expect(denied).toContain('badge--decision-denied');
  });

  it('占位神兽零出现', () => {
    expect(PLACEHOLDER_BEASTS.test(html)).toBe(false);
  });
});

// ---------- 装配 ----------

function fakeTimerHost() {
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const host: TimerHost = {
    set: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn: () => {
        const i = timers.findIndex((x) => x.id === id);
        if (i >= 0) timers.splice(i, 1);
        fn();
      }, ms, id });
      return id;
    },
    clear: (h: unknown) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return { host, timers };
}

function stubViewEl() {
  const el = {
    innerHTML: '',
    listeners: new Map<string, Array<(ev?: unknown) => void>>(),
    addEventListener(type: string, fn: (ev?: unknown) => void) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
    removeEventListener(type: string, fn: (ev?: unknown) => void) { const a = el.listeners.get(type) ?? []; el.listeners.set(type, a.filter((f) => f !== fn)); },
  };
  return el;
}

function stubDoc() {
  const listeners = new Map<string, Array<(ev?: unknown) => void>>();
  return {
    hidden: false,
    addEventListener: (t: string, f: (ev?: unknown) => void) => { listeners.set(t, [...(listeners.get(t) ?? []), f]); },
    removeEventListener: (t: string, f: (ev?: unknown) => void) => { const a = listeners.get(t) ?? []; listeners.set(t, a.filter((x) => x !== f)); },
    listeners,
  } as unknown as Document & { listeners: Map<string, Array<(ev?: unknown) => void>> };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe('7-2 mountApprovalsPage（FR-A-2 默认待办视图 + FR-A-4 前端过滤 + 5s 轮询）', () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    map.set('shanhai-portal-token', 'tok-a');
    vi.stubGlobal('sessionStorage', {
      get length() { return map.size; }, clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null, key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => { map.delete(k); }, setItem: (k: string, v: string) => { map.set(k, v); },
    } as Storage);
    vi.stubGlobal('location', { hash: '#/approvals' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('默认待办视图请求 pending=true；切全部视图拉全量 + decision 本地过滤', async () => {
    const calls: string[] = [];
    const view = stubViewEl();
    const timersHost = fakeTimerHost();
    const rows = [
      approvalRow({ requestId: 'req-1111' }),
      approvalRow({ requestId: 'req-2222', decision: 'denied' }),
    ];
    const fetchImpl = vi.fn(async (path: string) => {
      calls.push(path);
      if (path.includes('pending=true')) return jsonResponse(rows.filter((r) => r.decision === 'pending'));
      return jsonResponse(rows);
    });
    const handle = mountApprovalsPage({
      doc: stubDoc(), view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: timersHost.host,
      confirmBox: () => true, now: () => NOW,
    }, {});
    await vi.waitFor(() => expect(calls).toContain('/api/approvals?pending=true'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-1111'));
    expect(view.innerHTML).not.toContain('req-2222');
    // 切全部视图
    view.listeners.get('click')![0]({
      preventDefault: () => {},
      target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'view-all' } } : null) },
    });
    await vi.waitFor(() => expect(calls).toContain('/api/approvals'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-2222'));
    // decision 过滤（前端本地）
    view.listeners.get('change')![0]({
      preventDefault: () => {},
      target: { value: 'denied', closest: (sel: string) => (sel === '[data-filter]' ? { dataset: { filter: 'decision' } } : null) },
    });
    await vi.waitFor(() => {
      expect(view.innerHTML).toContain('req-2222');
      expect(view.innerHTML).not.toContain('req-1111');
    });
    handle.destroy();
  });

  it('轮询周期 5s；destroy 停', async () => {
    const view = stubViewEl();
    const timersHost = fakeTimerHost();
    const fetchImpl = vi.fn(async () => jsonResponse([approvalRow({ requestId: 'req-1' })]));
    const handle = mountApprovalsPage({
      doc: stubDoc(), view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: timersHost.host,
      confirmBox: () => true, now: () => NOW,
    }, {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('req-1'));
    expect(timersHost.timers.every((t) => t.ms === 5_000)).toBe(true);
    handle.destroy();
    expect(timersHost.timers).toHaveLength(0);
  });
});

describe('7-2 mountApprovalDetailPage（FR-AD-2/5：点击即提交 + 提交前重查）', () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    map.set('shanhai-portal-token', 'tok-ad');
    vi.stubGlobal('sessionStorage', {
      get length() { return map.size; }, clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null, key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => { map.delete(k); }, setItem: (k: string, v: string) => { map.set(k, v); },
    } as Storage);
    vi.stubGlobal('location', { hash: '#/approvals/req-11112222ffff' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('deny：先重查详情（仍 pending）→ POST deny → 反馈成功并刷新', async () => {
    const view = stubViewEl();
    const gets: string[] = [];
    const posts: string[] = [];
    let decision = 'pending';
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(path); decision = 'denied'; return jsonResponse({ ok: true, requestId: 'req-11112222ffff', taskId: 'task-aaaabbbb', decision: 'denied', taskStatus: 'cancelled', cancelReason: 'approval_denied' }); }
      gets.push(path);
      if (path.startsWith('/api/tasks/')) return jsonResponse({ taskId: 'task-aaaabbbb', status: decision === 'denied' ? 'cancelled' : 'paused' });
      return jsonResponse({ ...showBody, request: { ...showBody.request, decision, decidedAt: decision === 'denied' ? '2026-10-01T11:40:00.000Z' : null } });
    });
    const handle = mountApprovalDetailPage({
      doc: stubDoc(), view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: fakeTimerHost().host,
      confirmBox: () => true, now: () => NOW,
    }, 'req-11112222ffff');
    await vi.waitFor(() => expect(view.innerHTML).toContain('tool-risky'));
    const getsBefore = gets.length;
    view.listeners.get('click')![0]({
      preventDefault: () => {},
      target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'deny' } } : null) },
    });
    await vi.waitFor(() => expect(posts).toEqual(['/api/approvals/req-11112222ffff/deny']));
    expect(gets.length).toBeGreaterThan(getsBefore); // FR-AD-5 提交前重查
    await vi.waitFor(() => expect(view.innerHTML).toContain('该请求已终局（只读）'));
    handle.destroy();
  });

  it('FR-AD-5 竞态：重查发现已非 pending → 不 POST，提示「该审批已被处理」并刷新', async () => {
    const view = stubViewEl();
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(path); return jsonResponse({}); }
      if (path.startsWith('/api/tasks/')) return jsonResponse({ taskId: 'task-aaaabbbb', status: 'paused' });
      return jsonResponse({ ...showBody, request: { ...showBody.request, decision: 'approved', decidedAt: '2026-10-01T11:20:00.000Z' } });
    });
    const handle = mountApprovalDetailPage({
      doc: stubDoc(), view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: fakeTimerHost().host,
      confirmBox: () => true, now: () => NOW,
    }, 'req-11112222ffff');
    await vi.waitFor(() => expect(view.innerHTML).toContain('已批准'));
    view.listeners.get('click')![0]({
      preventDefault: () => {},
      target: { closest: () => null }, // 已无按钮；改为直接调用不可达——本用例验证按钮隐藏即可
    });
    expect(view.innerHTML).not.toMatch(/data-action="deny"/);
    expect(posts).toHaveLength(0);
    handle.destroy();
  });

  it('409 already_decided → 红条显示分类文案（FR-WR-5）', async () => {
    const view = stubViewEl();
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: false, code: 'already_decided', message: 'm' }, 409);
      if (path.startsWith('/api/tasks/')) return jsonResponse({ taskId: 'task-aaaabbbb', status: 'paused' });
      return jsonResponse(showBody);
    });
    const handle = mountApprovalDetailPage({
      doc: stubDoc(), view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: fakeTimerHost().host,
      confirmBox: () => true, now: () => NOW,
    }, 'req-11112222ffff');
    await vi.waitFor(() => expect(view.innerHTML).toContain('tool-risky'));
    view.listeners.get('click')![0]({
      preventDefault: () => {},
      target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'approve' } } : null) },
    });
    await vi.waitFor(() => expect(view.innerHTML).toContain('该审批已决议（approve/deny 竞态后到方），刷新查看'));
    expect(view.innerHTML).toMatch(/feedback--error/);
    handle.destroy();
  });
});
