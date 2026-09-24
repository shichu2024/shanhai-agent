import type Database from 'better-sqlite3';
import { McpClient, stdioTransportFactory, type McpServerConfig, type McpTransport } from './client.js';

// 第四阶段 §4.2-3 调用桥：ToolExecutor `impls` Miss 且 kind=external → MCP client tools/call。
// attempt/timeout 语义由 ToolExecutor 既有循环承载（toolTimeoutMs / maxAttempts / Tool 子类归因
// 原样适用——A-14 同构断言）；server 按需 spawn（首次调用启动、进程内复用、close 释放——无常驻后台进程）；
// 断连/不可达 → 抛错走既有重试与终局语义（F-10-①：不静默跳过、不缓存结果）。

export interface McpBridgeDeps {
  db: Database.Database;
  servers: Record<string, McpServerConfig>;
  transportFactory?: (name: string, cfg: McpServerConfig) => McpTransport;
}

export class McpToolBridge {
  private readonly db: Database.Database;
  private readonly servers: Record<string, McpServerConfig>;

  constructor(deps: McpBridgeDeps) {
    this.db = deps.db;
    this.servers = deps.servers;
    this.transportFactory = deps.transportFactory;
  }

  private readonly transportFactory?: (name: string, cfg: McpServerConfig) => McpTransport;
  private clients = new Map<string, McpClient>();

  /** 调用桥入口：external 工具分派（toolId → source=mcp:<server> → tools/call） */
  async call(toolId: string, args: Record<string, unknown>): Promise<unknown> {
    const row = this.db.prepare('SELECT kind, source FROM tool_registry WHERE toolId = ?').get(toolId) as
      | { kind: string; source: string | null }
      | undefined;
    if (!row || row.kind !== 'external') {
      throw new Error(`工具 ${toolId} 非 external 登记或不存在——MCP 调用桥只分派 kind=external（§4.2-3）`);
    }
    const serverName = row.source?.startsWith('mcp:') ? row.source.slice('mcp:'.length) : null;
    if (!serverName) {
      throw new Error(`external 工具 ${toolId} 的 source 非 mcp:<server> 形态（收到 ${row.source ?? 'NULL'}）`);
    }
    const client = await this.clientFor(serverName);
    const result = await client.callTool(mcpToolName(serverName, toolId), args);
    if (result.isError) {
      // F-10-②：返回 isError → Tool(execution_failed)（message 走既有管道）
      throw new Error(`MCP 工具 ${toolId} 返回错误：${joinText(result.content).slice(0, 200)}`);
    }
    return { content: joinText(result.content) }; // 结果标准化（§4.2-4）：拼接文本载荷
  }

  private async clientFor(serverName: string): Promise<McpClient> {
    const existing = this.clients.get(serverName);
    if (existing) return existing;
    const cfg = this.servers[serverName];
    if (!cfg) {
      throw new Error(`server「${serverName}」未在 mcpServers 配置（工具登记于 ${Object.keys(this.servers).join(', ') || '无配置'}）`);
    }
    const transport = this.transportFactory ? this.transportFactory(serverName, cfg) : stdioTransportFactory(cfg);
    const client = await McpClient.connect(transport);
    this.clients.set(serverName, client);
    return client;
  }

  async close(): Promise<void> {
    for (const [, client] of this.clients) await client.close();
    this.clients.clear();
  }
}

function mcpToolName(serverName: string, toolId: string): string {
  return toolId.slice(serverName.length + 1); // toolId = `<serverName>-<mcpName>`
}

function joinText(content: { type: string; text?: string }[]): string {
  return content.filter((p) => typeof p.text === 'string').map((p) => p.text as string).join('\n');
}
