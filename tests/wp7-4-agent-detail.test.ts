import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountAgentDetailPage } from '../src/portal/ui/agentsPage.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import {
  clickEvent,
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
  type FakeTimer,
  type StubDoc,
  type StubEl,
} from './wp7-3-mount-stubs.js';

// 第七阶段批次四（7-4/4）：Agent 详情（设计 V0.3 §7.5 FR-AG-1..5）——四读面。
// 数据源：GET /api/agents/:id/card|insight|trend?bucket=day|week|report（全只读）；
// 「触发反思」写操作零出现（对应端点不存在，本期写面 5 POST 不含它）；attempts 字段零出现。
// TDD 红阶段先行：本文件先于实现落库。

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PLACEHOLDER_BEASTS = /麒麟|朱雀|九尾狐|饕餮/;
const FORBIDDEN = /reflection|attempts|触发反思/;

const CARD = {
  agentId: 'ag-1',
  versionId: 'v-0001',
  specVersion: '1',
  contentHash: 'hash-abcdef',
  mission: { responsibilities: ['执行回显工具调用', '输出结构化结论'] },
  nonGoals: ['修改文件内容'],
  tools: [{ toolId: 'echo-echo', riskLevel: 'L3' }, { toolId: 'fs-read', riskLevel: 'L1' }],
  inputContract: { digest: 'd-in', type: 'object' },
  outputContract: { digest: 'd-out', type: 'object' },
  budgets: { maxModelCalls: 10 },
  approvalPolicy: { mode: 'onHighRisk' },
  evolutionPolicy: null,
};

const INSIGHT = {
  agentId: 'ag-1',
  versionId: 'v-0001',
  generatedAt: '2026-10-01T12:00:00.000000000Z',
  declared: {
    agentId: 'ag-1',
    versionId: 'v-0001',
    specVersion: '1',
    contentHash: 'hash-abcdef',
    mission: { responsibilities: ['执行回显工具调用'] },
    nonGoals: ['修改文件内容'],
    tools: [{ toolId: 'echo-echo', riskLevel: 'L3' }],
  },
  assertions: {
    active: {
      counts: { capability: 2, limitation: 1 },
      entries: [
        { capabilityId: 'cap-1', kind: 'capability', statement: '能稳定回显', origin: 'derived', evidenceCount: 2 },
        { capabilityId: 'cap-2', kind: 'limitation', statement: '不能改文件', origin: 'derived', evidenceCount: 1 },
      ],
    },
    openCandidates: { total: 2, evidencePending: 1 },
    emptyHint: null,
  },
  behavior: {
    since: '2026-09-01T00:00:00.000000000Z',
    bucket: 'day',
    buckets: [{ key: '2026-09-30', tasks: { total: 4, succeeded: 3, excludedCancelled: 1, contractFailures: 1, contractPassRate: 0.667 } }],
    status: 'ok',
    insufficientNote: null,
  },
  limitations: { entries: [], evidenceSummary: {} },
};

function trendOf(bucket: 'day' | 'week') {
  return {
    agentId: 'ag-1',
    bucket,
    since: null,
    until: '2026-10-01T12:00:00.999999999Z',
    buckets: [
      { key: bucket === 'day' ? '2026-09-30' : '2026-09-28', tasks: { total: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, contractPassRate: null }, failureBySubClass: {}, memoryEvents: 0, registry: { candidate: 0, active: 0, retired: 0 } },
      { key: bucket === 'day' ? '2026-10-01' : '2026-10-05', tasks: { total: 4, succeeded: 3, excludedCancelled: 1, contractFailures: 1, contractPassRate: 0.75 }, failureBySubClass: { contract: 1 }, memoryEvents: 0, registry: { candidate: 0, active: 0, retired: 0 } },
    ],
    coverage: { memoryFrom: null, note: 'coverage-from-memory:尚无 memory_state_changed 事件（记忆面无前史，计数恒 0）；任务面/失败面为全史口径（不标注）' },
  };
}

const REPORT = {
  agentId: 'ag-1',
  since: null,
  groups: [
    { assignmentSource: 'stable', tasks: 5, succeeded: 4, excludedCancelled: 1, contractFailures: 1, contractPassRate: 0.75 },
    { assignmentSource: 'canary', tasks: 2, succeeded: 2, excludedCancelled: 0, contractFailures: 0, contractPassRate: 1 },
    { assignmentSource: 'explicit', tasks: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, contractPassRate: null },
  ],
  promoteCriteria: { status: 'insufficient-sample', canaryPassRate: 1, stablePassRate: 0.75, canarySample: 2, threshold: '金丝雀样本 2 < 20——数据不足，系统不假装给了答案' },
  sideColumns: {
    approvalTimeoutCount: 2,
    toolUpgradeAffectedSpecs: [],
    stale: { queued: 0, paused: 0 },
    canaryRounds: { boundaryEvents: [], warning: null },
  },
  healthPanel: { traceEventCount: 12000, traceFileCount: 3, t1QueryP95Ms: null, triggered: true, note: 'OTel 触发条件①已满足——按 §4.8 投影层设计实施' },
};

