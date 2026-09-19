import { SECRET_PATTERNS } from '../scripts/releaseScan.js';

// A6 §8 v1.1（D-11 冻结）：写入时脱敏，原文不落盘。
// 管道不可削（含空规则集），规则集内容可裁；preserveDigests 强制 true（不可关）。
// 排除表（白名单，硬条款）：公共信封 10 字段、task_started.bindingSnapshot、全部 *Digest 字段——
// 只对自由文本载荷（input/output 原文、message、args/result 原文层）执行；digest 由调用方在脱敏前按原文计算。

export interface RedactionRule {
  ruleId: string;
  pattern: string; // 正则源文本（命中替换为 [REDACTED:<ruleId>]）
  scope: 'payload' | 'all';
}

export interface RedactionPolicy {
  rules: RedactionRule[];
}

/** 信封 10 字段（A6 §2）：属主 = TraceRecorder（结构承载，payload 携带同名键即剥离，见 STRIP_AT_ENTRY） */
const ENVELOPE_KEYS = new Set(['eventId', 'timestamp', 'traceId', 'taskId', 'agentId', 'agentVersionId', 'specContentHash', 'eventType', 'callNo', 'callKind', 'attemptNo']);

/** 排除表键名（A6 §8 机制 1）：零改写（walk 不递归改写其值）——含合法载荷键 bindingSnapshot 与全部 *Digest 字段 */
const EXCLUDED_KEY_SUFFIX = /Digest$/;
const EXCLUDED_KEYS = new Set([...ENVELOPE_KEYS, 'bindingSnapshot']);

/** P3-①（批次二反方遗留）：信封同名键入口剥离——payload 携带的信封键/redacted 键在脱敏前剥除，
 * 防 TraceRecorder `{...envelope, ...redactedPayload}` 展开时载荷覆写信封（信封字段唯一属主 = TraceRecorder）。
 * 注意：bindingSnapshot 是合法 task_started 载荷键——属排除表（零改写）而非剥离集。 */
const STRIP_AT_ENTRY = new Set([...ENVELOPE_KEYS, 'redacted']);

/** 默认规则集（A6 §8）：① 密钥格式正则（复用 T3 扫描清单同一载体）② email */
export function defaultRedactionPolicy(): RedactionPolicy {
  return {
    rules: [
      ...SECRET_PATTERNS.map((p, i) => ({ ruleId: `secret-${i + 1}`, pattern: p.re.source, scope: 'all' as const })),
      { ruleId: 'email', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', scope: 'payload' as const },
    ],
  };
}

export interface RedactionSummary {
  ruleId: string;
  count: number;
}

export interface RedactionResult {
  payload: Record<string, unknown>;
  redacted: RedactionSummary[];
}

/**
 * 对事件载荷执行规则脱敏（递归仅作用于自由文本字符串；排除表键与结构化非字符串值不动）。
 * 返回改写后的载荷 + redacted 摘要（不含原文——「脱敏了什么」可审计，「被脱敏内容」不可恢复）。
 */
export function redactEventPayload(payload: Record<string, unknown>, policy: RedactionPolicy): RedactionResult {
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!STRIP_AT_ENTRY.has(k)) stripped[k] = v; // P3-①：信封同名键/redacted 键剥离（不进载荷、不进摘要）
  }
  const compiled = policy.rules.map((r) => {
    try {
      return { ruleId: r.ruleId, re: new RegExp(r.pattern, 'g') };
    } catch {
      return null; // 非法正则规则跳过（不炸管道；配置错误由摘要缺位体现）
    }
  }).filter((x): x is { ruleId: string; re: RegExp } => x !== null);
  const counts = new Map<string, number>();
  const out = walk(stripped, compiled, counts, false) as Record<string, unknown>;
  const redacted = [...counts.entries()].filter(([, n]) => n > 0).map(([ruleId, count]) => ({ ruleId, count }));
  return { payload: out, redacted };
}

function walk(
  value: unknown,
  rules: { ruleId: string; re: RegExp }[],
  counts: Map<string, number>,
  keyExcluded: boolean,
): unknown {
  if (typeof value === 'string') {
    if (keyExcluded) return value; // 排除表字段（信封/bindingSnapshot/*Digest）零改写
    let s = value;
    for (const { ruleId, re } of rules) {
      re.lastIndex = 0;
      s = s.replace(re, () => {
        counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
        return `[REDACTED:${ruleId}]`;
      });
    }
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, rules, counts, keyExcluded));
  }
  if (value !== null && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const excluded = EXCLUDED_KEYS.has(k) || EXCLUDED_KEY_SUFFIX.test(k);
      obj[k] = walk(v, rules, counts, excluded);
    }
    return obj;
  }
  return value; // 数字/布尔/null 等结构化值不动
}
