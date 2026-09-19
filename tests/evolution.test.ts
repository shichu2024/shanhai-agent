import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { REVIEW_ITEMS } from '../src/modules/registry.js';
import { EvolutionError } from '../src/modules/evolution.js';
import { redactEventPayload } from '../src/modules/redaction.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf } from './helpers.js';
import { ProviderError } from '../src/providers/types.js';

const validJson = JSON.stringify(validOutput());
const failing = JSON.stringify({ broken: true });

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function policiesOf(rt: Runtime, agentId: string): { allowed: boolean; triggers?: ('repeated_failure' | 'capability_degradation')[]; failureThreshold?: number } | null {
  for (const v of rt.registry.listVersions(agentId).slice().reverse()) {
    try {
      const spec = JSON.parse(v.specSnapshot) as { evolutionPolicy?: { allowed: boolean; triggers?: ('repeated_failure' | 'capability_degradation')[]; failureThreshold?: number } };
      if (spec.evolutionPolicy) return spec.evolutionPolicy;
    } catch { /* skip */ }
  }
  return null;
}

/** 造一个契约失败任务（Model(schema_violation) 终局，3 attempts） */
async function runFailingTask(h: ReturnType<typeof makeHarness>, agentId: string): Promise<void> {
  h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
  const t = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(t);
  expect(row.status).toBe('failed');
}

describe('DoD-⑥ Evolution 全链：agentId 聚类 → 阈值触发 → evidenceRefs 回链 → 确认 → review → release --no-pointer → canary', () => {
  it('repeated_failure 聚类达阈值 → 候选生成（幂等）+ failure_record.evolutionCandidateId 回填', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({
      agentId: 'ev-a',
      extraTop: { evolutionPolicy: { allowed: true, triggers: ['repeated_failure'], failureThreshold: 3, guardrails: { requireReviewed: true } } },
    });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'ev-a');

    const created = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    expect(created).toHaveLength(1);
    const candidate = h.rt.evolutions.get(created[0])!;
    expect(candidate.agentId).toBe('ev-a'); // 聚合键 = agentId（跨版本）
    expect(candidate.trigger).toBe('repeated_failure');
    expect(candidate.status).toBe('open');
    const refs = JSON.parse(candidate.evidenceRefs) as { taskId: string; agentVersionId: string; subClass: string }[];
    expect(refs).toHaveLength(3); // evidenceRefs 回链具体 taskId/agentVersionId
    expect(refs.every((r) => r.subClass === 'schema_violation')).toBe(true);

    // 预留列激活回填（A3 §4）：3 条 failure_record.evolutionCandidateId 指向候选
    const backfilled = dbOf(h.rt).prepare(`SELECT COUNT(*) c FROM failure_record WHERE evolutionCandidateId = ?`).get(candidate.candidateId) as { c: number };
    expect(backfilled.c).toBe(3);

    // 幂等：open 候选存在 → 不重复生成（仅同步回填）
    const again = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    expect(again).toEqual([]);
    expect(h.rt.evolutions.list()).toHaveLength(1);
  });

  it('未达阈值 / evolutionPolicy 缺省（allowed 未声明）→ 不生成', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ev-none' })); // 无 evolutionPolicy
    for (let i = 0; i < 5; i++) await runFailingTask(h, 'ev-none');
    expect(h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id))).toEqual([]); // 缺省 = 不产生候选

    const h2 = makeHarness([]);
    const spec = sampleSpec({ agentId: 'ev-low', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    registerAndRelease(h2.rt, spec);
    for (let i = 0; i < 2; i++) await runFailingTask(h2, 'ev-low');
    expect(h2.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h2.rt, id))).toEqual([]); // 2 < 3 阈值
  });

  it('infra 类失败不计入聚类（A4 §4 C2 排除口径同源）', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({ agentId: 'ev-infra', extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 2 } } });
    registerAndRelease(h.rt, spec);
    // 3 个 provider_infra 失败任务（每任务 3 attempts 全为 retryable infra 错误 → 耗尽终局）
    const infraError = new ProviderError('infra overloaded', 'overloaded', true);
    for (let i = 0; i < 3; i++) {
      h.provider.script.push({ kind: 'error', error: infraError }, { kind: 'error', error: infraError }, { kind: 'error', error: infraError });
    }
    for (let i = 0; i < 3; i++) {
      const t = h.rt.tasks.createTask('ev-infra', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    const infraCount = (dbOf(h.rt).prepare(`SELECT COUNT(*) c FROM failure_record WHERE subClass='provider_infra'`).get() as { c: number }).c;
    expect(infraCount).toBe(3); // infra 失败确实存在
    expect(h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id))).toEqual([]); // 但不计入聚类
  });

  it('全链：confirm（人工确认）→ 起草新版本 → review 检视门 → release --no-pointer → canary set → promote', async () => {
    const h = makeHarness([]);
    const v1Spec = sampleSpec({
      agentId: 'ev-full',
      extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3, guardrails: { requireReviewed: true } } },
    });
    const v1 = h.rt.registry.registerSpec(v1Spec, 'a', validationDepsOf(h.rt));
    h.rt.registry.release('ev-full', v1, 'a');
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'ev-full');
    const [candidateId] = h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));

    // 人工确认（D-14 人工确认制——系统永不自动注册/发布）
    const confirmed = h.rt.evolutions.confirm(candidateId, 'human', '收紧 outputContract 描述约束');
    expect(confirmed.status).toBe('confirmed');
    expect(() => h.rt.evolutions.confirm(candidateId, 'human')).toThrowError(EvolutionError); // 已裁决不可重复

    // 产物新版本人工起草（requireReviewed=true → 必经 review 检视门）
    const v2Spec = sampleSpec({ agentId: 'ev-full', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 }, extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3 } } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 'author', validationDepsOf(h.rt));
    h.rt.registry.review('ev-full', v2, 'reviewer', REVIEW_ITEMS.map((item) => ({ item, verdict: true })));
    expect(h.rt.registry.getVersion(v2)!.status).toBe('reviewed');
    h.rt.registry.release('ev-full', v2, 'a', { noPointer: true }); // canary 入口
    expect(h.rt.registry.getPointer('ev-full')).toBe(v1);
    h.rt.registry.canarySet('ev-full', v2, 50, 'op');
    expect(h.rt.registry.getCanary('ev-full')).toEqual({ canaryVersionId: v2, canaryWeight: 50 });
    const promoted = h.rt.registry.promote('ev-full', 'op'); // 判据为建议，决定权留人
    expect(promoted).toBe(v2);
    expect(h.rt.registry.getPointer('ev-full')).toBe(v2);
    expect(h.rt.registry.getCanary('ev-full')).toEqual({ canaryVersionId: null, canaryWeight: 0 });
  });
});