function makeCtx(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>): { ctx: PageCtx; view: StubEl; doc: StubDoc; timers: FakeTimer[] } {
  const view = stubViewEl();
  const doc = stubDoc();
  const { host, timers } = fakeTimerHost();
  return {
    ctx: {
      doc: doc as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: host,
      confirmBox: () => true,
      now: () => NOW,
    },
    view, doc, timers,
  };
}

function authed(path: string): boolean {
  return typeof path === 'string' && path.startsWith('/api/agents/ag-1/');
}

describe('7-4 mountAgentDetailPage（FR-AG-1..5 四读面）', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-4' }));
    locationStub = { hash: '#/agents/ag-1' };
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function fullFetch(overrides: Record<string, unknown> = {}, failCard = false) {
    return async (path: string): Promise<Response> => {
      if (!authed(path)) throw new Error(`未预期的请求：${path}`);
      if (path === '/api/agents/ag-1/card') {
        if (failCard) return jsonResponse({ ok: false, code: 'not_found', message: 'agentCard：ag-1 无当前指针版本' }, 404);
        return jsonResponse(overrides.card ?? CARD);
      }
      if (path === '/api/agents/ag-1/insight') return jsonResponse(overrides.insight ?? INSIGHT);
      if (path === '/api/agents/ag-1/trend' || path === '/api/agents/ag-1/trend?bucket=day') return jsonResponse(overrides.trendDay ?? trendOf('day'));
      if (path === '/api/agents/ag-1/trend?bucket=week') return jsonResponse(overrides.trendWeek ?? trendOf('week'));
      if (path === '/api/agents/ag-1/report') return jsonResponse(overrides.report ?? REPORT);
      throw new Error(`未预期的请求：${path}`);
    };
  }

  it('FR-AG-1 能力卡区：卡片内容渲染（身份字段 + mission/nonGoals/tools + 契约摘要 + 治理 JSON）', async () => {
    const { ctx, view } = makeCtx(fullFetch());
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('v-0001'));
    const html = view.innerHTML;
    expect(html).toContain('v-0001');
    expect(html).toContain('执行回显工具调用');
    expect(html).toContain('修改文件内容');
    expect(html).toContain('echo-echo');
    expect(html).toContain('L3');
    expect(html).toContain('d-in');
    expect(html).toContain('maxModelCalls');
    handle.destroy();
  });

  it('FR-AG-1 加载失败显错误条可重试：404 卡区错误 + 重试后恢复', async () => {
    let fail = true;
    const calls: string[] = [];
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/agents/ag-1/card') {
        calls.push(path);
        if (fail) return jsonResponse({ ok: false, code: 'not_found', message: 'agentCard：ag-1 无当前指针版本（card 导出需显式 versionId 或已 release 移指针）' }, 404);
        return jsonResponse(CARD);
      }
      return fullFetch()(path);
    });
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('能力卡加载失败'));
    expect(view.innerHTML).toContain('重试');
    expect(view.innerHTML).toContain('对象不存在'); // FR-WR-5 not_found 口径文案
    fail = false;
    const click = view.listeners.get('click')?.[0];
    click?.(clickEvent({ action: 'retry' }));
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(view.innerHTML).toContain('执行回显工具调用'));
    handle.destroy();
  });

  it('FR-AG-2 认知洞察区：三区按键渲染（declared / assertions 内嵌三键 / behavior 窗）', async () => {
    const { ctx, view } = makeCtx(fullFetch());
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('声明面'));
    const html = view.innerHTML;
    expect(html).toContain('声明面');
    expect(html).toContain('断言面');
    expect(html).toContain('行为面');
    expect(html).toContain('待补证据候选'); // openCandidates 摘要
    expect(html).toContain('2'); // total
    expect(html).toContain('近 30 天');
    expect(html).not.toContain('emptyHint');
    expect(FORBIDDEN.test(html)).toBe(false);
    handle.destroy();
  });

  it('FR-AG-2 空 Registry：emptyHint 原样展示（空态非错误）', async () => {
    const hint = 'Registry 无该 agent 条目——capability add 人工登记，或等 derived 判据窗口内数据积累（空清单非错误）';
    const { ctx, view } = makeCtx(fullFetch({
      insight: {
        ...INSIGHT,
        assertions: { active: { counts: { capability: 0, limitation: 0 }, entries: [] }, openCandidates: { total: 0, evidencePending: 0 }, emptyHint: hint },
        behavior: { ...INSIGHT.behavior, buckets: [], status: 'insufficient-sample', insufficientNote: 'insufficient-sample：窗口内无任务数据——系统不假装给了答案' },
      },
    }));
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain(hint));
    expect(view.innerHTML).toContain('insufficient-sample');
    handle.destroy();
  });

  it('FR-AG-3 趋势区：TrendSummary + bar 图五键 + null 桶「—」+ coverage 注记', async () => {
    const { ctx, view } = makeCtx(fullFetch());
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('trend-bar'));
    const html = view.innerHTML;
    expect(html).toContain('trend-bar'); // CSS bar 图
    expect(html).toContain('coverage-from-memory'); // 覆盖说明原样
    expect(html).toMatch(/0\.750/);
    expect(html).toContain('—'); // null 桶
    // bucket 切换器存在（day/week 两态）
    expect(html).toMatch(/data-action="bucket-(day|week)"/);
    handle.destroy();
  });

  it('FR-AG-3 bucket 切换：URL 同步改写 hash（?bucket=week）；缺省 day 不带参', async () => {
    const { ctx, view } = makeCtx(fullFetch());
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('trend-bar'));
    const click = view.listeners.get('click')?.[0];
    click?.(clickEvent({ action: 'bucket-week' }));
    expect(locationStub.hash).toBe('#/agents/ag-1?bucket=week');
    click?.(clickEvent({ action: 'bucket-day' }));
    expect(locationStub.hash).toBe('#/agents/ag-1'); // day 缺省省略参数
    handle.destroy();
  });

  it('FR-AG-3 ?bucket=week 直落：挂载即取 week 桶 + hasData=false 空态', async () => {
    const requests: string[] = [];
    const { ctx, view } = makeCtx(async (path) => {
      requests.push(path);
      if (path === '/api/agents/ag-1/trend?bucket=week') {
        return jsonResponse({ ...trendOf('week'), buckets: [] }); // hasData=false
      }
      return fullFetch()(path);
    });
    locationStub.hash = '#/agents/ag-1?bucket=week';
    const handle = mountAgentDetailPage(ctx, 'ag-1', { bucket: 'week' });
    await vi.waitFor(() => expect(requests).toContain('/api/agents/ag-1/trend?bucket=week'));
    await vi.waitFor(() => expect(view.innerHTML).toContain('—（无分母不假装）'));
    handle.destroy();
  });

  it('FR-AG-4 报告摘要区：五键渲染 + 超时橙色徽章（>0）+ 健康触发提示条', async () => {
    const { ctx, view } = makeCtx(fullFetch());
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('样本不足'));
    const html = view.innerHTML;
    expect(html).toContain('样本不足'); // promoteLabel（view/agent.ts 词表口径）
    expect(html).toContain('审批超时'); // approvalTimeoutCount 标签
    expect(html).toContain('badge--warn'); // >0 橙色徽章
    expect(html).toContain('OTel 触发条件①已满足'); // healthTriggered 提示条（note 原样）
    expect(html).toMatch(/分组|groupCount/);
    handle.destroy();
  });

  it('FR-AG-4 零超时/未触发：徽章与提示条不出现', async () => {
    const { ctx, view } = makeCtx(fullFetch({
      report: {
        ...REPORT,
        sideColumns: { ...REPORT.sideColumns, approvalTimeoutCount: 0 },
        healthPanel: { ...REPORT.healthPanel, triggered: false, note: '触发指标未达' },
      },
    }));
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('样本不足'));
    expect(view.innerHTML).not.toContain('badge--warn');
    expect(view.innerHTML).not.toContain('提示条');
    handle.destroy();
  });

  it('FR-AG-5 能力下钻：底部链接跳 #/observe/capabilities?agent=（encode 形态，断言解码比对）', async () => {
    const { ctx, view } = makeCtx(fullFetch());
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('能力登记'));
    const hrefs = [...view.innerHTML.matchAll(/href="#\/observe\/capabilities\?agent=([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
    expect(hrefs).toContain('ag-1'); // P3-2 备案：decodeURIComponent 比对
    expect(view.innerHTML).toContain('查看该 Agent 的能力登记');
    handle.destroy();
  });

  it('只读边界：无「触发反思」等写操作按钮；全页零 POST', async () => {
    const { ctx, view } = makeCtx(fullFetch());
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('能力卡（card ·')); // 数据已渲染（壳标题无后缀）
    expect(FORBIDDEN.test(view.innerHTML)).toBe(false);
    expect(PLACEHOLDER_BEASTS.test(view.innerHTML)).toBe(false);
    handle.destroy();
  });

  it('401 → 认证失效提示并停轮询；destroy 停轮询移除监听', async () => {
    const { ctx, view, timers } = makeCtx(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'Token 无效' }, 401));
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('认证失效'));
    handle.destroy();
    expect(timers.length).toBe(0);
    expect(view.listeners.get('click')?.length ?? 0).toBe(0);
  });
});

