import type { FailureSubClass } from '../types.js';

// §4.4-1（批次三，D-22 冻结方向）：失败子类清单单一常量源（P2-C 同源化）。
// 三处消费点全部 import 本模块，防「常量 + SQL 硬编码 + 白名单」三份漂移：
//   ① evolution 聚合排除常量（EXCLUDED_FROM_CONTRACT_RATE）
//   ② evolution 聚合 SQL 参数化（evolutionNotInPlaceholders，从常量动态构造）
//   ③ report 契约通过率白名单（CONTRACT_RATE_SUBCLASSES，countedInContractRate 物化列口径）

/** A4 §1「计入契约失败率」白名单（6 项）：仅此子类计入 report 分子 */
export const CONTRACT_RATE_SUBCLASSES: readonly FailureSubClass[] = [
  'unparseable_output',
  'schema_violation',
  'enum_violation',
  'format_violation',
  'truncation',
  'ContractViolation',
];

/** C2 排除口径（A4 §4）：infra 类失败不计入 Evolution 聚合（失败模式归因不可信） */
export const EXCLUDED_FROM_CONTRACT_RATE: readonly FailureSubClass[] = [
  'provider_infra',
  'provider_rejected_schema',
];

/** SQL 动态构造占位符（NOT IN (?,?)——从常量生成，禁止手写字面量双份） */
export function evolutionNotInPlaceholders(): string {
  return EXCLUDED_FROM_CONTRACT_RATE.map(() => '?').join(',');
}
