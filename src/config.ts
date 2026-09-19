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
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 配置解析：config 文件承载非秘密部分（baseUrl、白名单），密钥仅从环境变量读取。
 * 查找次序：SHANHAI_CONFIG 环境变量指定的路径 → ./config.local.json → ./config.json。
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const configPath =
    env.SHANHAI_CONFIG ?? (existsSync('config.local.json') ? 'config.local.json' : 'config.local.json');
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `未找到配置文件（${configPath}）。T3 发布安全规则：无配置即拒绝启动——请复制 config.example.json 为 config.local.json 并通过环境变量注入密钥。`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
    providers?: Record<string, { baseUrl?: string; authTokenEnv?: string; models?: string[] }>;
    redaction?: { rules?: { ruleId?: string; pattern?: string; scope?: string }[] };
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
        rules: raw.redaction.rules
          .filter((r): r is { ruleId: string; pattern: string; scope: 'payload' | 'all' } =>
            typeof r.ruleId === 'string' && typeof r.pattern === 'string' && (r.scope === 'payload' || r.scope === 'all'))
          .map((r) => ({ ruleId: r.ruleId, pattern: r.pattern, scope: r.scope })),
      }
    : defaultRedactionPolicy();
  return {
    provider: { name: 'anthropic', baseUrl: anthropic.baseUrl, authToken: token, models: anthropic.models },
    redaction,
  };
}

export function buildProviderFromConfig(config: RuntimeConfig): ModelProvider {
  return new AnthropicProvider({ baseUrl: config.provider.baseUrl, authToken: config.provider.authToken });
}

export function modelWhitelistOf(config: RuntimeConfig): ReadonlySet<string> {
  return new Set(config.provider.models);
}