describe('7-4 mountAgentDetailPage 边界面（分区独立失败 / 可见性 / 形态防御）', () => {
  let locationStub: { hash: string };

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-7-4' }));
    locationStub = { hash: '#/agents/ag-1' };
    vi.stubGlobal('location', locationStub);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const okFetch = async (path: string): Promise<Response> => {
    if (path === '/api/agents/ag-1/card') return jsonResponse(CARD);
    if (path === '/api/agents/ag-1/insight') return jsonResponse(INSIGHT);
    if (path === '/api/agents/ag-1/trend') return jsonResponse(trendOf('day'));
    if (path === '/api/agents/ag-1/report') return jsonResponse(REPORT);
    throw new Error(`未预期的请求：${path}`);
  };

  it('分区独立失败：report 500 → 报告摘要错误条（未知码如实展示），其余三区照常渲染', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/agents/ag-1/report') return jsonResponse({ ok: false, code: 'internal_error', message: 'boom' }, 500);
      return okFetch(path);
    });
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('报告摘要加载失败'));
    expect(view.innerHTML).toContain('internal_error：boom'); // 未知码如实展示（FR-WR-5）
    await vi.waitFor(() => expect(view.innerHTML).toContain('执行回显工具调用')); // 卡区照常
    handle.destroy();
  });

  it('趋势分区失败：trend 500 → 趋势区错误条 + bucket 切换器仍在；形状异常（buckets 缺失）→ 显错误条', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/agents/ag-1/trend') return jsonResponse({ ok: false, code: 'internal_error', message: 'db' }, 500);
      return okFetch(path);
    });
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('能力趋势加载失败'));
    expect(view.innerHTML).toContain('data-action="bucket-week"');
    handle.destroy();

    const { ctx: ctx2, view: view2 } = makeCtx(async (path) => {
      if (path === '/api/agents/ag-1/trend') return jsonResponse({ agentId: 'ag-1', bucket: 'day', nope: true });
      return okFetch(path);
    });
    const handle2 = mountAgentDetailPage(ctx2, 'ag-1', {});
    await vi.waitFor(() => expect(view2.innerHTML).toContain('能力趋势加载失败'));
    expect(view2.innerHTML).toContain('响应形状异常');
    handle2.destroy();
  });

  it('形状防御：card/insight 缺键 → 各自错误条（不假装渲染）', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/agents/ag-1/card') return jsonResponse({ nope: 1 });
      if (path === '/api/agents/ag-1/insight') return jsonResponse({ declared: {} });
      return okFetch(path);
    });
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('能力卡加载失败'));
    expect(view.innerHTML).toContain('响应形状异常（Agent Card 键缺失）');
    await vi.waitFor(() => expect(view.innerHTML).toContain('认知洞察加载失败'));
    handle.destroy();
  });

  it('空 mission/nonGoals/tools → 「—」空位呈现；declared.tools 非数组防御', async () => {
    const { ctx, view } = makeCtx(async (path) => {
      if (path === '/api/agents/ag-1/card') return jsonResponse({ ...CARD, mission: { responsibilities: [] }, nonGoals: [], tools: [] });
      if (path === '/api/agents/ag-1/insight') return jsonResponse({ ...INSIGHT, declared: { ...INSIGHT.declared, tools: 'nope' } });
      return okFetch(path);
    });
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('能力卡（card ·'));
    expect(view.innerHTML).toContain('—');
    expect(view.innerHTML).not.toContain('nope');
    handle.destroy();
  });

  it('visibilitychange：不可见暂停轮询、恢复可见立即拉取（FR-G-4）', async () => {
    const { ctx, view, doc, timers } = makeCtx(okFetch);
    const handle = mountAgentDetailPage(ctx, 'ag-1', {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('v-0001'));
    const vis = doc.listeners.get('visibilitychange')![0];
    vis({ target: { hidden: true } }); // 不可见：清周期定时器
    expect(timers.length).toBe(0);
    vis({ target: { hidden: false } }); // 恢复可见：立即拉一次并重启周期
    await vi.waitFor(() => expect(timers.length).toBe(1));
    handle.destroy();
  });
});
