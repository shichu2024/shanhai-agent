// Provider 适配器统一契约（A2 §6 交集子集的运行时载体）
export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolCalls?: { id: string; toolId: string; args: unknown }[] }
  | { role: 'tool_results'; results: { id: string; toolId: string; content: unknown }[] };

export interface ChatRequest {
  modelId: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDeclaration[];
  forceTool?: string | null; // 策略 A（native）：强制结构化输出工具
  temperature: number;
  maxOutputTokens: number;
  callTimeoutMs: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderResponse =
  | { kind: 'text'; text: string; finishReason: string | null; usage: ProviderUsage | null }
  | { kind: 'tool_use'; calls: { id: string; toolId: string; args: unknown }[]; finishReason: string | null; usage: ProviderUsage | null };

/** Provider 侧错误。retryable 指示 infra 类（限流/网络/5xx）；schemaRejected 指示 Schema 被 Provider 拒绝（A4 provider_rejected_schema） */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly schemaRejected: boolean = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ModelProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ProviderResponse>;
}
