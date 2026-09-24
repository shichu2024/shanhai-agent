import type Database from 'better-sqlite3';
import { McpClient, stdioTransportFactory, type McpServerConfig, type McpTransport } from './client.js';

// 第四阶段 §4.2-3 调用桥：ToolExecutor `impls` Miss 且 kind=external → MCP client tools/call。
// attempt/timeout 语义由 ToolExecutor 既有循环承载（toolTimeoutMs / maxAttempts / Tool 子类归因
// 原样适用——A-14 同构断言）；server 按需 spawn（首次调用启动、进程内复用、close 释放——无常驻后台进程）；
// 断连/不可达 → 抛错走既有重试与终局语义（F-10-①：不静默跳过、不缓存结果）。
//
// §4.3-4（批次二，D-34）结果注入防护最小对策：MCP 结果进模型上下文前包裹显式边界标记
// `<tool-result source="mcp:<server>">…</tool-result>`（缩小攻击面，非消除——诚实标注）；
// F-10-④ 超长截断：拼接文本超过配置上限即截断 + 载荷标注 truncated（预算保护，截断后标记仍闭合）。

/** D-34 边界标记（模型可见；与 D-13 记忆注入防护同款最小对策——system prompt 固定声明配套，见 executor） */
export function wrapToolResult(source: string, text: string): string {
  return `<tool-result source="${source}">${text}</tool-result>`;
}

/** 截断上限缺省（配置面 mcp.resultMaxChars 可覆盖；F-10-④ 预算保护） */
export const DEFAULT_MCP_RESULT_MAX_CHARS = 20000;

export interface McpBridgeDeps {
  db: Database.Database;
  servers: Record<string, McpServerConfig>;
  transportFactory?: (name: string, cfg: McpServerConfig) => McpTransport;
  /** §4.3-4 / F-10-④：单次调用结果拼接文本的字符上限（缺省 20000；超限截断 + truncated 标注） */
  resultMaxChars?: number;
}

export interface McpBridgeResult {
  content: string;
  /** F-10-④：结果发生截断时标注 true（载荷可观测） */
  truncated?: boolean;
}

export class McpToolBridge {
  private readonly db: Database.Database;
  private readonly servers: Record<string, McpServerConfig>;
  private readonly resultMaxChars: number;

  constructor(deps: McpBridgeDeps) {
    this.db = deps.db;
    this.servers = deps.servers;
    this.transportFactory = deps.transportFactory;
    this.resultMaxChars = deps.resultMaxChars ?? DEFAULT_MCP_RESULT_MAX_CHARS;
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
    // 结果标准化（§4.2-4）+ D-34 边界标记 + F-10-④ 超长截断
    const source = `mcp:${serverName}`;
    let text = joinText(result.content);
    if (text.length > this.resultMaxChars) {
      text = text.slice(0, this.resultMaxChars);
      return { content: wrapToolResult(source, text), truncated: true };
    }
    return { content: wrapToolResult(source, text) };
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
