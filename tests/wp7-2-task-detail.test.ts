import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { taskDetailHtml, collapseInput, eventRowsFor } from '../src/portal/ui/taskDetailView.js';
import { mountTaskDetailPage } from '../src/portal/ui/taskDetailPage.js';
import type { TimerHost } from '../src/portal/ui/poll.js';

// 第七阶段批次二（7-2/4）：任务详情页交互逻辑（设计 V0.3 §5 FR-TD-1..7）——
// 头部字段（实测列，零虚构字段）、双点时间线、input 折叠、事件流正序 + eventType 过滤、
// 证据 ref 链接、关联区（parentTaskId/children 前端聚合）、操作区、3s 轮询终态停止。
// TDD 红阶段先行。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;

const taskRow = {
  taskId: 'task-aaaabbbbccccdddd',
  agentId: 'ag-1',
  agentVersionId: 'ver-9',
  specContentHash: 'hash-1',
  input: JSON.stringify({ goal: 'x'.repeat(10) }, null, 2),
  status: 'paused',
  attemptCount: 1,
  modelCallCount: 3,
  tokensUsed: 98765,
  consecutiveDenialCount: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  startedAt: '2026-10-01T10:00:05.000Z',
  endedAt: null,
  traceFile: 'trace.jsonl',
  terminalFailureClass: null,
  abortRequested: 0,
  pausedDurationMs: 0,
  cancelReason: null,
  assignmentSource: null,
  parentTaskId: 'task-parent0001',
  delegationDepth: 1,
};

const events = [
  { eventId: 'e-2', eventType: 'task_paused', timestamp: '2026-10-01T10:01:00.000Z', callNo: 3, callKind: 'tool', attemptNo: 1 },
  { eventId: 'e-1', eventType: 'task_created', timestamp: '2026-10-01T10:00:00.000Z', callNo: 0, callKind: null, attemptNo: 1 },
];

describe('7-2 taskDetailView 纯函数（FR-TD-3 input 折叠 / FR-TD-4 事件流）', () => {
  it('collapseInput：≤50 行全文；>50 行折叠为前 50 行 + 展开全部', () => {
    const short = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
    expect(collapseInput(short).collapsed).toBe(false);
    const long = Array.from({ length: 80 }, (_, i) => `line-${i}`).join('\n');
    const c = collapseInput(long);
    expect(c.collapsed).toBe(true);
    expect(c.head.split('\n')).toHaveLength(50);
    expect(c.full.split('\n')).toHaveLength(80);
  });

  it('eventRowsFor：按时间正序 + eventType 多选过滤（无 step 维度）', () => {
    const rows = eventRowsFor(events, new Set(['task_paused']));
    expect(rows.map((r) => r.eventId)).toEqual(['e-2']);
    expect(eventRowsFor(events, new Set()).map((r) => r.eventId)).toEqual(['e-1', 'e-2']); // 正序
  });
});

describe('7-2 taskDetailHtml（FR-TD-1..7 各区渲染）', () => {
  const html = taskDetailHtml({
    task: taskRow,
    events,
    evidence: [{ ref: 'task:task-1111', kind: 'attempt' }],
    children: [{ taskId: 'task-child0001', status: 'queued' }],
    feedback: null,
    now: NOW,
  });

  it('头部：完整 taskId 等宽 + 复制按钮 + 实测列（agentVersionId/tokensUsed 千分位/cancelReason 不显于非取消任务）', () => {
    expect(html).toContain('task-aaaabbbbccccdddd');
    expect(html).toContain('复制');
    expect(html).toContain('ver-9');
    expect(html).toContain('98,765');
    expect(html).toContain('badge--status-paused');
  });

  it('时间线：创建 → 进行中（endedAt 空显示进行中，不虚构阶段节点）', () => {
    expect(html).toContain('创建');
    expect(html).toContain('进行中');
  });

  it('证据区：ref 等宽 + 链接跳观测·夔牛·证据（#/observe/evidence?ref=）', () => {
    expect(html).toContain('task:task-1111');
    expect(html).toContain('#/observe/evidence?ref=task%3Atask-1111');
  });

  it('关联区：父任务链接 + 子任务行（短码+徽章）', () => {
    expect(html).toContain('#/tasks/task-parent0001');
    expect(html).toContain('task-child0');
    expect(html).toContain('badge--status-queued');
  });

  it('操作区：paused → 取消 + 续跑；无滞留不出崩溃恢复', () => {
    expect(html).toMatch(/data-action="cancel"/);
    expect(html).toMatch(/data-action="resume"/);
    expect(html).not.toMatch(/data-action="crash-recovery"/);
  });

  it('终态任务（cancelled）：显示 cancelReason；不出取消/续跑', () => {
    const done = taskDetailHtml({
      task: { ...taskRow, status: 'cancelled', endedAt: '2026-10-01T11:00:00.000Z', cancelReason: 'user' },
      events: [],
      evidence: [],
      children: [],
      feedback: null,
      now: NOW,
    });
    expect(done).toContain('user');
    expect(done).not.toMatch(/data-action="cancel"/);
    expect(done).not.toMatch(/data-action="resume"/);
  });

  it('滞留 running 详情：出显式崩溃恢复（全局端点）', () => {
    const stale = taskDetailHtml({
      task: { ...taskRow, status: 'running', createdAt: new Date(NOW - 11 * 60_000).toISOString() },
      events: [],
      evidence: [],
      children: [],
      feedback: null,
      now: NOW,
    });
    expect(stale).toMatch(/data-action="crash-recovery"/);
  });

  it('空证据/空关联：显示约定空态文案', () => {
    const empty = taskDetailHtml({ task: { ...taskRow, parentTaskId: null }, events: [], evidence: [], children: [], feedback: null, now: NOW });
    expect(empty).toContain('本任务未登记证据引用');
    expect(empty).toContain('无关联任务');
  });

  it('占位神兽零出现', () => {
    expect(PLACEHOLDER_BEASTS.test(html)).toBe(false);
  });
});

