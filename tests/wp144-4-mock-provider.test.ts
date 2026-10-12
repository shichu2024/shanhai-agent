import { describe, expect, it } from 'vitest';
import { MockProvider, type MockScript } from '../src/providers/mock.js';
import { ProviderError, type ChatRequest } from '../src/providers/types.js';

// TASK-144 第十批：MockProvider 脚本引擎全路径补强（基线 82.75% 行）。
// 未覆盖段 → 用例映射：26-27（脚本耗尽）/ 34-36（timeout 步）+ delay/error/usage·finishReason 缺省分支。

const baseReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  modelId: 'mock-model',
  system: 's',
  messages: [{ role: 'user', text: 'x' }],
  temperature: 0,
  maxOutputTokens: 64,
  callTimeoutMs: 1000,
  ...over,
});

describe('MockProvider 脚本引擎', () => {
  it('text 步：缺省 finishReason=end_turn、usage=null；显式值透传', async () => {
    const p = new MockProvider([
      { kind: 'text', text: 'ok1' },
      { kind: 'text', text: 'ok2', finishReason: 'end_turn_explicit', usage: { inputTokens: 3, outputTokens: 5 } },
    ]);
    const r1 = await p.chat(baseReq());
    expect(r1).toMatchObject({ kind: 'text', text: 'ok1', finishReason: 'end_turn', usage: null });
    const r2 = await p.chat(baseReq());
    expect(r2).toMatchObject({ kind: 'text', text: 'ok2', finishReason: 'end_turn_explicit', usage: { inputTokens: 3, outputTokens: 5 } });
    expect(p.receivedCalls).toHaveLength(2); // 请求面逐次留痕
  });

  it('tool_use 步：缺省 usage=null；显式 usage 透传', async () => {
    const p = new MockProvider([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'docs-list', args: {} }] },
      { kind: 'tool_use', calls: [], usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    const r1 = await p.chat(baseReq());
    expect(r1).toMatchObject({ kind: 'tool_use', usage: null, finishReason: 'tool_use' });
    const r2 = await p.chat(baseReq());
    expect(r2).toMatchObject({ kind: 'tool_use', usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it('error 步：原样抛出 ProviderError（code/retryable 保真）', async () => {
    const p = new MockProvider([{ kind: 'error', error: new ProviderError('模拟 429', 'rate_limited', true) }]);
    await expect(p.chat(baseReq())).rejects.toMatchObject({ name: 'ProviderError', code: 'rate_limited', retryable: true });
  });

  it('delay 步：等待后消费下一步（可观测等待窗口）', async () => {
    const p = new MockProvider([{ kind: 'delay', ms: 30 }, { kind: 'text', text: 'after-delay' }]);
    const startedAt = Date.now();
    const r = await p.chat(baseReq());
    expect(r).toMatchObject({ kind: 'text', text: 'after-delay' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25); // 等待窗口成立（宽容边界）
  });

  it('timeout 步：等待 callTimeoutMs+20 后抛 call_timeout（34-36）', async () => {
    const p = new MockProvider([{ kind: 'timeout' }]);
    const startedAt = Date.now();
    await expect(p.chat(baseReq({ callTimeoutMs: 10 }))).rejects.toMatchObject({ name: 'ProviderError', code: 'call_timeout' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25); // 10ms + 20ms
  });

  it('脚本耗尽 → mock_exhausted（26-27，不可重试）', async () => {
    const script: MockScript = [{ kind: 'text', text: '仅一步' }];
    const p = new MockProvider(script);
    await p.chat(baseReq());
    await expect(p.chat(baseReq())).rejects.toMatchObject({ name: 'ProviderError', code: 'mock_exhausted', retryable: false });
    expect(p.receivedCalls).toHaveLength(2); // 第二次请求已入留痕（消费点先于判空）
  });
});
