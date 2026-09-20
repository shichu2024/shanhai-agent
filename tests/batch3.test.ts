import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { buildAgentReport } from '../src/modules/report.js';
import { RegistrationError } from '../src/modules/registry.js';
import { EvolutionError } from '../src/modules/evolution.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf } from './helpers.js';

// 批次三（§4.4 演进同源 + §4.5 治理判据，D-22~D-25）：TDD 红阶段用例。
// 结构断言沿用批次一/二已认可形态（源文本级机械断言——防再漂移）。

const validJson = JSON.stringify(validOutput());
const failing = JSON.stringify({ broken: true });
const srcDir = path.resolve(process.cwd(), 'src');
const readSrc = (rel: string): string => readFileSync(path.join(srcDir, rel), 'utf8');

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function setRoll(rt: Runtime, roll: number): void {
  (rt.tasks as unknown as { deps: { dispatchRoll?: () => number } }).deps.dispatchRoll = () => roll;
}

/** 双版本基座：v1 Released（current）+ v2 Released --no-pointer */
function setupTwoVersions(h: ReturnType<typeof makeHarness>, agentId: string): { v1: string; v2: string } {
  const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId }), 'a', validationDepsOf(h.rt));
  h.rt.registry.release(agentId, v1, 'a');
  const v2Spec = sampleSpec({ agentId, modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } });
  const v2 = h.rt.registry.registerSpec(v2Spec, 'a', validationDepsOf(h.rt));
  h.rt.registry.release(agentId, v2, 'a', { noPointer: true });
  return { v1, v2 };
}

/** 单一实现的 policiesOf 消费点（§4.5-6：测试侧消费 registry 导出，不再手写遍历） */
function policiesOf(rt: Runtime, agentId: string) {
  return rt.registry.evolutionPolicyOf(agentId);
}

/** 造一个契约失败任务（Model(schema_violation) 终局） */
async function runFailingTask(h: ReturnType<typeof makeHarness>, agentId: string): Promise<void> {
  h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
  const t = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(t);
  expect(row.status).toBe('failed');
}

// ---------- §4.4-1 单一常量源（三处消费点结构断言） ----------

describe('§4.4-1 演进清单同源化（A-9 结构断言）', () => {
  it('subclassRegistry 常量源存在且被三处消费点 import 同一符号（evolution 常量 / evolution SQL / report 白名单）', async () => {
    const mod = await import('../src/modules/subclassRegistry.js');
    expect([...mod.EXCLUDED_FROM_CONTRACT_RATE]).toEqual(['provider_infra', 'provider_rejected_schema']);
    expect(mod.CONTRACT_RATE_SUBCLASSES).toHaveLength(6); // report 白名单（A4 §1）

    const evo = readSrc('modules/evolution.ts');
    expect(evo).toContain("from './subclassRegistry.js'"); // 消费点①+②（常量与 SQL 参数化同源）
    expect(evo).not.toContain("new Set(['provider_infra'"); // 本地双份消亡
    expect(evo).not.toContain(`NOT IN ('provider_infra'`); // SQL 硬编码双份消亡

    const rec = readSrc('modules/recorders.ts');
    expect(rec).toContain("from './subclassRegistry.js'"); // 消费点③（countedInContractRate 白名单）
  });

  it('行为等价：排除集过滤与常量源一致（非排除子类照常聚类）', async () => {
    const mod = await import('../src/modules/subclassRegistry.js');
    const h = makeHarness([]);
    const spec = sampleSpec({
      agentId: 'src-a',
      extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } },
    });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'src-a');
    // schema_violation ∉ 排除集 → 聚类照常
    const created = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    expect(created).toHaveLength(1);
    // 排除集与 C2 口径同源：SQL 过滤集 = 常量导出集
    const rows = dbOf(h.rt).prepare(`SELECT DISTINCT subClass FROM failure_record`).all() as { subClass: string }[];
    for (const r of rows) {
      expect((mod.EXCLUDED_FROM_CONTRACT_RATE as readonly string[]).includes(r.subClass) || r.subClass === 'schema_violation').toBe(true);
    }
  });
});

// ---------- §4.4-3 derivedVersionIds + --from-candidate ----------

