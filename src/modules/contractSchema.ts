// A2 §6 输出/输入契约 Schema 子集规则（冻结）——注册准入子集校验 + 实例校验
// 效力范围：inputContract 与 outputContract 同时受约束（对称）。

const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'enum',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'title', 'description',
  '$schema', '$defs', '$ref',
]);

const FORBIDDEN_KEYWORDS = [
  'patternProperties', 'if', 'then', 'else', 'not',
  'unevaluatedProperties', 'unevaluatedItems',
  'allOf', 'oneOf', 'anyOf', 'pattern', 'multipleOf',
  'dependentSchemas', 'dependencies', 'contains', 'propertyNames',
  'exclusiveMinimum', 'exclusiveMaximum', 'uniqueItems', 'const',
  'minProperties', 'maxProperties', 'default', 'examples',
];

const FORMAT_WHITELIST = new Set(['date-time', 'date', 'time', 'email', 'uuid']);

export interface SubsetViolation {
  path: string;
  keyword: string;
  message: string;
}

/** 子集校验（注册准入）。返回违规列表；空 = 通过。 */
export function checkSubset(schema: unknown, rootLabel = ''): SubsetViolation[] {
  const violations: SubsetViolation[] = [];
  walk(schema, rootLabel || '$');
  return violations;

  function walk(node: unknown, path: string): void {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push({ path, keyword: '', message: 'schema 节点必须为对象' });
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const kw of FORBIDDEN_KEYWORDS) {
      if (kw in obj) {
        violations.push({ path, keyword: kw, message: `禁止关键字 ${kw}（A2 §6 禁止清单）` });
      }
    }
    for (const key of Object.keys(obj)) {
      if (key === 'additionalProperties') {
        if (obj[key] !== false) {
          violations.push({ path, keyword: key, message: 'additionalProperties 仅允许 false 字面值' });
        }
        continue;
      }
      if (key === 'format') {
        const v = obj[key];
        if (typeof v !== 'string' || !FORMAT_WHITELIST.has(v)) {
          violations.push({ path, keyword: key, message: `format 白名单外取值：${String(v)}` });
        }
        continue;
      }
      if (key === 'enum') {
        if (!Array.isArray(obj[key])) {
          violations.push({ path, keyword: key, message: 'enum 必须为数组' });
        }
        continue;
      }
      if (key === 'type') {
        const t = obj[key];
        if (t !== 'object' && t !== 'string' && t !== 'integer' && t !== 'number' && t !== 'boolean' && t !== 'array' && t !== 'null') {
          violations.push({ path, keyword: key, message: `不支持的 type：${String(t)}` });
        }
        continue;
      }
      if (!ALLOWED_KEYWORDS.has(key)) {
        violations.push({ path, keyword: key, message: '子集外关键字' });
      }
    }
    // 强制规则：对象节点必须显式 additionalProperties:false；字符串必须同时给 minLength/maxLength
    if (obj.type === 'object' && obj.additionalProperties !== false) {
      violations.push({ path, keyword: 'additionalProperties', message: '对象节点必须显式 additionalProperties:false' });
    }
    if (obj.type === 'string' && ('minLength' in obj) !== ('maxLength' in obj)) {
      violations.push({
        path, keyword: 'minLength/maxLength',
        message: '字符串长度必须同时给 minLength(≥0) 与 maxLength（防截断不可判定）',
      });
    }
    // $ref：仅同文档 $defs 内引用，禁止递归
    if (typeof obj.$ref === 'string' && !obj.$ref.startsWith('#/$defs/')) {
      violations.push({ path, keyword: '$ref', message: '仅允许同文档 #/$defs/ 引用' });
    }
    if (obj.properties && typeof obj.properties === 'object') {
      for (const [k, child] of Object.entries(obj.properties as Record<string, unknown>)) {
        walk(child, `${path}.properties.${k}`);
      }
    }
    if (obj.items) walk(obj.items, `${path}.items`);
    if (obj.$defs && typeof obj.$defs === 'object') {
      for (const [k, child] of Object.entries(obj.$defs as Record<string, unknown>)) {
        walk(child, `$defs.${k}`);
      }
    }
  }
}

