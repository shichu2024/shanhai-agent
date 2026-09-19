import { createHash, randomUUID } from 'node:crypto';

// A1 §5：contentHash = 快照正则化（键排序）后的 SHA-256。
// 正则化算法固化：UTF-8、无 BOM、LF 行尾（跨平台稳定，A1 §8-3 由测试覆盖）。
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeys(v);
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function contentHash(spec: unknown): string {
  return sha256Hex(canonicalize(spec));
}

export function uuid(): string {
  return randomUUID();
}

export function sha256HexOfObj(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
