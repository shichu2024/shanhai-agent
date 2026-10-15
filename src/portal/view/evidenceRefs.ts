// TASK-157（每日优化第十四批）：evidenceRefs 解析防御统一收口（TASK-151 终审备案）。
// 语义基准：JSON 数组 → 原样数组；malformed（parse 抛出）或合法 JSON 非数组形态（标量字符串/数字/布尔/字面量 null/对象）
// 一律视为无证据引用 → 空数组（evidenceCount 天然为 0，与 evidencePending 判定一致）。
// 落库写入面（evolution.ts / capabilityRegistry）不在本收口范围——列语义 TEXT NOT NULL JSON 数组不变。
// 同族调用面（cli.ts / insight.ts 的 JSON.parse(r.evidenceRefs)）为范围外，交付评论列明。

/** evidenceRefs 列防御解析：非数组/异常形态 → []；数组 → 原样返回 */
export function parseEvidenceRefs(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
