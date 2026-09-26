import { existsSync, readFileSync } from 'node:fs';
import { AnthropicProvider } from './providers/anthropic.js';
import type { ModelProvider } from './providers/types.js';
import { defaultRedactionPolicy, type RedactionPolicy } from './modules/redaction.js';

// T3 发布安全（A5 §4）：仓库只留 config.example 模板；密钥一律环境变量注入；
// ModelGateway 无配置即拒绝启动（fail-fast，不降级运行）。
// v1.1（A6 §8，D-11）：redactionPolicy 为运行时配置（平台层，不进 Spec）；缺省 = 默认规则集。

export interface RuntimeConfig {
  provider: {
    name: string;
    baseUrl: string;
    authToken: string;
    models: string[]; // 运行时模型白名单（注册准入 ⊆ 校验依据）
  };
  redaction: RedactionPolicy; // 管道不可削（空规则集仍过管道）；规则集内容可裁
  /** 批次三（§4.5-4，D-25）：演进治理运行时配置（平台层，不进 Spec） */
  evolution?: { dismissCooldownDays?: number }; // dismiss 冷却窗天数；缺省 7
  /** 第四阶段批次一（§4.2）：MCP server 配置段（平台层；首期 stdio，http/sse 字段位预留） */
  mcpServers?: Record<string, import('./mcp/client.js').McpServerConfig>;
  /** 第四阶段批次二（§4.3-4 / F-10-④）：MCP 结果超长截断上限（字符；缺省 20000） */
  mcp?: { resultMaxChars?: number };
  /** 第六阶段批次一（§4.1 / D-49）：山海门户可选节——缺省禁用（不启动、不影响任何既有行为）；非法值 fail-fast */
  portal?: { host?: string; port?: number; operatorId?: string; token?: string };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 配置解析：config 文件承载非秘密部分（baseUrl、白名单），密钥仅从环境变量读取。
 * 查找次序：SHANHAI_CONFIG 环境变量指定的路径 → ./config.local.json（唯一回退；D-26：config.json 回退从未生效，退化三元已删）。
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const configPath = env.SHANHAI_CONFIG ?? 'config.local.json';
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `未找到配置文件（${configPath}）。T3 发布安全规则：无配置即拒绝启动——请复制 config.example.json 为 config.local.json 并通过环境变量注入密钥。`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
    providers?: Record<string, { baseUrl?: string; authTokenEnv?: string; models?: string[] }>;
    redaction?: { rules?: { ruleId?: string; pattern?: string; scope?: string }[] }; // scope 为已删除装饰字段：该字段被忽略（§4.7-1，条目本身仍被接受）
    evolution?: { dismissCooldownDays?: number };
    mcpServers?: Record<string, { transport?: string; command?: string; args?: string[]; envRefs?: Record<string, string> }>;
    mcp?: { resultMaxChars?: number };
    portal?: { host?: string; port?: number; operatorId?: string; token?: string };
  };
  const anthropic = raw.providers?.anthropic;
  if (!anthropic?.baseUrl) {
    throw new ConfigError('配置不完整：providers.anthropic.baseUrl 缺失（ModelGateway 无配置即拒绝启动，A5 §4-2）');
  }
  const token = anthropic.authTokenEnv ? env[anthropic.authTokenEnv] : undefined;
  if (!token) {
    throw new ConfigError(
      `配置不完整：环境变量 ${anthropic.authTokenEnv ?? '(authTokenEnv 未配置)'} 缺失（T3：密钥仅环境变量注入，仓库/发布物只留占位）`,
    );
  }
  if (!anthropic.models || anthropic.models.length === 0) {
    throw new ConfigError('配置不完整：providers.anthropic.models 白名单为空（A5 §4-2 fail-fast）');
  }
  const redaction: RedactionPolicy = raw.redaction?.rules
    ? {
        // §4.7-1（批次四）：scope 装饰字段删除后不再校验——无 scope 的规则被接受（存量兼容），已写 scope 的条目中该字段被忽略（条目仍被接受）
        rules: raw.redaction.rules
          .filter((r): r is { ruleId: string; pattern: string } => typeof r.ruleId === 'string' && typeof r.pattern === 'string')
          .map((r) => ({ ruleId: r.ruleId, pattern: r.pattern })),
      }
    : defaultRedactionPolicy();
  return {
    provider: { name: 'anthropic', baseUrl: anthropic.baseUrl, authToken: token, models: anthropic.models },
    redaction,
    evolution:
      raw.evolution?.dismissCooldownDays !== undefined &&
      Number.isFinite(raw.evolution.dismissCooldownDays) &&
      raw.evolution.dismissCooldownDays >= 0
        ? { dismissCooldownDays: raw.evolution.dismissCooldownDays }
        : undefined,
    mcpServers: parseMcpServers(raw.mcpServers),
    mcp: parseMcpSection(raw.mcp),
    portal: parsePortalSection(raw.portal),
  };
}

