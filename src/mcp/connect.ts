import type { Registry } from '../modules/registry.js';
import type { RiskLevel } from '../types.js';
import { McpClient, stdioTransportFactory, type McpServerConfig, type McpToolInfo, type McpTransport } from './client.js';

// 第四阶段 §4.2 接入流水线（F-8）：读配置 → 连接（initialize）→ tools/list 发现 →
// 确认清单（缺省勾选 L3；--yes = 全部按缺省；P3-1）→ Schema 转换（受控字段候选 = 编写建议 +
// 自动生成 Spec 声明片段，P1-3：执行面以 Spec 声明为唯一真源）→ 批量登记 → 断连退出。
// 留痕落点 = 审计载荷（registeredBy + 评级），非交互过程本身（P3-1/P3-3）。

/** toolId 命名规则：`<serverName>-<mcpToolName>`（跨 server 不冲突、可追溯）。
 * 字符集受既有 Spec toolId 校验约束（^[a-z][a-z0-9-]{1,63}$，A1 §4——不做 Spec 面变更），
 * connect 侧对生成结果 fail-fast 校验，提示操作者用合规 server/工具名。 */
const SPEC_TOOL_ID = /^[a-z][a-z0-9-]{1,63}$/;

export function toolIdOf(serverName: string, mcpName: string): string {
  return `${serverName}-${mcpName}`;
}

export interface ToolCandidate {
  toolId: string;
  mcpName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  defaultLevel: 'L3';
  readOnlyHint: boolean;
  /** 受控字段候选（编写建议，非执行面——P1-3）：MCP maximum/minimum 机械转译 paramRanges */
  paramRanges: Record<string, { min?: number; max?: number }>;
  /** enum 无法映射 paramRanges → 提示 agent 作者在 Spec 声明中自行表达 */
  enumNotes: string[];
}

export interface RegistrationOutcome {
  toolId: string;
  riskLevel: RiskLevel;
  registered: true;
}

export interface ConnectResult {
  serverName: string;
  serverInfo: { name?: string; version?: string };
  /** spawn+initialize 往返计时（健康检查并入 connect，V0.2 修剪） */
  spawnMs: number;
  /** tools/list 往返计时 */
  listMs: number;
  candidates: ToolCandidate[];
  registrations: RegistrationOutcome[];
  aborted: boolean;
  /** 自动生成的 Spec 声明片段（tools 数组 JSON，agent 作者直接复制——P1-3 搬运通道） */
  specSnippet: string;
}

export type ConfirmFn = (
  candidates: ToolCandidate[],
) => Promise<Record<string, RiskLevel> | null> | Record<string, RiskLevel> | null;

const VALID_LEVELS: RiskLevel[] = ['L0', 'L1', 'L2', 'L3'];

export interface McpConnectDeps {
  registry: Registry;
  servers: Record<string, McpServerConfig>;
  who: string;
  transportFactory?: (name: string, cfg: McpServerConfig) => McpTransport;
}

/** Schema 转换（§4.2-2）：inputSchema 原样转 paramSchema + min/max 机械转译受控字段候选 */
function convertSchema(tool: McpToolInfo): Pick<ToolCandidate, 'paramRanges' | 'enumNotes'> {
  const paramRanges: Record<string, { min?: number; max?: number }> = {};
  const enumNotes: string[] = [];
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [param, schema] of Object.entries(props)) {
    const min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
    const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
    if (min !== undefined || max !== undefined) paramRanges[param] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    if (Array.isArray(schema.enum)) enumNotes.push(param);
  }
  return { paramRanges, enumNotes };
}

