import { ProviderError, type ChatRequest, type ModelProvider, type ProviderResponse } from './types.js';

// 测试用 Mock Provider：脚本化响应序列（确定性截停 C3-②、policy_denied C3-③ 等用例依赖此确定性）
export type MockScript = (
  | { kind: 'text'; text: string; usage?: { inputTokens: number; outputTokens: number }; finishReason?: string }
  | { kind: 'tool_use'; calls: { id: string; toolId: string; args: unknown }[]; usage?: { inputTokens: number; outputTokens: number } }
  | { kind: 'error'; error: ProviderError }
  | { kind: 'timeout' }
  | { kind: 'delay'; ms: number } // 取消语义用例：制造可观测的原子调用窗口
)[];

export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  private calls: ChatRequest[] = [];

  constructor(private script: MockScript) {}

  get receivedCalls(): readonly ChatRequest[] {
    return this.calls;
  }

  async chat(req: ChatRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const step = this.script.shift();
    if (!step) {
      throw new ProviderError('Mock 脚本耗尽', 'mock_exhausted', false);
    }
    if (step.kind === 'error') throw step.error;
    if (step.kind === 'delay') {
      await new Promise((r) => setTimeout(r, step.ms));
      return this.chat(req); // 延迟后消费下一步
    }
    if (step.kind === 'timeout') {
      await new Promise((r) => setTimeout(r, req.callTimeoutMs + 20));
      throw new ProviderError(`调用超时（${req.callTimeoutMs}ms）`, 'call_timeout', false);
    }
    if (step.kind === 'text') {
      return { kind: 'text', text: step.text, finishReason: step.finishReason ?? 'end_turn', usage: step.usage ?? null };
    }
    return { kind: 'tool_use', calls: step.calls, finishReason: 'tool_use', usage: step.usage ?? null };
  }
}
