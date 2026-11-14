// TASK-244：contractSchema.ts 低频拒绝分支用例补齐（纯测试追加批，零 src 改动）。
// 覆盖面：基线 830b154 实测 93/124（75.00%）中未覆盖的 31 条语句——
//   checkSubset：非对象节点（L36-37）、enum 非数组（L61）、不支持 type（L68）、
//     跨文档 $ref（L88）、items 递归（L95）、$defs 递归（L97-98）；
//   validateInstance：$ref 解析（L119-122）、非对象 schema 子节点守卫（L129）、
//     minimum/maximum（L164/167）、minItems/maxItems（L181-185）、items 递归（L187-188）；
//   辅助函数：getDefs 命中（L219）、describeType null/array（L226-227）、
//     checkFormat 五白名单 case 体（L232-237）。
import { describe, expect, it } from 'vitest';
import { checkSubset, validateInstance } from '../src/modules/contractSchema.js';

describe('TASK-244 · checkSubset 低频拒绝分支', () => {
  it('非对象 schema 节点被拒（null 根 / 数组子节点 / 字符串子节点），路径含 rootLabel', () => {
    // null 根节点（默认 rootLabel '$'）
    expect(checkSubset(null)).toEqual([
      { path: '$', keyword: '', message: 'schema 节点必须为对象' },
    ]);
    // properties 子节点为数组
    const arr = checkSubset({ type: 'object', properties: { a: [1, 2] }, additionalProperties: false });
    expect(arr.some((v) => v.path === '$.properties.a' && v.message === 'schema 节点必须为对象')).toBe(true);
    // properties 子节点为字符串，自定义 rootLabel 进入路径
    const str = checkSubset({ type: 'object', properties: { a: 'oops' }, additionalProperties: false }, 'in');
    expect(str.some((v) => v.path === 'in.properties.a' && v.message === 'schema 节点必须为对象')).toBe(true);
  });

  it('enum 必须为数组', () => {
    const v = checkSubset({ type: 'string', enum: 'not-an-array', minLength: 0, maxLength: 5 });
    expect(v.some((x) => x.keyword === 'enum' && x.message === 'enum 必须为数组')).toBe(true);
  });

  it('不支持的 type 取值被拒', () => {
    const v = checkSubset({ type: 'set' });
    expect(v.some((x) => x.keyword === 'type' && x.message === '不支持的 type：set')).toBe(true);
  });

  it('$ref 仅允许同文档 #/$defs/ 引用（跨文档引用被拒）', () => {
    const v = checkSubset({ $ref: 'https://ext.example.com/schema.json' });
    expect(v.some((x) => x.keyword === '$ref' && x.message === '仅允许同文档 #/$defs/ 引用')).toBe(true);
  });

  it('items 子树递归校验（违规路径进入 $.items）', () => {
    const v = checkSubset({ type: 'array', items: { type: 'string', minLength: 1 } });
    expect(v.some((x) => x.path === '$.items' && x.keyword === 'minLength/maxLength')).toBe(true);
  });

  it('$defs 子树递归校验（违规路径进入 $defs.<name>）', () => {
    const v = checkSubset({ $defs: { bad: { type: 'magic' } } });
    expect(v.some((x) => x.path === '$defs.bad' && x.keyword === 'type' && x.message === '不支持的 type：magic')).toBe(true);
  });
});

describe('TASK-244 · validateInstance 低频分支', () => {
  it('$ref 解析到 $defs 目标后按目标 schema 校验（合法通过 / enum 违规指名路径）', () => {
    const schema = {
      type: 'object',
      properties: { status: { $ref: '#/$defs/status' } },
      required: ['status'],
      additionalProperties: false,
      $defs: { status: { type: 'string', enum: ['ok', 'fail'] } },
    };
    expect(validateInstance({ status: 'ok' }, schema)).toEqual([]);
    const bad = validateInstance({ status: 'weird' }, schema);
    expect(bad.some((v) => v.path === '$.status' && v.expected.includes('enum') && v.actual.includes('weird'))).toBe(true);
  });

  it('schema 子节点为非对象时跳过校验（守卫分支，零违规）', () => {
    const schema = { type: 'object', properties: { a: null }, additionalProperties: false };
    expect(validateInstance({ a: 1 }, schema)).toEqual([]);
  });

  it('数值边界违规：minimum / maximum 各自产出独立违规', () => {
    const schema = { type: 'number', minimum: 1, maximum: 10 };
    expect(validateInstance(0, schema)).toEqual([{ path: '$', expected: '>=1', actual: '0' }]);
    expect(validateInstance(11, schema)).toEqual([{ path: '$', expected: '<=10', actual: '11' }]);
  });

  it('数组边界违规：minItems / maxItems / items 递归校验', () => {
    const schema = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 2 };
    expect(validateInstance([], schema).some((v) => v.expected === 'items>=1' && v.actual === '0')).toBe(true);
    expect(validateInstance([1, 2, 3], schema).some((v) => v.expected === 'items<=2' && v.actual === '3')).toBe(true);
    const bad = validateInstance([1, 'x'], { type: 'array', items: { type: 'integer' } });
    expect(bad.some((v) => v.path === '$[1]' && v.expected === 'type=integer' && v.actual === 'string')).toBe(true);
  });

  it('type 违规时 actual 类型描述覆盖 null 与 array', () => {
    expect(validateInstance(null, { type: 'string' })).toEqual([
      { path: '$', expected: 'type=string', actual: 'null' },
    ]);
    expect(validateInstance([1], { type: 'string' })).toEqual([
      { path: '$', expected: 'type=string', actual: 'array' },
    ]);
  });

  it('format 白名单五格式正反例全路径（date-time/date/time/email/uuid）', () => {
    const cases: Array<[string, string, string]> = [
      ['date-time', '2026-11-14T10:00:00Z', '2026-11-14 10:00:00'],
      ['date', '2026-11-14', '14-11-2026'],
      ['time', '10:00:00Z', "10 o'clock"],
      ['email', 'a@b.co', 'not-an-email'],
      ['uuid', '123e4567-e89b-12d3-a456-426614174000', 'not-a-uuid'],
    ];
    for (const [fmt, good, bad] of cases) {
      const schema = { type: 'string', format: fmt, minLength: 0, maxLength: 64 };
      expect(validateInstance(good, schema), fmt).toEqual([]);
      expect(validateInstance(bad, schema).some((v) => v.expected === `format=${fmt}`), fmt).toBe(true);
    }
    // 白名单外 format（实例校验独立于注册准入直接调用时可出现）：checkFormat default 分支判 false
    const unknown = validateInstance('x', { type: 'string', format: 'ipv4' });
    expect(unknown.some((v) => v.expected === 'format=ipv4' && v.actual === 'x')).toBe(true);
  });
});
