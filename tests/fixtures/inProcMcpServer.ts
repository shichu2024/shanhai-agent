// WP-4B 批次一测试夹具：进程内 in-proc MCP server（§14.2-2——防 Windows 进程启停抖动，主夹具形态）。
// 实现 initialize / notifications/initialized / tools/list / tools/call 四方法最小 JSON-RPC server 语义，
// 供 InProcMcpTransport 直接消费（handler 形态，无子进程）。

export interface FixtureToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  behavior?: 'echo' | 'fail';
}

export const FIXTURE_TOOLS: FixtureToolDef[] = [
  {
    name: 'echo',
    description: '回显参数',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', minLength: 1 },
        days: { type: 'number', minimum: 1, maximum: 7 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
      required: ['city'],
      additionalProperties: false,
    },
  },
  {
    name: 'fail',
    description: '总是失败',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    behavior: 'fail',
  },
];

/** 通用 in-proc handler：按 tools 定义应答；未识别请求 → JSON-RPC method not found 错误响应 */
export function inProcMcpHandler(tools: FixtureToolDef[]): (msg: unknown) => Promise<unknown> {
  return async (msg: unknown): Promise<unknown> => {
    const req = msg as { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-inproc', version: '9.9.9' },
        },
      };
    }
    if (typeof req.method === 'string' && req.method.startsWith('notifications/')) return null; // 通知无响应
    if (req.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        },
      };
    }
    if (req.method === 'tools/call') {
      const name = (req.params?.name ?? '') as string;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `未知工具 ${name}` } };
      }
      if (tool.behavior === 'fail') {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: 'fixture 故意失败' }], isError: true },
        };
      }
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] },
      };
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
  };
}
