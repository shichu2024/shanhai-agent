import { ProviderError, type ChatMessage, type ChatRequest, type ModelProvider, type ProviderResponse } from './types.js';

// Anthropic 兼容 /v1/messages 适配器。密钥与端点一律经配置注入（T3：仓库不留模型与密钥）。
// 策略 A（native structured output）以强制工具调用承载：output 契约 → emit_output 工具的 input_schema。

export interface AnthropicConfig {
  baseUrl: string;
  authToken: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  constructor(private readonly config: AnthropicConfig) {}

  async chat(req: ChatRequest): Promise<ProviderResponse> {
    const body = this.buildBody(req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.callTimeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.authToken,
          authorization: `Bearer ${this.config.authToken}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError(`调用超时（${req.callTimeoutMs}ms）`, 'call_timeout', false);
      }
      throw new ProviderError(`网络错误：${(err as Error).message}`, 'network_error', true);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      const schemaRejected =
        res.status === 400 && /schema|tool|input_schema|json/i.test(text.slice(0, 2000));
      throw new ProviderError(`Provider HTTP ${res.status}: ${text.slice(0, 500)}`, `http_${res.status}`, retryable, schemaRejected);
    }

    const data = (await res.json()) as {
      content: AnthropicContentBlock[];
      stop_reason: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const usage = data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : null;

    const toolCalls = data.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id ?? '', toolId: b.name ?? '', args: b.input ?? {} }));
    if (toolCalls.length > 0) {
      // 策略 A：强制输出工具的 tool_use 归一化为文本响应，交由网关 accept() 做契约判定与 attempt 重试
      if (req.forceTool && toolCalls.every((c) => c.toolId === req.forceTool)) {
        const forced = toolCalls.find((c) => c.toolId === req.forceTool)!;
        return { kind: 'text', text: JSON.stringify(forced.args), finishReason: data.stop_reason, usage };
      }
      return { kind: 'tool_use', calls: toolCalls, finishReason: data.stop_reason, usage };
    }
    const text = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return { kind: 'text', text, finishReason: data.stop_reason, usage };
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.modelId,
      max_tokens: req.maxOutputTokens,
      temperature: req.temperature,
      system: req.system,
      messages: req.messages.map((m) => this.convertMessage(m)),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
      if (req.forceTool) {
        body.tool_choice = { type: 'tool', name: req.forceTool };
      }
    }
    return body;
  }

  private convertMessage(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'user') {
      return { role: 'user', content: [{ type: 'text', text: m.text }] };
    }
    if (m.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.toolId, input: c.args });
      }
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
      })),
    };
  }
}