/** 第六阶段批次一（§4.1 / D-49）：portal 节解析——可选节缺省禁用；非法值 fail-fast（对齐 parseMcpSection 先例）；
 *  零迁移（纯运行时配置，无数据面变更）。 */
function parsePortalSection(
  section: { host?: string; port?: number; operatorId?: string; token?: string } | undefined,
): { host?: string; port?: number; operatorId?: string; token?: string } | undefined {
  if (!section || Object.keys(section).length === 0) return undefined;
  if (section.port !== undefined) {
    const v = section.port;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 65535) {
      throw new ConfigError(
        `配置非法：portal.port 必须为 1-65535 的整数（收到：${typeof v === 'number' ? String(v) : typeof v}）——fail-fast 拒绝启动（D-49）`,
      );
    }
  }
  for (const key of ['host', 'operatorId', 'token'] as const) {
    const v = section[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0) {
      throw new ConfigError(`配置非法：portal.${key} 必须为非空字符串（收到类型：${typeof v}）——fail-fast 拒绝启动（D-49）`);
    }
  }
  return {
    ...(section.host !== undefined ? { host: section.host } : {}),
    ...(section.port !== undefined ? { port: section.port } : {}),
    ...(section.operatorId !== undefined ? { operatorId: section.operatorId } : {}),
    ...(section.token !== undefined ? { token: section.token } : {}),
  };
}

/** 批次四（P3-2 随批携带）：mcp.resultMaxChars 非法值（≤0 / 非数字）fail-fast 结构化报错——
 *  与 D-29 envRefs 解析 fail-fast 语义对齐（原批次二为静默回退缺省，行为变更属预期演进） */
function parseMcpSection(section: { resultMaxChars?: number } | undefined): { resultMaxChars?: number } | undefined {
  if (!section || section.resultMaxChars === undefined) return undefined;
  const v = section.resultMaxChars;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(
      `配置非法：mcp.resultMaxChars 必须为正数字（收到：${typeof v === 'number' ? String(v) : typeof v}）——fail-fast 拒绝启动，不静默回退缺省（P3-2，与 D-29 envRefs 解析语义对齐）`,
    );
  }
  return { resultMaxChars: Math.floor(v) };
}

/** 第四阶段批次一（§4.2）：mcpServers 段解析——transport 限 stdio（http/sse 字段位预留本期拒绝） */
function parseMcpServers(
  section: Record<string, { transport?: string; command?: string; args?: string[]; envRefs?: Record<string, string> }> | undefined,
): Record<string, import('./mcp/client.js').McpServerConfig> | undefined {
  if (!section || Object.keys(section).length === 0) return undefined;
  const result: Record<string, import('./mcp/client.js').McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(section)) {
    if (name.startsWith('$')) continue; // 模板注释键（config.example.json 惯例）
    const transport = cfg.transport ?? 'stdio';
    if (transport !== 'stdio') {
      throw new ConfigError(`mcpServers.${name}.transport=${transport} 本期仅支持 stdio（http/sse 为字段位预留，§4.2）`);
    }
    result[name] = { transport: 'stdio', command: cfg.command, args: cfg.args, envRefs: cfg.envRefs };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function buildProviderFromConfig(config: RuntimeConfig): ModelProvider {
  return new AnthropicProvider({ baseUrl: config.provider.baseUrl, authToken: config.provider.authToken });
}

export function modelWhitelistOf(config: RuntimeConfig): ReadonlySet<string> {
  return new Set(config.provider.models);
}
