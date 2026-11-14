import { describe, expect, it } from 'vitest';
import { makeHarness, sampleSpec, validationDepsOf, type Harness } from './helpers.js';
import { validateRegistration, validateDefensive } from '../src/modules/specValidator.js';
import { queryT1, queryT2, queryT2Prime } from '../src/evidence.js';
import { McpClient, type McpTransport } from '../src/mcp/client.js';
import { ModelGateway, TerminalModelFailure, type BudgetLedger } from '../src/modules/modelGateway.js';
import { ProviderError } from '../src/providers/types.js';
import type { PersistentMemoryPolicy } from '../src/modules/memory.js';
import type { ChatRequest, ModelProvider, ProviderResponse } from '../src/providers/types.js';

// ============================================================
// TASK-254（第四十二批覆盖加固）：针对 a9c0405 基线 statements 缺口 185 条中
// 可测价值面（错误分支/边界条件）的定向用例，不为凑指标刷行数。
// 覆盖面：specValidator 注册拒绝细分 ×6、evidence T1/T2/T2' 缺失防御 ×3、
// MCP client 分发防御 ×4、MemoryManager 去重/上限/无效 ID ×3、ModelGateway 错误分类 ×4。
// ============================================================

describe('TASK-254 覆盖加固：specValidator 注册准入拒绝细分分支', () => {
  it('Spec 非 JSON 对象（数组/字符串/null）：整体拒绝并指名 $ 路径', () => {
    const h = makeHarness();
    const deps = validationDepsOf(h.rt);
    for (const bad of [[], 'not-an-object', null, 42]) {
      const r = validateRegistration(bad, deps);
      expect(r.ok).toBe(false);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].path).toBe('$');
      expect(r.issues[0].message).toContain('Spec 必须为 JSON 对象');
    }
  });

  it('引用已 retired 工具：悬空引用防线拒绝（status 非 active）', () => {
    const h = makeHarness();
    h.rt.registry.registerTool(
      { toolId: 'gone-tool', name: 'gone-tool', kind: 'builtin', riskLevel: 'L0', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'retired' },
      'test',
    );
    const spec = sampleSpec({ tools: [{ toolId: 'gone-tool', riskLevel: 'L0' }] });
    const r = validateRegistration(spec, validationDepsOf(h.rt));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.path === 'toolPolicy.tools[0].toolId');
    expect(issue?.message).toContain('已 retired');
  });

  it('fallbackModel ∉ allowedModels：注册拒绝', () => {
    const h = makeHarness();
    const spec = sampleSpec({ modelPolicy: { fallbackModel: 'not-in-list' } });
    const r = validateRegistration(spec, validationDepsOf(h.rt));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'modelPolicy.fallbackModel' && i.message.includes('∈ allowedModels'))).toBe(true);
  });

  it('A2§6 子集违规（禁用关键字 pattern）：inputContract 拒绝并指名路径', () => {
    const h = makeHarness();
    const spec = sampleSpec({
      inputContract: { type: 'object', properties: { topic: { type: 'string', pattern: '^a' } }, required: ['topic'], additionalProperties: false },
    });
    const r = validateRegistration(spec, validationDepsOf(h.rt));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.message.includes('A2§6 子集违规'));
    expect(issue?.path.startsWith('inputContract')).toBe(true);
    expect(issue?.message).toContain('pattern');
  });

  it('契约顶层非 object（type:"string"）：双契约对称拒绝', () => {
    const h = makeHarness();
    const spec = sampleSpec({
      inputContract: { type: 'string' },
      outputContract: { type: 'number' },
    });
    const r = validateRegistration(spec, validationDepsOf(h.rt));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'inputContract.type')).toBe(true);
    expect(r.issues.some((i) => i.path === 'outputContract.type')).toBe(true);
  });

  it('validateDefensive 快照哈希不符：防御性复验即时拒绝', () => {
    const h = makeHarness();
    const spec = sampleSpec();
    const r = validateDefensive(spec, 'expected-hash', 'actual-hash', validationDepsOf(h.rt));
    expect(r.ok).toBe(false);
    expect(r.issues[0].path).toBe('$');
    expect(r.issues[0].message).toContain('快照哈希不符');
    expect(r.issues[0].message).toContain('expected-hash');
    expect(r.issues[0].message).toContain('actual-hash');
  });
});

