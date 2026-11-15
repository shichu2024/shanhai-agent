import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { REVIEW_ITEMS } from '../src/modules/registry.js';
import { isEvidencePending, type CapabilityRow } from '../src/modules/capabilityRegistry.js';
import { redactEventPayload, type RedactionPolicy } from '../src/modules/redaction.js';
import { makeHarness, sampleSpec, registerAndRelease, validationDepsOf } from './helpers.js';

// wp262（第四十八批 · 覆盖加固蓄余量）：纯测试触达的低风险只读/错误分支补测。
// 覆盖面分组：registry CLI 拒绝分支 ×6（review 清单缺项/未知项、promote 无灰度、
// deprecate 非 released、requireVersion 版本不存在）/ evolution 存量防御 ×3
// （derivedVersionIds 非数组、非法 JSON、requireOpen 不存在）/ redaction 非法正则跳过 ×1 /
// capabilityRegistry isEvidencePending 派生标注 ×1（合计 11）。
// 零 src 改动、零门值改动、零既有用例改动。

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 直插一条 open 候选行（绕过聚合路径，构造存量异常形态） */
function insertCandidate(rt: Runtime, candidateId: string, derivedVersionIds: string): void {
  dbOf(rt).prepare(
    `INSERT INTO evolution_candidate
       (candidateId, agentId, trigger, evidenceRefs, status, proposedChange, createdAt, decidedAt, decidedBy, derivedVersionIds)
     VALUES (?,?,?,'[]','open',NULL,?,NULL,NULL,?)`,
  ).run(candidateId, 'wp262-ev', 'repeated_failure', '2026-11-16T00:00:00.000000000Z', derivedVersionIds);
}

describe('wp262 覆盖加固：registry CLI 拒绝分支', () => {
  it('review 检视清单缺项 → 拒绝迁移（5 项须逐项确认）', () => {
    const h = makeHarness();
    const versionId = h.rt.registry.registerSpec(sampleSpec({ agentId: 'wp262-rv-miss' }), 'test', validationDepsOf(h.rt));
    const partial = REVIEW_ITEMS.slice(0, 4).map((item) => ({ item, verdict: true }));
    expect(() => h.rt.registry.review('wp262-rv-miss', versionId, 'test', partial)).toThrowError(/检视清单不完整/);
    expect(h.rt.registry.getVersion(versionId)!.status).toBe('draft'); // 拒绝后不迁移
  });

  it('review 检视清单含未知项 → 拒绝迁移', () => {
    const h = makeHarness();
    const versionId = h.rt.registry.registerSpec(sampleSpec({ agentId: 'wp262-rv-unk' }), 'test', validationDepsOf(h.rt));
    const withUnknown = [...REVIEW_ITEMS.map((item) => ({ item, verdict: true })), { item: 'nonexistent-item', verdict: true }];
    expect(() => h.rt.registry.review('wp262-rv-unk', versionId, 'test', withUnknown)).toThrowError(/检视清单含未知项/);
    expect(h.rt.registry.getVersion(versionId)!.status).toBe('draft');
  });

  it('promote 无有效灰度 → 拒绝晋升', () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp262-promo' }));
    expect(() => h.rt.registry.promote('wp262-promo', 'test')).toThrowError(/无有效灰度可晋升/);
  });

  it('deprecate 非 released 版本（draft）→ 拒绝', () => {
    const h = makeHarness();
    const versionId = h.rt.registry.registerSpec(sampleSpec({ agentId: 'wp262-dep' }), 'test', validationDepsOf(h.rt));
    expect(() => h.rt.registry.deprecate('wp262-dep', versionId, 'test')).toThrowError(/deprecate 仅允许 released→deprecated/);
  });

  it('requireVersion：版本不存在 → 拒绝（结构化错误）', () => {
    const h = makeHarness();
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp262-exist' }));
    expect(() => h.rt.registry.deprecate('wp262-exist', 'v-does-not-exist', 'test')).toThrowError(/版本不存在或不属于该 agentId/);
  });
});

describe('wp262 覆盖加固：evolution 存量防御', () => {
  it('attachDerivedVersion：derivedVersionIds 为非法 JSON → 防御性视为空数组回填', () => {
    const h = makeHarness();
    insertCandidate(h.rt, 'wp262-cand-bad', '{bad json');
    const row = h.rt.evolutions.attachDerivedVersion('wp262-cand-bad', 'v-new');
    expect(JSON.parse(row.derivedVersionIds) as string[]).toEqual(['v-new']); // 不炸回填，重建为干净数组
  });

  it('attachDerivedVersion：derivedVersionIds 为合法 JSON 但非数组 → 防御性视为空数组回填', () => {
    const h = makeHarness();
    insertCandidate(h.rt, 'wp262-cand-nonarray', '"nope"');
    const row = h.rt.evolutions.attachDerivedVersion('wp262-cand-nonarray', 'v-new');
    expect(JSON.parse(row.derivedVersionIds) as string[]).toEqual(['v-new']);
  });

  it('requireOpen：候选不存在 → not_found（confirm/dismiss 同源守卫）', () => {
    const h = makeHarness();
    expect(() => h.rt.evolutions.dismiss('wp262-no-such-candidate', 'test')).toThrowError(/演进候选不存在/);
    expect(() => h.rt.evolutions.confirm('wp262-no-such-candidate', 'test')).toThrowError(/演进候选不存在/);
  });
});

describe('wp262 覆盖加固：redaction / capabilityRegistry', () => {
  it('非法正则规则跳过（不炸管道；配置错误由摘要缺位体现）', () => {
    const policy: RedactionPolicy = {
      rules: [
        { ruleId: 'bad-regex', pattern: '(' }, // 非法正则：编译失败须跳过而非抛错
        { ruleId: 'email', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
      ],
    };
    const out = redactEventPayload({ note: '联系人 a@corp.com' }, policy);
    expect(out.redacted.map((r) => r.ruleId)).toEqual(['email']); // 非法规则缺位、合法规则仍生效
    expect(JSON.stringify(out.payload)).not.toContain('a@corp.com');
    expect(JSON.stringify(out.payload)).toContain('[REDACTED:email]');
  });

  it('isEvidencePending：evidenceRefs 空 ↔ 非空派生标注', () => {
    const draft = { evidenceRefs: '[]' } as CapabilityRow;
    const linked = { evidenceRefs: '[{"taskId":"t1"}]' } as CapabilityRow;
    expect(isEvidencePending(draft)).toBe(true); // 「人类知道但暂无运行证据」草稿形态
    expect(isEvidencePending(linked)).toBe(false);
  });
});