describe('§4.4-3 候选↔版本关联（derivedVersionIds 显式回填）', () => {
  it('confirm 后 attachDerivedVersion 回填 versionId；重复回填不重复；未知候选结构化拒绝', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({ agentId: 'dv-a', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    const v1 = registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'dv-a');
    const [candidateId] = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    h.rt.evolutions.confirm(candidateId, 'human', '收紧契约');

    // 人工起草新版本 → 显式回填（不自动关联）
    const v2Spec = sampleSpec({ agentId: 'dv-a', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 }, extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 'author', validationDepsOf(h.rt));

    const row = h.rt.evolutions.attachDerivedVersion(candidateId, v2);
    expect(JSON.parse(row.derivedVersionIds)).toEqual([v2]);

    // 幂等：重复回填不重复
    const again = h.rt.evolutions.attachDerivedVersion(candidateId, v2);
    expect(JSON.parse(again.derivedVersionIds)).toEqual([v2]);

    // 未知候选 → 结构化拒绝
    expect(() => h.rt.evolutions.attachDerivedVersion('no-such-candidate', v1)).toThrowError(EvolutionError);

    // CLI 接线：register 支持 --from-candidate
    expect(readSrc('cli.ts')).toContain('--from-candidate');
  });

  it('存量库零回填：新列默认 []（ALTER TABLE ADD COLUMN，不改既有行语义）', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({ agentId: 'dv-b', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'dv-b');
    const [candidateId] = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    const row = h.rt.evolutions.get(candidateId)!;
    expect(JSON.parse(row.derivedVersionIds)).toEqual([]); // 默认空数组
    expect(row.dismissedAt).toBeNull(); // §4.5-4 新列默认 NULL
  });
});

// ---------- §4.5-1 rollback×canary 互斥 ----------

describe('§4.5-1 rollback×canary 互斥（A-7）', () => {
  it('rollback 至 canary 指针目标 → 结构化拒绝（与 deprecate P2-6 对称）+ RejectedRequest 审计', () => {
    const h = makeHarness([]);
    const { v1, v2 } = setupTwoVersions(h, 'rbx-a');
    h.rt.registry.canarySet('rbx-a', v2, 50, 'op');
    // 第三个 Released 版本（--no-pointer）作合法回滚目标
    const v3Spec = sampleSpec({ agentId: 'rbx-a', modelPolicy: { maxModelCalls: 12, maxTokens: 100000 } });
    const v3 = h.rt.registry.registerSpec(v3Spec, 'a', validationDepsOf(h.rt));
    h.rt.registry.release('rbx-a', v3, 'a', { noPointer: true });

    try {
      h.rt.registry.rollback('rbx-a', v2, 'op');
      expect.unreachable('应当拒绝 rollback 至 canary 目标');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistrationError);
      expect((err as Error).message).toContain('canary'); // 消息口径与 deprecate 同款（先 clear 或换目标）
    }
    // 结构化拒绝留痕（rejected_request 审计）
    const rej = dbOf(h.rt).prepare(`SELECT COUNT(*) c FROM audit_events WHERE eventType = 'rejected_request'`).get() as { c: number };
    expect(rej.c).toBeGreaterThanOrEqual(1);
    // 指针未动（非法态 current==canary 未发生）
    expect(h.rt.registry.getPointer('rbx-a')).toBe(v1);

    // 非 canary 目标照常可回滚
    expect(() => h.rt.registry.rollback('rbx-a', v3, 'op')).not.toThrow();
    expect(h.rt.registry.getPointer('rbx-a')).toBe(v3);
  });
});

// ---------- §4.5-2 report 分母排除 cancelled + 分母零基线 ----------

describe('§4.5-2 report 分母口径（A-8）', () => {
  it('cancelled 不进分母：excludedCancelled 计数可见、通过率按 tasks−cancelled 复算', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'den-a' }));
    // 3 任务：1 成功 + 1 契约失败 + 1 成功后被治理性取消
    h.provider.script.push({ kind: 'text', text: validJson });
    const ok1 = h.rt.tasks.createTask('den-a', validInput, 't');
    await h.rt.tasks.runTask(ok1);
    h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
    const bad = h.rt.tasks.createTask('den-a', validInput, 't');
    await h.rt.tasks.runTask(bad);
    h.provider.script.push({ kind: 'text', text: validJson });
    const ok2 = h.rt.tasks.createTask('den-a', validInput, 't');
    await h.rt.tasks.runTask(ok2);
    dbOf(h.rt).prepare(`UPDATE task_record SET status = 'cancelled', cancelReason = 'user' WHERE taskId = ?`).run(ok2);

    const report = buildAgentReport(dbOf(h.rt), 'den-a');
    const stable = report.groups.find((g) => g.assignmentSource === 'stable')!;
    expect(stable.tasks).toBe(3); // 原始计数不变（口径可见）
    expect(stable.excludedCancelled).toBe(1); // 排除计数可见、可复算
    expect(stable.contractFailures).toBe(1);
    expect(stable.contractPassRate).toBe(0.5); // 分母 = 3−1 = 2；(2−1)/2
  });

  it('分母零基线：小组全为治理性取消 → contractPassRate null + promote 判据 insufficient-sample（不假装给答案）', async () => {
    const h = makeHarness([], process.cwd(), { dispatchRoll: () => 0 });
    const { v2 } = setupTwoVersions(h, 'den-b');
    h.rt.registry.canarySet('den-b', v2, 100, 'op');
    h.provider.script.push(...Array.from({ length: 20 }, () => ({ kind: 'text' as const, text: validJson })));
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = h.rt.tasks.createTask('den-b', validInput, 't');
      await h.rt.tasks.runTask(t);
      ids.push(t);
    }
    const stmt = dbOf(h.rt).prepare(`UPDATE task_record SET status = 'cancelled', cancelReason = 'user' WHERE taskId = ?`);
    for (const t of ids) stmt.run(t);

    const report = buildAgentReport(dbOf(h.rt), 'den-b');
    const canary = report.groups.find((g) => g.assignmentSource === 'canary')!;
    expect(canary.tasks).toBe(20);
    expect(canary.excludedCancelled).toBe(20);
    expect(canary.contractPassRate).toBeNull(); // 分母零 → 无分母不假装
    expect(report.promoteCriteria.status).toBe('insufficient-sample');
    expect(report.promoteCriteria.threshold).toContain('治理性取消'); // 分母零基线专属口径
  });
});