export async function connectMcpServer(
  deps: McpConnectDeps,
  serverName: string,
  opts: { yes?: boolean; confirm?: ConfirmFn } = {},
): Promise<ConnectResult> {
  const cfg = deps.servers[serverName];
  if (!cfg) {
    throw new Error(`mcpServers 配置中不存在 server「${serverName}」（可用：${Object.keys(deps.servers).join(', ') || '无'}）`);
  }
  if (!opts.yes && !opts.confirm) {
    throw new Error(`非交互环境（测试/CI）必须使用 --yes（全部按缺省 L3 登记）或注入确认回调（P3-1）`);
  }

  const transport = deps.transportFactory ? deps.transportFactory(serverName, cfg) : stdioTransportFactory(cfg);
  const spawnStartedAt = Date.now();
  const client = await McpClient.connect(transport);
  const spawnMs = Date.now() - spawnStartedAt;
  try {
    const listStartedAt = Date.now();
    const tools = await client.listTools();
    const listMs = Date.now() - listStartedAt;

    const candidates: ToolCandidate[] = tools.map((t) => ({
      toolId: toolIdOf(serverName, t.name),
      mcpName: t.name,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      defaultLevel: 'L3',
      readOnlyHint: t.annotations?.readOnlyHint === true,
      ...convertSchema(t),
    }));
    // 生成 toolId 必须能进 Spec 声明（受控字段执行面 = Spec，P1-3）——不合规即 fail-fast
    const invalid = candidates.filter((c) => !SPEC_TOOL_ID.test(c.toolId));
    if (invalid.length > 0) {
      throw new Error(`生成 toolId 不符合 Spec 声明字符集（^[a-z][a-z0-9-]{1,63}$）：${invalid.map((c) => c.toolId).join(', ')}——请调整 server 名或联系 server 作者改名`);
    }

    let levels: Record<string, RiskLevel> | null;
    if (opts.confirm) {
      levels = await opts.confirm(candidates);
    } else {
      levels = Object.fromEntries(candidates.map((c) => [c.toolId, c.defaultLevel as RiskLevel])); // --yes：缺省 L3
    }
    if (levels === null) {
      await client.close();
      return { serverName, serverInfo: { ...client.serverInfo }, spawnMs, listMs, candidates, registrations: [], aborted: true, specSnippet: '[]' };
    }

    const byToolId = new Map(candidates.map((c) => [c.toolId, c]));
    const chosen = [...Object.entries(levels)].filter(([toolId]) => byToolId.has(toolId));
    const registrations: RegistrationOutcome[] = [];
    const implVersion = `mcp-${client.serverInfo.version ?? 'unknown'}`;
    for (const [toolId, level] of chosen) {
      if (!(VALID_LEVELS as string[]).includes(level)) {
        throw new Error(`工具 ${toolId} 评级 ${level} 非法：L4 永禁登记、仅接受 L0-L3（D-27 缺省保守 + D-8 外推）`);
      }
      const cand = byToolId.get(toolId)!;
      deps.registry.registerTool(
        {
          toolId,
          name: cand.description || cand.name,
          kind: 'external',
          riskLevel: level,
          implVersion,
          paramSchema: JSON.stringify(cand.inputSchema),
          controlledFieldsSchema: Object.keys(cand.paramRanges).length > 0 ? JSON.stringify({ paramRanges: cand.paramRanges }) : null,
          status: 'active',
          source: `mcp:${serverName}`,
          registeredBy: deps.who,
          description: cand.description,
        },
        deps.who,
      );
      registrations.push({ toolId, riskLevel: level, registered: true });
    }

    const specSnippet = JSON.stringify(
      registrations.map((r) => {
        const cand = byToolId.get(r.toolId)!;
        return {
          toolId: r.toolId,
          riskLevel: r.riskLevel,
          ...(Object.keys(cand.paramRanges).length > 0 ? { controlledFields: { paramRanges: cand.paramRanges } } : {}),
        };
      }),
      null,
      2,
    );
    return { serverName, serverInfo: { ...client.serverInfo }, spawnMs, listMs, candidates, registrations, aborted: false, specSnippet };
  } finally {
    await client.close(); // 登记完断连退出（按需 spawn，无常驻进程）
  }
}
