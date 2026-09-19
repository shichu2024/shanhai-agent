import { describe, expect, it } from 'vitest';
import { validateRegistration, checkInputContract } from '../src/modules/specValidator.js';
import { checkSubset } from '../src/modules/contractSchema.js';
import { contentHash, canonicalize } from '../src/hash.js';
import { makeHarness, sampleSpec, validationDepsOf } from './helpers.js';

describe('A2 §6 契约 Schema 子集校验', () => {
  it('子集内合法契约通过', () => {
    expect(checkSubset({
      type: 'object',
      properties: { a: { type: 'string', minLength: 0, maxLength: 10 }, b: { type: 'integer', minimum: 0, maximum: 5 } },
      required: ['a'],
      additionalProperties: false,
    })).toEqual([]);
  });

  it('禁止关键字被拒（patternProperties / oneOf / pattern / if-then-else / not）', () => {
    for (const kw of ['patternProperties', 'oneOf', 'allOf', 'pattern', 'if', 'not', 'unevaluatedProperties']) {
      const violations = checkSubset({ type: 'object', properties: {}, additionalProperties: false, [kw]: {} });
      expect(violations.some((v) => v.keyword === kw), kw).toBe(true);
    }
  });

  it('additionalProperties 必须显式 false（true 与缺省均拒）', () => {
    expect(checkSubset({ type: 'object', properties: {}, additionalProperties: true }).length).toBeGreaterThan(0);
    expect(checkSubset({ type: 'object', properties: {} }).length).toBeGreaterThan(0);
  });

  it('字符串长度必须同时给 minLength/maxLength', () => {
    const v = checkSubset({ type: 'string', minLength: 1 });
    expect(v.some((x) => x.keyword.includes('minLength') && x.message.includes('maxLength'))).toBe(true);
  });

  it('format 白名单外取值被拒，白名单内通过', () => {
    expect(checkSubset({ type: 'string', format: 'ipv4', minLength: 0, maxLength: 45 }).length).toBeGreaterThan(0);
    expect(checkSubset({ type: 'string', format: 'date-time', minLength: 0, maxLength: 64 })).toEqual([]);
  });
});