describe('TASK-254 覆盖加固：evidence 单一查询口径缺失防御', () => {
  it('queryT1：无 Trace 文件即拒绝（不留空答案）', () => {
    const h = makeHarness();
    expect(() => queryT1(h.rt, 'no-such-task')).toThrow(/无 Trace 文件/);
  });

  it('queryT1：信封版本不可解析（库被篡改形态）即拒绝', () => {
    const h = makeHarness();
    h.rt.trace.recordTaskEvent(
      { taskId: 't-orphan', agentId: 'a-orphan', agentVersionId: 'v-missing', specContentHash: 'hash' },
      'task_created',
      {},
    );
    expect(() => queryT1(h.rt, 't-orphan')).toThrow(/版本不存在：v-missing/);
  });

  it('queryT2 / queryT2Prime：版本不存在即拒绝', () => {
    const h = makeHarness();
    expect(() => queryT2(h.rt, 'v-missing')).toThrow(/版本不存在/);
    expect(() => queryT2Prime(h.rt, 'v-missing')).toThrow(/版本不存在/);
  });
});

describe('TASK-254 覆盖加固：MCP client 消息分发与连接防御', () => {
  function fakeTransport() {
    let listener: ((msg: unknown) => void) | null = null;
    const sent: object[] = [];
    const t: McpTransport & { emit: (m: unknown) => void; sent: object[] } = {
      send: (m) => { sent.push(m); },
      onMessage: (h) => { listener = h; },
      close: async () => {},
      emit: (m) => { listener?.(m); },
      get sent() { return sent; },
    };
    return t;
  }

  it('未连接（transport 缺失）即 request：fail-fast 拒绝', () => {
    const client = new McpClient();
    expect(() => client.request('tools/list')).toThrow(/MCP client 未连接/);
  });

  it('server→client 通知（无 id）与未知 id 迟到响应：分发通道忽略不炸', async () => {
    const client = new McpClient();
    const t = fakeTransport();
    client.attach(t);
    // 无 id 通知：直接忽略（不进 pending 分发）
    t.emit({ jsonrpc: '2.0', method: 'notifications/whatever' });
    // 未知 id（重复/迟到响应）：忽略
    t.emit({ jsonrpc: '2.0', id: 9999, result: { stale: true } });
    // 正常请求仍可用（未被杂散消息污染）
    const p = client.request('ping');
    t.emit({ jsonrpc: '2.0', id: 1, result: 'pong' });
    await expect(p).resolves.toBe('pong');
  });

  it('JSON-RPC error 响应：pending 以结构化错误 reject（不静默挂死）', async () => {
    const client = new McpClient();
    const t = fakeTransport();
    client.attach(t);
    const p = client.request('tools/call', { name: 'boom', arguments: {} });
    t.emit({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom 工具失败' } });
    await expect(p).rejects.toThrow(/MCP -32000: boom 工具失败/);
  });

  it('close()：pending 请求全部 reject 后不再挂起', async () => {
    const client = new McpClient();
    const t = fakeTransport();
    client.attach(t);
    const p = client.request('tools/list');
    await expect(client.close()).resolves.toBeUndefined();
    await expect(p).rejects.toThrow(/MCP client 已关闭/);
  });
});

describe('TASK-254 覆盖加固：MemoryManager 写入去重/上限/无效 ID 边界', () => {
  const base = { taskId: 't-mem-254', agentId: 'a-mem-254', agentVersionId: 'v-mem-254', specContentHash: 'hash-254' };

  it('同 taskId 重复写入：不新建、不计数（independentEvidence=false）', () => {
    const h = makeHarness();
    const policy: PersistentMemoryPolicy = { type: 'persistent', writePolicy: 'task_output' };
    const output = { summary: '同任务重复输出', filesCovered: 1, verdict: 'ok' };
    const first = h.rt.memories.onSucceeded(base, output, policy);
    const second = h.rt.memories.onSucceeded(base, output, policy);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // 同 taskId：不构成独立印证
    expect(h.rt.memories.list()).toHaveLength(1);
    const evt = h.rt.trace.readEvents(base.taskId).filter((e) => e.eventType === 'memory_written').at(-1) as unknown as { dedup: boolean; independentEvidence: boolean };
    expect(evt.dedup).toBe(true);
    expect(evt.independentEvidence).toBe(false);
  });

  it('maxEntriesPerTask 上限：达限后跳过写入并留痕 skipped 原因', () => {
    const h = makeHarness();
    const policy: PersistentMemoryPolicy = { type: 'persistent', writePolicy: 'task_output', maxEntriesPerTask: 1 };
    const out1 = { summary: '第一条输出', filesCovered: 1, verdict: 'ok' };
    const out2 = { summary: '第二条输出应被上限拦截', filesCovered: 2, verdict: 'ok' };
    expect(h.rt.memories.onSucceeded(base, out1, policy)).toHaveLength(1);
    expect(h.rt.memories.onSucceeded(base, out2, policy)).toHaveLength(0); // 上限拦截
    expect(h.rt.memories.list()).toHaveLength(1);
    const events = h.rt.trace.readEvents(base.taskId).filter((e) => e.eventType === 'memory_written') as unknown as { skipped?: string; limit?: number }[];
    expect(events.some((e) => e.skipped === 'maxEntriesPerTask' && e.limit === 1)).toBe(true);
  });

  it('onFailed：注入清单中的无效 memoryId（不存在）安全跳过', () => {
    const h = makeHarness();
    const touched = h.rt.memories.onFailed(base, ['no-such-memory']);
    expect(touched).toEqual([]);
  });
});

describe('TASK-254 覆盖加固：ModelGateway Provider 错误四分类归因', () => {
  function ledger(): BudgetLedger {
    return {
      maxModelCalls: 10,
      maxTokens: 1_000_000,
      modelCallsIssued: 0,
      tokensUsed: 0,
      estimatedTokens: 0,
      attemptsSucceeded: 0,
      attemptsFailedBySubClass: {},
      account: () => {},
      breakdown: () => ({
        budget: { maxModelCalls: 10, maxTokens: 1_000_000 },
        consumed: { modelCalls: 0, tokens: 0, estimatedTokens: 0 },
        attemptBreakdown: { succeeded: 0, failedBySubClass: {} },
      }),
    };
  }

  async function subclassOfFailure(h: Harness, provider: ModelProvider): Promise<string> {
    const gw = new ModelGateway(provider, new Set(['mock-model']));
    const request: Omit<ChatRequest, 'callTimeoutMs'> = {
      modelId: 'mock-model', system: 's', messages: [{ role: 'user', text: 'hi' }], temperature: 0, maxOutputTokens: 16,
    };
    try {
      await gw.call({
        base: { taskId: 't-gw-254', agentId: 'a-gw', agentVersionId: 'v-gw', specContentHash: 'h' },
        trace: h.rt.trace,
        callNo: 1,
        ledger: ledger(),
        maxAttempts: 1,
        strategy: null,
        request,
        callTimeoutMs: 1000,
        accept: (r: ProviderResponse) => ({ ok: true as const, value: r }),
      });
      throw new Error('预期 TerminalModelFailure 未抛出');
    } catch (err) {
      if (err instanceof TerminalModelFailure) return err.subClass;
      throw err;
    }
  }

  const throwingProvider = (err: unknown): ModelProvider => ({
    name: 'throwing',
    chat: async () => { throw err; },
  });

  it('call_timeout：归因 Model(call_timeout)', async () => {
    const h = makeHarness();
    const sub = await subclassOfFailure(h, throwingProvider(new ProviderError('调用超时（1000ms）', 'call_timeout', false)));
    expect(sub).toBe('call_timeout');
  });

  it('schemaRejected：归因 Model(provider_rejected_schema)', async () => {
    const h = makeHarness();
    const sub = await subclassOfFailure(h, throwingProvider(new ProviderError('Provider 拒绝该 Schema', 'schema_rejected', false, true)));
    expect(sub).toBe('provider_rejected_schema');
  });

  it('非重试 ProviderError：归因 Model(provider_error)', async () => {
    const h = makeHarness();
    const sub = await subclassOfFailure(h, throwingProvider(new ProviderError('HTTP 401', 'http_401', false)));
    expect(sub).toBe('provider_error');
  });

  it('非 ProviderError 异常：兜底归因 Model(provider_error)/unknown', async () => {
    const h = makeHarness();
    const sub = await subclassOfFailure(h, throwingProvider(new Error('意外崩溃')));
    expect(sub).toBe('provider_error');
  });
});
