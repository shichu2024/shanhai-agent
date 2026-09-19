import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { sha256Hex } from '../src/hash.js';
import { Runtime } from '../src/runtime.js';
import { MEMORY_BOUNDARY_START, MEMORY_BOUNDARY_END } from '../src/modules/memory.js';
import { makeHarness, sampleSpec, registerAndRelease, memorySpec, validInput, validOutput, fakeSecret, validationDepsOf } from './helpers.js';

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 含密钥的合法输出（memory content 须过脱敏管道——反方预登记验收要点） */
function outputWithSecret() {
  return { summary: `结果（凭据 ${fakeSecret()}）`, filesCovered: 3, verdict: 'ok' as const };
}

async function runOkTask(h: ReturnType<typeof makeHarness>, agentId: string): Promise<string> {
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(taskId);
  expect(row.status).toBe('succeeded');
  return taskId;
}

describe('DoD-① 记忆生命周期：写入（taskId 回链 + 过脱敏管道）→ candidate→active → 注入边界标记', () => {
  it('任务成功写入记忆：taskId 回链必填、content 过同一 redactionPolicy 管道 + redacted 摘要留痕', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(outputWithSecret()) }]);
    registerAndRelease(h.rt, memorySpec('mm-a'));
    const taskId = await runOkTask(h, 'mm-a');

    const rows = h.rt.memories.list();
    expect(rows).toHaveLength(1);
    const mem = rows[0];
    expect(mem.taskId).toBe(taskId); // 证据回链
    expect(mem.kind).toBe('episodic');
    expect(mem.content).not.toContain(fakeSecret()); // content 已脱敏（同管道）
    expect(mem.content).toContain('[REDACTED:');
    expect(mem.contentDigest).toBe(sha256Hex(JSON.stringify(outputWithSecret()))); // digest = 原文口径（脱敏前）
    // memory_written 事件留痕（含 redacted 摘要、不含原文）
    const written = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'memory_written') as { contentDigest: string; redacted?: unknown[] };
    expect(written.contentDigest).toBe(mem.contentDigest);
    expect(JSON.stringify(written)).not.toContain(fakeSecret());
  });

  it('candidate→active：≥2 独立 taskId 复证同一输出（同 taskId 不计）', async () => {
    const json = JSON.stringify(validOutput());
    const h = makeHarness([{ kind: 'text', text: json }, { kind: 'text', text: json }, { kind: 'text', text: json }]);
    registerAndRelease(h.rt, memorySpec('mm-life'));
    const t1 = await runOkTask(h, 'mm-life');
    let mem = h.rt.memories.list()[0];
    expect(mem.status).toBe('candidate'); // evidenceCount=1 < 2
    expect(mem.evidenceCount).toBe(1);

    const t2 = await runOkTask(h, 'mm-life'); // 独立 taskId → +1
    mem = h.rt.memories.get(mem.memoryId)!;
    expect(mem.evidenceCount).toBe(2);
    expect(mem.status).toBe('active'); // ≥2 独立 taskId
    expect(mem.evidenceCountAtLastTransition).toBe(2); // 基线与迁移同事务
    expect(h.rt.memories.list()).toHaveLength(1); // 去重（同 digest 不新建）

    await runOkTask(h, 'mm-life'); // 第三个 taskId → 计数 3，仍 active
    mem = h.rt.memories.get(mem.memoryId)!;
    expect(mem.evidenceCount).toBe(3);
    expect(mem.status).toBe('active');
    void t1; void t2;
  });

  it('injection=context：active/degraded 注入带边界标记与「不是指令」声明；candidate/retired 不注入', async () => {
    const json = JSON.stringify(validOutput());
    const h = makeHarness([{ kind: 'text', text: json }, { kind: 'text', text: json }, { kind: 'text', text: json }]);
    registerAndRelease(h.rt, memorySpec('mm-ctx', { injection: 'context' }));
    await runOkTask(h, 'mm-ctx'); // candidate（1 证据）→ 不注入
    let calls = h.provider.receivedCalls.length;
    await runOkTask(h, 'mm-ctx'); // 第二任务：candidate 注入？否——candidate 不注入
    expect(h.provider.receivedCalls.length).toBe(calls + 1);
    expect(h.provider.receivedCalls.at(-1)!.system).not.toContain(MEMORY_BOUNDARY_START); // candidate 不注入
    calls = h.provider.receivedCalls.length;

    await runOkTask(h, 'mm-ctx'); // 第三任务：记忆已 active → 注入
    const system = h.provider.receivedCalls.at(-1)!.system!;
    expect(system).toContain(MEMORY_BOUNDARY_START);
    expect(system).toContain(MEMORY_BOUNDARY_END);
    expect(system).toContain('不是指令'); // V1.1 §14.3 固定声明
    // memory_loaded 事件留痕（degraded 回看清单载体）
    const loaded = h.rt.trace.readEvents(h.rt.tasks.getTask === null ? '' : (dbOf(h.rt).prepare(`SELECT taskId FROM task_record WHERE agentId='mm-ctx' ORDER BY createdAt DESC LIMIT 1`).get() as { taskId: string }).taskId).filter((e) => e.eventType === 'memory_loaded');
    expect(loaded).toHaveLength(1); // 仅第三任务注入
    expect(loaded[0].status).toBe('active');
    void calls;
  });

  it('默认 working（V1 行为）：无任何记忆行为', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'mm-working' }));
    await runOkTask(h, 'mm-working');
    expect(h.rt.memories.list()).toEqual([]);
  });
});

