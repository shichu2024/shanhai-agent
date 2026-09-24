import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// 第四阶段 §4.2（D-28 退路形态）：MCP stdio client 最小子集——自实现 JSON-RPC over stdio
// （ndjson 帧），仅 initialize / tools/list / tools/call 三方法。
// 依赖探针结论（2026-09-25）：官方 @modelcontextprotocol/sdk 1.30.1（MIT）传递依赖 17 项
// （express / express-rate-limit / cors / hono / jose / eventsource / ajv…），web 服务面
// 与 stdio client 子集无关，依赖面不可接受 → 按 D-28 既定退路自实现。

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpContentPart {
  type: string;
  text?: string;
}

export interface McpCallResult {
  content: McpContentPart[];
  isError?: boolean;
}

/** server initialize 应答的身份信息（implVersion 派生锚点） */
export interface McpServerInfo {
  name?: string;
  version?: string;
}

/** 传输抽象：stdio 子进程与进程内 in-proc（测试夹具主形态，§14.2-2）同一接口 */
export interface McpTransport {
  send(message: object): void;
  onMessage(handler: (msg: unknown) => void): void;
  /** P1-1 修复（裁决选项 A）：连接级错误（spawn 失败 / 意外退出）专用通道——client 直接
   * reject 全部 pending 请求，不伪造 id:null 消息走消息分发。in-proc 夹具无连接级失败场景，可不实现。 */
  onError?(handler: (err: Error) => void): void;
  close(): Promise<void>;
}

/** mcpServers 配置段（§4.2：首期 stdio；http/sse 字段位预留本期拒绝） */
export interface McpServerConfig {
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  /** D-29：凭据唯一通道 = 环境变量引用占位（${VAR}），值永不落任何落盘面 */
  envRefs?: Record<string, string>;
}

/**
 * envRefs 解析（spawn 时注入）：值必须是 ${VAR} 占位形态，否则 fail-fast；
 * 环境变量缺失同样 fail-fast——不降级、不留明文通道。
 */
export function resolveEnvRefs(envRefs: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, ref] of Object.entries(envRefs)) {
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref);
    if (!m) {
      throw new Error(`envRefs.${key} 值必须为 \${VAR} 环境变量引用形态（收到：非占位值；D-29 凭据策略——值永不落配置/库/Trace）`);
    }
    const value = env[m[1]];
    if (value === undefined || value === '') {
      throw new Error(`envRefs.${key} 引用的环境变量 ${m[1]} 缺失（spawn 前置校验 fail-fast）`);
    }
    resolved[key] = value;
  }
  return resolved;
}

/** stdio transport 工厂：校验 transport 字段位与 command 完整性 */
export function stdioTransportFactory(cfg: McpServerConfig): StdioMcpTransport {
  const transport = cfg.transport ?? 'stdio';
  if (transport !== 'stdio') {
    throw new Error(`mcpServers.transport=${transport} 本期仅实现 stdio（http/sse 为字段位预留，§4.2）`);
  }
  if (!cfg.command) {
    throw new Error('mcpServers 配置不完整：stdio transport 需要 command（§4.2 配置段）');
  }
  const env = cfg.envRefs ? { ...process.env, ...resolveEnvRefs(cfg.envRefs, process.env) } : process.env;
  return new StdioMcpTransport(cfg.command, cfg.args ?? [], env);
}

/** 真实子进程 stdio transport（ndjson JSON-RPC；stderr 继承——server 错误不静默） */
export class StdioMcpTransport implements McpTransport {
  private child: ChildProcess;
  private listener: ((msg: unknown) => void) | null = null;
  private errorListener: ((err: Error) => void) | null = null;
  private closed = false;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
    // P1-1 修复（裁决选项 A）：spawn 失败（如 ENOENT——command 打错）与意外退出（未经 close()，
    // 如 server 启动即崩溃/中途死亡）走连接级错误通道 reject client 全部 pending——快速结构化失败，
    // 不伪造 id:null 消息走分发通道（分发通道忽略无 id 消息 = 错误信号被吞 = 永久挂死）
    this.child.on('error', (err) =>
      this.errorListener?.(new Error(`MCP server spawn 失败：${err?.message ?? '未知错误'}`)));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.errorListener?.(new Error(`MCP server 意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}，未经 close()——请求不可达`));
      }
    });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '' || this.closed) return;
      try {
        this.listener?.(JSON.parse(trimmed));
      } catch { /* 非 JSON 行忽略（server 杂散输出） */ }
    });
  }

  send(message: object): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.listener = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorListener = handler;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.child.on('exit', () => resolve());
      this.child.stdin?.end();
      const killTimer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 3000);
      killTimer.unref();
    });
  }
}

/** 进程内 transport（测试夹具主形态：handler 直接应答，无子进程——防 Windows 进程启停抖动） */
export class InProcMcpTransport implements McpTransport {
  private listener: ((msg: unknown) => void) | null = null;

  constructor(private readonly handler: (msg: unknown) => Promise<unknown>) {}

  send(message: object): void {
    void (async () => {
      let response: unknown;
      try {
        response = await this.handler(message);
      } catch (err) {
        const req = message as { id?: number | string | null };
        response = { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32603, message: (err as Error).message } };
      }
      if (response !== null && response !== undefined) this.listener?.(response);
    })();
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.listener = handler;
  }

  async close(): Promise<void> {
    this.listener = null;
  }
}

interface JsonRpcError {
  code: number;
  message: string;
}

/** 最小 MCP client：initialize 握手 + tools/list + tools/call */
export class McpClient {
  readonly serverInfo: McpServerInfo = {};
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private transport: McpTransport | null = null;

  static async connect(transport: McpTransport, opts: { clientName?: string; clientVersion?: string } = {}): Promise<McpClient> {
    const client = new McpClient();
    client.attach(transport);
    const init = (await client.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: opts.clientName ?? 'shanhai-runtime', version: opts.clientVersion ?? '0.1.0' },
    })) as { serverInfo?: McpServerInfo };
    if (init.serverInfo) {
      client.serverInfo.name = init.serverInfo.name;
      client.serverInfo.version = init.serverInfo.version;
    }
    transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return client;
  }

  attach(transport: McpTransport): void {
    this.transport = transport;
    // P1-1 修复：连接级错误 → reject 全部 pending（快速结构化失败，不静默挂起）
    transport.onError?.((err) => {
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
    });
    transport.onMessage((msg) => {
      const resp = msg as { id?: number | string | null; result?: unknown; error?: JsonRpcError };
      if (resp.id === null || resp.id === undefined) return; // 通知/请求（server→client）本期不处理
      const waiter = this.pending.get(Number(resp.id));
      if (!waiter) return; // 未知 id（重复/迟到响应）忽略
      this.pending.delete(Number(resp.id));
      if (resp.error) waiter.reject(new Error(`MCP ${resp.error.code}: ${resp.error.message}`));
      else waiter.resolve(resp.result);
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.transport) throw new Error('MCP client 未连接（transport 缺失）');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport!.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request('tools/list')) as { tools?: McpToolInfo[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return (await this.request('tools/call', { name, arguments: args })) as McpCallResult;
  }

  async close(): Promise<void> {
    for (const [, waiter] of this.pending) waiter.reject(new Error('MCP client 已关闭'));
    this.pending.clear();
    await this.transport?.close();
    this.transport = null;
  }
}
