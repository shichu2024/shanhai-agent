import { describe, expect, it } from 'vitest';
import { makeHarness, sampleSpec, validationDepsOf } from './helpers.js';
import { RegistrationError } from '../src/modules/registry.js';

describe('A1 §7 注册流程', () => {
  it('正常注册：返回 versionId，落 draft，审计 version_registered', () => {
    const { rt } = makeHarness();
    const spec = sampleSpec({ agentId: 'reg-a' });
    const versionId = rt.registry.registerSpec(spec, 'tester', validationDepsOf(rt));
    const row = rt.registry.getVersion(versionId)!;
    expect(row.status).toBe('draft');
    expect(row.version).toBe(1);
    expect(JSON.parse(row.specSnapshot)).toEqual(spec);
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    const events = db.prepare(`SELECT * FROM audit_events WHERE eventType='version_registered'`).all() as { target: string; payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload).contentHash).toBe(row.contentHash);
  });

  it('同 agentId 同 contentHash 重复注册被拒并写 RejectedRequest（P3-2）', () => {
    const { rt } = makeHarness();
    const spec = sampleSpec({ agentId: 'reg-dup' });
    rt.registry.registerSpec(spec, 'tester', validationDepsOf(rt));
    expect(() => rt.registry.registerSpec(spec, 'tester', validationDepsOf(rt))).toThrowError(/重复注册/);
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    const rejected = db.prepare(`SELECT * FROM audit_events WHERE kind='spec_registration'`).all();
    expect(rejected).toHaveLength(1);
  });

  it('文件改动再注册生成新版本（7.3），旧版本行原样保留', () => {
    const { rt } = makeHarness();
    const v1 = rt.registry.registerSpec(sampleSpec({ agentId: 'reg-v2' }), 't', validationDepsOf(rt));
    const changed = sampleSpec({ agentId: 'reg-v2' });
    (changed.identity as { name: string }).name = '文档分析员 v2';
    const v2 = rt.registry.registerSpec(changed, 't', validationDepsOf(rt));
    expect(v1).not.toBe(v2);
    expect(rt.registry.listVersions('reg-v2')).toHaveLength(2);
  });
});

describe('A5 §1 版本状态机与指针', () => {
  function mk(agentId: string): { rt: ReturnType<typeof makeHarness>['rt']; versionId: string; v2: string } {
    const { rt } = makeHarness();
    const versionId = rt.registry.registerSpec(sampleSpec({ agentId }), 't', validationDepsOf(rt));
    const spec2 = sampleSpec({ agentId });
    (spec2.identity as { name: string }).name = `${agentId} v2`;
    const v2 = rt.registry.registerSpec(spec2, 't', validationDepsOf(rt));
    return { rt, versionId, v2 };
  }

  it('release：draft→released + 指针移动 + 审计', () => {
    const { rt, versionId } = mk('ver-release');
    rt.registry.release('ver-release', versionId, 't');
    expect(rt.registry.getVersion(versionId)!.status).toBe('released');
    expect(rt.registry.getPointer('ver-release')).toBe(versionId);
  });

  it('无回退边：released 不能再 release，deprecated 不能复活', () => {
    const { rt, versionId, v2 } = mk('ver-edge');
    rt.registry.release('ver-edge', versionId, 't');
    expect(() => rt.registry.release('ver-edge', versionId, 't')).toThrowError(RegistrationError);
    rt.registry.release('ver-edge', v2, 't');
    rt.registry.deprecate('ver-edge', versionId, 't');
    expect(rt.registry.getVersion(versionId)!.status).toBe('deprecated');
    expect(() => rt.registry.release('ver-edge', versionId, 't')).toThrowError(/deprecated/);
  });

  it('P2-6：禁止 deprecate 当前指针目标版（结构化错误 + RejectedRequest）', () => {
    const { rt, versionId } = mk('ver-dep');
    rt.registry.release('ver-dep', versionId, 't');
    expect(() => rt.registry.deprecate('ver-dep', versionId, 't')).toThrowError(/先 rollback/);
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    expect(db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE kind='cli_operation'`).get() as { c: number }).toMatchObject({ c: 1 });
  });

  it('rollback：仅指针移动；目标非 Released 被拒；目标即当前指针被拒', () => {
    const { rt, versionId, v2 } = mk('ver-rb');
    rt.registry.release('ver-rb', versionId, 't');
    rt.registry.release('ver-rb', v2, 't');
    rt.registry.rollback('ver-rb', versionId, 't');
    expect(rt.registry.getPointer('ver-rb')).toBe(versionId);
    expect(() => rt.registry.rollback('ver-rb', versionId, 't')).toThrowError(/即当前指针/);
    rt.registry.deprecate('ver-rb', v2, 't');
    expect(() => rt.registry.rollback('ver-rb', v2, 't')).toThrowError(/Released/);
    // 回滚不产生新版本、不改快照
    expect(rt.registry.listVersions('ver-rb')).toHaveLength(2);
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    const rb = db.prepare(`SELECT * FROM audit_events WHERE eventType='version_rollback'`).all() as { payload: string }[];
    expect(JSON.parse(rb[0].payload).pointer).toEqual({ old: expect.any(String), new: versionId });
  });
});

describe('A2 附录 A Tool Registry', () => {
  it('等级只能升不能降（防降级洗白）', () => {
    const { rt } = makeHarness();
    rt.registry.registerTool({ toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L1', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' }, 't');
    expect(() =>
      rt.registry.registerTool({ toolId: 'docs-list', name: 'x', kind: 'builtin', riskLevel: 'L0', implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' }, 't'),
    ).toThrowError(/只能升不能降/);
  });

  it('重登记递增 implVersion 写 tool_reregistered 审计', () => {
    const { rt } = makeHarness();
    rt.registry.registerTool({ toolId: 'docs-list', name: 'docs-list', kind: 'builtin', riskLevel: 'L1', implVersion: '0.2.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active' }, 't');
    const db = (rt as unknown as { db: import('better-sqlite3').Database }).db;
    const evt = db.prepare(`SELECT * FROM audit_events WHERE eventType='tool_reregistered'`).get() as { payload: string };
    expect(JSON.parse(evt.payload).implVersion).toEqual({ old: '0.1.0', new: '0.2.0' });
  });
});