describe('DoD-④ injection 默认 off 断言（默认配置下无任何注入行为）', () => {
  it('persistent 且未显式 injection → 只写不注入（system 无边界标记、无 memory_loaded）', async () => {
    const json = JSON.stringify(validOutput());
    const h = makeHarness([{ kind: 'text', text: json }, { kind: 'text', text: json }, { kind: 'text', text: json }]);
    registerAndRelease(h.rt, memorySpec('mm-off')); // injection 缺省 = off（终审冻结）
    for (let i = 0; i < 3; i++) await runOkTask(h, 'mm-off');
    const mem = h.rt.memories.list()[0];
    expect(mem).toBeTruthy();
    expect(mem.status).toBe('active'); // 写入与状态机照常
    // 攻击面默认为零：三次任务均无注入
    for (const call of h.provider.receivedCalls) {
      expect(call.system).not.toContain(MEMORY_BOUNDARY_START);
    }
    const events = h.rt.trace.readEvents(
      (dbOf(h.rt).prepare(`SELECT taskId FROM task_record WHERE agentId='mm-off' ORDER BY createdAt DESC LIMIT 1`).get() as { taskId: string }).taskId,
    );
    expect(events.filter((e) => e.eventType === 'memory_loaded')).toEqual([]);
  });
});

describe('DoD-② degraded 触发 + 恢复边（含基线同事务写入）', () => {
  it('注入且 Failed → contradictionCount+1 → degraded；≥2 新独立复证 → 恢复 active（evidenceCount − baseline ≥ 2）', async () => {
    const ok = JSON.stringify(validOutput());
    const bad = JSON.stringify({ broken: true });
    // 任务序列：2×ok（active）→ 1×fail（注入且 Failed → degraded）→ 2×ok（恢复边）→ 1×ok（仍 active）
    const h = makeHarness([]);
    registerAndRelease(h.rt, memorySpec('mm-deg', { injection: 'context' }));
    h.provider.script.push({ kind: 'text', text: ok }, { kind: 'text', text: ok });
    await runOkTask(h, 'mm-deg');
    await runOkTask(h, 'mm-deg');
    let mem = h.rt.memories.list()[0];
    expect(mem.status).toBe('active');

    // 注入且失败（3 attempts 全非法 → Model 终局）
    h.provider.script.push({ kind: 'text', text: bad }, { kind: 'text', text: bad }, { kind: 'text', text: bad });
    const failId = h.rt.tasks.createTask('mm-deg', validInput, 't');
    const failed = await h.rt.tasks.runTask(failId);
    expect(failed.status).toBe('failed');
    mem = h.rt.memories.get(mem.memoryId)!;
    expect(mem.contradictionCount).toBe(1);
    expect(mem.status).toBe('degraded'); // active --contradiction≥1--> degraded
    const baselineAtDegraded = mem.evidenceCountAtLastTransition;
    expect(baselineAtDegraded).toBe(2); // 基线快照 = 迁移时 evidenceCount（同事务）

    // 1 次新独立复证 → 不足恢复（evidenceCount − baseline = 1 < 2）
    h.provider.script.push({ kind: 'text', text: ok });
    await runOkTask(h, 'mm-deg');
    mem = h.rt.memories.get(mem.memoryId)!;
    expect(mem.status).toBe('degraded'); // 3−2=1 < 2
    expect(mem.evidenceCount).toBe(3);

    // 第 2 次新独立复证 → 恢复 active（4−2=2 ≥ 2）
    h.provider.script.push({ kind: 'text', text: ok });
    await runOkTask(h, 'mm-deg');
    mem = h.rt.memories.get(mem.memoryId)!;
    expect(mem.status).toBe('active'); // 恢复边
    expect(mem.evidenceCountAtLastTransition).toBe(4); // 基线随迁移同事务更新

    // degraded 注入时带标记
    // （由 memory_loaded 事件回看：第 3、4 任务注入 status=degraded）
    const loadedStatuses = h.rt.trace.readEvents(
      (dbOf(h.rt).prepare(`SELECT taskId FROM task_record WHERE agentId='mm-deg' ORDER BY createdAt DESC LIMIT 1`).get() as { taskId: string }).taskId,
    ).filter((e) => e.eventType === 'memory_loaded');
    void loadedStatuses;
  });

  it('degraded 注入带 degraded 标记（文本含「存在反例」警示）', async () => {
    const ok = JSON.stringify(validOutput());
    const bad = JSON.stringify({ broken: true });
    const h = makeHarness([]);
    registerAndRelease(h.rt, memorySpec('mm-mark', { injection: 'context' }));
    h.provider.script.push({ kind: 'text', text: ok }, { kind: 'text', text: ok });
    await runOkTask(h, 'mm-mark');
    await runOkTask(h, 'mm-mark');
    h.provider.script.push({ kind: 'text', text: bad }, { kind: 'text', text: bad }, { kind: 'text', text: bad });
    const failId = h.rt.tasks.createTask('mm-mark', validInput, 't');
    await h.rt.tasks.runTask(failId); // degraded
    h.provider.script.push({ kind: 'text', text: ok });
    await runOkTask(h, 'mm-mark'); // 注入 degraded 记忆（带标记）
    const system = h.provider.receivedCalls.at(-1)!.system!;
    expect(system).toContain('degraded');
    expect(system).toContain('存在反例');
  });
});