// ---------- 装配 ----------

function fakeTimerHost(): { host: TimerHost; timers: Array<{ fn: () => void; ms: number; id: number }> } {
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

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe('7-2 mountTaskDetailPage（三读面 + 3s 轮询终态停止）', () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    map.set('shanhai-portal-token', 'tok-d');
    vi.stubGlobal('sessionStorage', {
      get length() { return map.size; }, clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null, key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => { map.delete(k); }, setItem: (k: string, v: string) => { map.set(k, v); },
    } as Storage);
    vi.stubGlobal('location', { hash: '#/tasks/task-aaaabbbbccccdddd' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('挂载并发三 GET（task/events/evidence）+ children 经 limit=100 前端聚合；轮询 3s；终态后停止', async () => {
    const calls: string[] = [];
    const timersHost = fakeTimerHost();
    const view = stubViewEl();
    let current = { ...taskRow };
    const fetchImpl = vi.fn(async (path: string) => {
      calls.push(path);
      if (path.endsWith('/events')) return jsonResponse(events);
      // 7-3 随批迁移：mock 对齐 TaskEvidenceChain 实测形状（真实端点无 refs 键，前端经 evidenceRowsOf 派生）
      if (path.endsWith('/evidence')) return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', trace: { eventIds: ['evt-11112222'] }, failures: [{ recordId: 'rec-1', subClass: 'x', occurredAt: '2026-10-01T10:00:00.000Z' }], memories: [] });
      if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [{ taskId: 'task-child0001', status: 'queued', agentId: 'ag-1', createdAt: '2026-10-01T10:00:00.000Z', endedAt: null, attemptCount: 0, modelCallCount: 0, tokensUsed: 0, parentTaskId: 'task-aaaabbbbccccdddd' }], total: 1 });
      return jsonResponse(current);
    });
    const handle = mountTaskDetailPage({
      doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: timersHost.host,
      confirmBox: () => true,
      now: () => NOW,
    }, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('task-child0'));
    expect(calls).toContain('/api/tasks/task-aaaabbbbccccdddd');
    expect(calls).toContain('/api/tasks/task-aaaabbbbccccdddd/events');
    expect(calls).toContain('/api/tasks/task-aaaabbbbccccdddd/evidence');
    expect(timersHost.timers.every((t) => t.ms === 3_000)).toBe(true);
    current = { ...current, status: 'succeeded', endedAt: '2026-10-01T12:00:00.000Z' };
    timersHost.timers[0].fn();
    await vi.waitFor(() => expect(timersHost.timers).toHaveLength(0));
    handle.destroy();
  });

  it('resume 成功：详情页反馈条含 resumeNote 原文 + CLI 兜底 + 查看续跑日志入口', async () => {
    const view = stubViewEl();
    const timersHost = fakeTimerHost();
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', spawned: true, resumedBy: 'manual-resume', pid: 9, logFile: '/d/resume-x.log' });
      if (path.endsWith('/events')) return jsonResponse([]);
      if (path.endsWith('/evidence')) return jsonResponse({ ok: true, taskId: 'task-aaaabbbbccccdddd', trace: { eventIds: [] }, failures: [], memories: [] });
      if (path.startsWith('/api/tasks?limit=100')) return jsonResponse({ tasks: [], total: 0 });
      return jsonResponse(taskRow);
    });
    const handle = mountTaskDetailPage({
      doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: timersHost.host,
      confirmBox: () => true,
      now: () => NOW,
    }, 'task-aaaabbbbccccdddd');
    await vi.waitFor(() => expect(view.innerHTML).toContain('时间线'));
    view.listeners.get('click')![0]({
      preventDefault: () => {},
      target: { closest: (sel: string) => (sel === '[data-action]' ? { dataset: { action: 'resume', taskId: 'task-aaaabbbbccccdddd' } } : null) },
    });
    await vi.waitFor(() => expect(view.innerHTML).toContain('shanhai task run task-aaaabbbbccccdddd --resume --resumed-by manual-resume'));
    expect(view.innerHTML).toContain('查看续跑日志');
    handle.destroy();
  });
});