// ---------- §4.5-3 跨轮灰度混叠警示列 ----------

describe('§4.5-3 跨轮警示列（可见性方案，不自动切窗）', () => {
  it('判据窗口内存在轮次边界事件 → window-straddles-rounds + 边界时间戳；--since 收窗后消除', async () => {
    const h = makeHarness([]);
    const { v2 } = setupTwoVersions(h, 'strd-a');
    h.rt.registry.canarySet('strd-a', v2, 50, 'op'); // 轮次边界①（canary_configured）
    setRoll(h.rt, 0);
    h.provider.script.push({ kind: 'text', text: validJson });
    const t = h.rt.tasks.createTask('strd-a', validInput, 't');
    await h.rt.tasks.runTask(t);
    h.rt.registry.canaryClear('strd-a', 'op'); // 轮次边界②（窗口内 clear）

    const report = buildAgentReport(dbOf(h.rt), 'strd-a');
    expect(report.sideColumns.canaryRounds.warning).toBe('window-straddles-rounds');
    const types = report.sideColumns.canaryRounds.boundaryEvents.map((e: { eventType: string }) => e.eventType);
    expect(types).toContain('canary_configured');
    expect(report.sideColumns.canaryRounds.boundaryEvents.every((e: { whenAt: string }) => typeof e.whenAt === 'string')).toBe(true);

    // 操作者自行 --since 收窗（边界事件在窗口外 → 不再警示）
    const future = buildAgentReport(dbOf(h.rt), 'strd-a', { since: '2999-01-01T00:00:00Z' });
    expect(future.sideColumns.canaryRounds.warning).toBeNull();
    expect(future.sideColumns.canaryRounds.boundaryEvents).toEqual([]);
  });
});

// ---------- §4.5-4 dismiss 冷却 ----------

describe('§4.5-4 dismiss 冷却（A-10）', () => {
  it('冷却窗内同 agentId+trigger 不重生候选；到期恢复生成（不静默吞）', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({ agentId: 'cd-a', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'cd-a');
    const [candidateId] = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    h.rt.evolutions.dismiss(candidateId, 'human');
    expect(h.rt.evolutions.get(candidateId)!.dismissedAt).toBeTruthy(); // dismissedAt 落库

    // 冷却窗内（默认 7 天）：同证据集不立即重生
    expect(h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id))).toEqual([]);
    expect(h.rt.evolutions.list().filter((c) => c.status === 'open')).toHaveLength(0);

    // 冷却到期（dismissedAt 推到 8 天前）：候选恢复生成（再出，不静默吞）
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '.000000000Z');
    dbOf(h.rt).prepare(`UPDATE evolution_candidate SET dismissedAt = ? WHERE candidateId = ?`).run(past, candidateId);
    const regenerated = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    expect(regenerated).toHaveLength(1);
    expect(h.rt.evolutions.get(regenerated[0])!.candidateId).not.toBe(candidateId); // 新候选（旧 dismissed 行保留）
  });

  it('冷却窗运行时可配（config.local.json evolution.dismissCooldownDays，D-25）；0 = 即时允许重生', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({ agentId: 'cd-b', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'cd-b');
    const [candidateId] = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    h.rt.evolutions.dismiss(candidateId, 'human');

    const { EvolutionManager } = await import('../src/modules/evolution.js');
    const zero = new EvolutionManager({ db: dbOf(h.rt), dismissCooldownDays: 0 }); // 冷却窗配置 = 0
    expect(zero.aggregateRepeatedFailures((id) => policiesOf(h.rt, id))).toHaveLength(1);

    // CLI/配置接线：config 载体（D-25：config.local.json 新段）
    expect(readSrc('config.ts')).toContain('dismissCooldownDays');
  });
});