describe('DoD-⑦ requireReviewed 不可关闭断言', () => {
  it('guardrails.requireReviewed 显式 false → 注册拒绝（承诺=变更面受控留痕，不可关）', () => {
    const h = makeHarness();
    const off = sampleSpec({ agentId: 'ev-guard-off', extraTop: { evolutionPolicy: { allowed: true, guardrails: { requireReviewed: false } } } });
    try {
      h.rt.registry.registerSpec(off, 'a', validationDepsOf(h.rt));
      expect.unreachable('应当注册拒绝');
    } catch (err) {
      expect((err as { issues: { path: string; message: string }[] }).issues.some((i) => i.path.includes('evolutionPolicy') && i.message.includes('requireReviewed'))).toBe(true);
    }
    // 缺省 = true（合法）
    const dflt = sampleSpec({ agentId: 'ev-guard-def', extraTop: { evolutionPolicy: { allowed: true } } });
    expect(() => h.rt.registry.registerSpec(dflt, 'a', validationDepsOf(h.rt))).not.toThrow();
  });
});

describe('P3×2（批次二反方遗留）处置回归', () => {
  it('P3-① 信封同名键入口剥离：payload 携带 eventId/taskId 等不再覆写信封；bindingSnapshot 保真', () => {
    const out = redactEventPayload(
      {
        eventId: 'FAKE-EVENT-ID',
        taskId: 'FAKE-TASK-ID',
        eventType: 'task_paused',
        bindingSnapshot: { modelId: 'mock-model' }, // 合法载荷键——零改写保留
        note: 'plain',
      },
      { rules: [] },
    );
    expect(out.payload.eventId).toBeUndefined(); // 信封键剥离（TraceRecorder 唯一属主）
    expect(out.payload.taskId).toBeUndefined();
    expect(out.payload.eventType).toBeUndefined();
    expect((out.payload.bindingSnapshot as { modelId: string }).modelId).toBe('mock-model'); // 不在剥离集
    expect(out.payload.note).toBe('plain');
  });

  it('P3-② staleQueued 亚秒精度：createdAt 口径统一（锚点抬至 .999999999Z，同毫秒过窗不漏判）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'p3-stale' }));
    const taskId = h.rt.tasks.createTask('p3-stale', validInput, 't');
    // 构造 createdAt = 恰好过 7 天宽限窗 1ms（亚秒口径——修复前 toISOString 3 位毫秒锚点会漏判）
    const justPast = new Date(Date.now() - 7 * 24 * 3600 * 1000 - 5).toISOString();
    dbOf(h.rt).prepare(`UPDATE task_record SET createdAt = ? WHERE taskId = ?`).run(justPast, taskId);
    const report = h.rt.state.recover();
    expect(report.staleQueuedTasks).toContain(taskId); // 亚秒级过窗仍被判定
  });
});