export interface ContractViolation {
  path: string;
  expected: string;
  actual: string;
}

/** 实例校验：对子集内 Schema 做结构校验（L2）。返回违规列表；空 = 通过。 */
export function validateInstance(instance: unknown, schema: unknown, rootLabel = ''): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const defs = getDefs(schema);
  validate(instance, schema, rootLabel || '$');
  return violations;

  function resolve(node: Record<string, unknown>): Record<string, unknown> {
    if (typeof node.$ref === 'string' && defs) {
      const name = node.$ref.slice('#/$defs/'.length);
      const target = defs[name];
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        return target as Record<string, unknown>;
      }
    }
    return node;
  }

  function validate(value: unknown, node: unknown, path: string): void {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const s = resolve(node as Record<string, unknown>);

    if ('enum' in s && Array.isArray(s.enum)) {
      const ok = (s.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value));
      if (!ok) {
        violations.push({ path, expected: `enum(${JSON.stringify(s.enum)})`, actual: JSON.stringify(value) });
        return;
      }
    }

    const type = s.type as string | undefined;
    if (type !== undefined) {
      const typeOk =
        (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
        (type === 'array' && Array.isArray(value)) ||
        (type === 'string' && typeof value === 'string') ||
        (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
        (type === 'number' && typeof value === 'number') ||
        (type === 'boolean' && typeof value === 'boolean') ||
        (type === 'null' && value === null);
      if (!typeOk) {
        violations.push({ path, expected: `type=${type}`, actual: describeType(value) });
        return;
      }
    }

    if (typeof value === 'string' && type === 'string') {
      if (typeof s.format === 'string' && !checkFormat(value, s.format)) {
        violations.push({ path, expected: `format=${s.format}`, actual: value });
      }
    }

    if (typeof value === 'number') {
      if (typeof s.minimum === 'number' && value < s.minimum) {
        violations.push({ path, expected: `>=${s.minimum}`, actual: String(value) });
      }
      if (typeof s.maximum === 'number' && value > s.maximum) {
        violations.push({ path, expected: `<=${s.maximum}`, actual: String(value) });
      }
    }

    if (typeof value === 'string') {
      if (typeof s.minLength === 'number' && value.length < s.minLength) {
        violations.push({ path, expected: `length>=${s.minLength}`, actual: String(value.length) });
      }
      if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
        violations.push({ path, expected: `length<=${s.maxLength}`, actual: String(value.length) });
      }
    }

    if (Array.isArray(value)) {
      if (typeof s.minItems === 'number' && value.length < s.minItems) {
        violations.push({ path, expected: `items>=${s.minItems}`, actual: String(value.length) });
      }
      if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
        violations.push({ path, expected: `items<=${s.maxItems}`, actual: String(value.length) });
      }
      if (s.items) {
        value.forEach((item, i) => validate(item, s.items, `${path}[${i}]`));
      }
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = (s.required ?? []) as string[];
      for (const key of required) {
        if (!(key in value)) {
          violations.push({ path: `${path}.${key}`, expected: '必填字段', actual: '缺失' });
        }
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!(key in props)) {
            violations.push({ path: `${path}.${key}`, expected: '未声明字段（闭合对象）', actual: '存在' });
          }
        }
      }
      for (const [k, childSchema] of Object.entries(props)) {
        if (k in value) {
          validate((value as Record<string, unknown>)[k], childSchema, `${path}.${k}`);
        }
      }
    }
  }
}

function getDefs(schema: unknown): Record<string, unknown> | null {
  if (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) {
    const d = (schema as Record<string, unknown>).$defs;
    if (d && typeof d === 'object' && !Array.isArray(d)) return d as Record<string, unknown>;
  }
  return null;
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkFormat(value: string, format: string): boolean {
  switch (format) {
    case 'date-time': return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'time': return /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value);
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uuid': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    default: return false;
  }
}