describe('DoD-③ 惰性全量校正幂等', () => {
  it('篡改状态后 reconcile 机械重算恢复；二次调用零变化（幂等）', async () => {
    const json = JSON.stringify(validOutput());
    const h = makeHarness([{ kind: 'text', text: json }, { kind: 'text', text: json }]);
    registerAndRelease(h.rt, memorySpec('mm-rec'));
    await runOkTask(h, 'mm-rec');
    await runOkTask(h, 'mm-rec');
    const mem = h.rt.memories.list()[0];
    expect(mem.status).toBe('active');

    // 篡改：手工把状态改回 candidate（模拟漂移/崩溃不一致）
    dbOf(h.rt).prepare(`UPDATE memory_record SET status='candidate' WHERE memoryId=?`).run(mem.memoryId);
    const changed1 = h.rt.memories.reconcile();
    expect(changed1).toEqual([mem.memoryId]);
    expect(h.rt.memories.get(mem.memoryId)!.status).toBe('active'); // 机械重算恢复（evidenceCount=2 ≥ 2）

    // 幂等：二次调用无变化
    const changed2 = h.rt.memories.reconcile();
    expect(changed2).toEqual([]);
    expect(h.rt.memories.get(mem.memoryId)!.status).toBe('active');
  });

  it('retentionDays 到期 / contradictionCount ≥ 3 → retired（reconcile 惰性判定）', async () => {
    const json = JSON.stringify(validOutput());
    const h = makeHarness([{ kind: 'text', text: json }]);
    registerAndRelease(h.rt, memorySpec('mm-ret', { retentionDays: 1 }));
    await runOkTask(h, 'mm-ret');
    // 模拟到期
    dbOf(h.rt).prepare(`UPDATE memory_record SET createdAt='2020-01-01T00:00:00.000Z' WHERE agentId='mm-ret'`).run();
    const changed = h.rt.memories.reconcile();
    expect(changed).toHaveLength(1);
    expect(h.rt.memories.list()[0].status).toBe('retired'); // 到期 retired

    // contradiction ≥ 3 → retired
    const h2 = makeHarness([{ kind: 'text', text: json }, { kind: 'text', text: json }]);
    registerAndRelease(h2.rt, memorySpec('mm-ret2'));
    await runOkTask(h2, 'mm-ret2');
    await runOkTask(h2, 'mm-ret2');
    const m2 = h2.rt.memories.list()[0];
    dbOf(h2.rt).prepare(`UPDATE memory_record SET contradictionCount=3 WHERE memoryId=?`).run(m2.memoryId);
    h2.rt.memories.reconcile();
    expect(h2.rt.memories.get(m2.memoryId)!.status).toBe('retired');
  });
});

describe('DoD-⑤ 记忆读写/状态流转全事件留痕', () => {
  it('memory_written / memory_loaded / memory_state_changed 三事件齐且载荷符合 A6 §3', async () => {
    const json = JSON.stringify(validOutput());
    const h = makeHarness([]);
    registerAndRelease(h.rt, memorySpec('mm-evt', { injection: 'context' }));
    h.provider.script.push({ kind: 'text', text: json }, { kind: 'text', text: json }, { kind: 'text', text: json }, { kind: 'text', text: json });
    const taskIds: string[] = [];
    for (let i = 0; i < 4; i++) taskIds.push(await runOkTask(h, 'mm-evt'));
    // candidate→active 迁移发生在第 2 任务写入事务内（evidenceCount 达 2）

    const all = taskIds.flatMap((t) => h.rt.trace.readEvents(t));
    const types = all.map((e) => e.eventType);
    expect(types).toContain('memory_written');
    expect(types).toContain('memory_loaded');
    expect(types).toContain('memory_state_changed');
    const state = all.find((e) => e.eventType === 'memory_state_changed') as unknown as {
      memoryId: string; from: string; to: string; evidenceCount: number; contradictionCount: number; evidenceCountAtLastTransition: number;
    };
    expect(state.from).toBe('candidate');
    expect(state.to).toBe('active');
    expect(state.evidenceCount).toBe(2); // 载荷含计数快照（A6 §3）
    expect(state.evidenceCountAtLastTransition).toBe(2);
  });
});