describe('A1 §4 注册准入校验', () => {
  const harness = makeHarness();

  it('合法 Spec 通过', () => {
    const result = validateRegistration(sampleSpec(), validationDepsOf(harness.rt));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('D-1：maxModelCalls 缺失时错误信息指名字段路径', () => {
    const spec = sampleSpec() as { modelPolicy: Record<string, unknown> };
    delete spec.modelPolicy.maxModelCalls;
    const result = validateRegistration(spec, validationDepsOf(harness.rt));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path.includes('maxModelCalls'))).toBe(true);
  });

  it('C3-①：声明未注册工具的 Spec 注册即拒（含字段路径）', () => {
    const spec = sampleSpec({ tools: [{ toolId: 'not-registered-tool', riskLevel: 'L0' }] });
    const result = validateRegistration(spec, validationDepsOf(harness.rt));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path.startsWith('toolPolicy.tools[') && i.message.includes('未注册'))).toBe(true);
  });

  it('D-3：声明 L3/L4 工具注册即拒', () => {
    for (const level of ['L3', 'L4']) {
      const spec = sampleSpec({ tools: [{ toolId: 'docs-list', riskLevel: level }] });
      const result = validateRegistration(spec, validationDepsOf(harness.rt));
      expect(result.issues.some((i) => i.message.includes('注册即拒')), level).toBe(true);
    }
  });

  it('风险等级声明与登记不一致被拒', () => {
    const spec = sampleSpec({ tools: [{ toolId: 'docs-list', riskLevel: 'L1' }] });
    const result = validateRegistration(spec, validationDepsOf(harness.rt));
    expect(result.issues.some((i) => i.message.includes('不一致'))).toBe(true);
  });

  it('R-3：L2 工具必须声明受控字段（二至少一）', () => {
    const spec = sampleSpec({ tools: [{ toolId: 'note-append', riskLevel: 'L2' }] });
    const result = validateRegistration(spec, validationDepsOf(harness.rt));
    expect(result.issues.some((i) => i.message.includes('paramRanges'))).toBe(true);
  });

  it('模型白名单外的 allowedModels 被拒', () => {
    const spec = sampleSpec({ modelPolicy: { allowedModels: ['gpt-secret'], maxModelCalls: 5, maxTokens: 1000 } });
    const result = validateRegistration(spec, validationDepsOf(harness.rt));
    expect(result.issues.some((i) => i.path === 'modelPolicy.allowedModels')).toBe(true);
  });

  it('evolutionPolicy v1.1 解禁（A1 §2.3，D-14）：受约束合法字段；非法结构/requireReviewed=false 仍拒', () => {
    // A1 v1.1 修订注记：V1 对 evolutionPolicy 的禁止条款废止——迁移为受约束可选字段（批次三）
    const legal = sampleSpec({ extraTop: { evolutionPolicy: { allowed: true, triggers: ['repeated_failure'], failureThreshold: 3, guardrails: { requireReviewed: true } } } });
    expect(validateRegistration(legal, validationDepsOf(harness.rt)).ok).toBe(true);
    // allowed:false 等价缺省（合法）
    const off = sampleSpec({ extraTop: { evolutionPolicy: { allowed: false } } });
    expect(validateRegistration(off, validationDepsOf(harness.rt)).ok).toBe(true);
    // 未知触发器 / 缺 allowed / requireReviewed 显式 false → 拒（防伪声明与越权关闭）
    const badTrigger = sampleSpec({ extraTop: { evolutionPolicy: { allowed: true, triggers: ['yolo'] } } });
    expect(validateRegistration(badTrigger, validationDepsOf(harness.rt)).ok).toBe(false);
    const noAllowed = sampleSpec({ extraTop: { evolutionPolicy: { triggers: ['repeated_failure'] } } });
    expect(validateRegistration(noAllowed, validationDepsOf(harness.rt)).ok).toBe(false);
    const noGuardrail = sampleSpec({ extraTop: { evolutionPolicy: { allowed: true, guardrails: { requireReviewed: false } } } });
    const guardResult = validateRegistration(noGuardrail, validationDepsOf(harness.rt));
    expect(guardResult.ok).toBe(false);
    expect(guardResult.issues.some((i) => i.message.includes('requireReviewed'))).toBe(true); // DoD-⑦ 不可关闭
  });

  it('memoryPolicy v1.1（A1 §2.1，D-13）：persistent 合法（injection 默认 off 由缺省承担）；非法取值仍拒', () => {
    // A1 v1.1：persistent 为受约束合法值（批次三解禁）；其他取值注册拒绝（防伪声明）
    const persistent = sampleSpec({ extraTop: { memoryPolicy: { type: 'persistent' } } });
    expect(validateRegistration(persistent, validationDepsOf(harness.rt)).ok).toBe(true);
    const full = sampleSpec({ extraTop: { memoryPolicy: { type: 'persistent', writePolicy: 'task_output', maxEntriesPerTask: 5, retentionDays: 30, injection: 'context' } } });
    expect(validateRegistration(full, validationDepsOf(harness.rt)).ok).toBe(true);
    const bogus = sampleSpec({ extraTop: { memoryPolicy: { type: 'bogus' } } });
    expect(validateRegistration(bogus, validationDepsOf(harness.rt)).ok).toBe(false);
    const badInjection = sampleSpec({ extraTop: { memoryPolicy: { type: 'persistent', injection: 'always' } } });
    expect(validateRegistration(badInjection, validationDepsOf(harness.rt)).ok).toBe(false);
  });

  it('A4 口径：契约实例校验产出 violations（path/expected/actual）', () => {
    const contract = sampleSpec().inputContract as Record<string, unknown>;
    expect(checkInputContract({ topic: 'x' }, contract)).toEqual([]);
    const bad = checkInputContract({ topic: '' }, contract);
    expect(bad[0].path).toBe('input.topic');
    expect(bad[0].expected).toContain('length>=');
  });
});

describe('A1 §5 哈希与不可变', () => {
  it('正则化：键序无关，contentHash 稳定', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('不可变触发器：业务字段 UPDATE 与 DELETE 被 SQLite 拒绝', () => {
    const { rt } = makeHarness();
    const versionId = rt.registry.registerSpec(sampleSpec(), 'test', validationDepsOf(rt));
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    expect(() => db.prepare(`UPDATE agent_version SET specSnapshot = '{}' WHERE versionId = ?`).run(versionId)).toThrowError(/immutable/);
    expect(() => db.prepare(`DELETE FROM agent_version WHERE versionId = ?`).run(versionId)).toThrowError(/immutable/);
  });

  it('状态列是唯一合法 UPDATE 目标（A5 迁移经此写入）', () => {
    const { rt } = makeHarness();
    const versionId = rt.registry.registerSpec(sampleSpec(), 'test', validationDepsOf(rt));
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    expect(() => db.prepare(`UPDATE agent_version SET status = 'released' WHERE versionId = ?`).run(versionId)).not.toThrow();
  });
});