// ---------- §4.5-5/6 policiesOf 回溯语义成文 + 实现收敛 ----------

describe('§4.5-5/6 policiesOf（D-24）', () => {
  it('实现收敛：registry.evolutionPolicyOf 单一实现——回溯全量倒序、已弃用版本声明仍统治', () => {
    const h = makeHarness([]);
    const v1Spec = sampleSpec({ agentId: 'po-a', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 5 } } });
    const v1 = h.rt.registry.registerSpec(v1Spec, 'a', validationDepsOf(h.rt));
    h.rt.registry.release('po-a', v1, 'a');
    const v2Spec = sampleSpec({ agentId: 'po-a', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } }); // 无 evolutionPolicy 声明
    const v2 = h.rt.registry.registerSpec(v2Spec, 'a', validationDepsOf(h.rt));
    h.rt.registry.release('po-a', v2, 'a'); // 指针 → v2

    // 回溯：v2 未声明 → 取 v1 声明（不按指针静默失效）
    expect(policiesOf(h.rt, 'po-a')).toMatchObject({ allowed: true, failureThreshold: 5 });

    // 边角语义：v1 被弃用后其声明仍统治（不按版本状态过滤）
    h.rt.registry.deprecate('po-a', v1, 'a');
    expect(policiesOf(h.rt, 'po-a')).toMatchObject({ allowed: true, failureThreshold: 5 });

    // 未声明且无可回溯声明 → null（行为等同不产生候选，非缺省写入 false）
    registerAndRelease(h.rt, sampleSpec({ agentId: 'po-b' }));
    expect(policiesOf(h.rt, 'po-b')).toBeNull();
  });

  it('结构断言：CLI 与测试两处消费同一 registry 导出（本地手写实现消亡）', () => {
    const cli = readSrc('cli.ts');
    expect(cli).toContain('evolutionPolicyOf'); // CLI 消费 registry 单一实现
    expect(cli).not.toContain('listVersions(agentId).slice().reverse()'); // 手写遍历消亡
    const evoTest = readFileSync(path.resolve(process.cwd(), 'tests/evolution.test.ts'), 'utf8');
    expect(evoTest).toContain('evolutionPolicyOf'); // 测试侧消费同一实现
  });
});

// ---------- 成文面（A1 §2.3 / A5 report 注记）机械断言 ----------

describe('§4.5-5/2 成文面机械断言', () => {
  it('A1 §2.3 回溯语义注记完整在场（含已弃用版本仍统治边角 + 缺省表述修正）', () => {
    const a1 = readFileSync(path.resolve(process.cwd(), 'docs/spec/A1-Spec-Schema-v1.md'), 'utf8');
    expect(a1).toContain('evolutionPolicyOf');
    expect(a1).toContain('已弃用');
    expect(a1).toContain('不按指针位置、不按版本状态');
    expect(a1).toContain('未声明且无可回溯声明');
  });

  it('A5 report 分母口径注记在场（D-23：排除 cancelled + excludedCancelled 可复算 + 分母零基线）', () => {
    const a5 = readFileSync(path.resolve(process.cwd(), 'docs/spec/A5-版本状态机.md'), 'utf8');
    expect(a5).toContain('excludedCancelled');
    expect(a5).toContain('tasks − cancelled');
    expect(a5).toContain('治理性取消');
  });
});

// ---------- D-14 幂等/聚合行为零变更回归（DoD-⑥） ----------

describe('D-14 冻结零变更回归（聚合键=agentId，幂等键=agentId+trigger）', () => {
  it('open 候选存在时重聚合不重复生成（幂等）；多 subClass 同超阈值 → 第二子类证据回填既有候选', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({ agentId: 'd14-a', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'd14-a');
    const created = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    expect(created).toHaveLength(1);
    // 幂等：open 在 → 只同步回填
    expect(h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id))).toEqual([]);
    expect(h.rt.evolutions.list()).toHaveLength(1);

    // §4.4-2 注释口径成文：幂等键 = agentId+trigger（subClass 不拆候选——设计语义成文断言）
    expect(readSrc('modules/evolution.ts')).toContain('幂等键 = agentId + trigger');
  });
});
