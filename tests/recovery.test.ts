import { describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf } from './helpers.js';
import { Runtime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type Database from 'better-sqlite3';

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

describe('A3 §6 崩溃恢复 + A6 §6.1 索引对账', () => {
  it('重启发现 Running 遗留 → Failed:Runtime(CrashRecovery)，补写 FailureRecord + Trace', () => {
    const { rt, dataDir } = makeHarness();
    registerAndRelease(rt, sampleSpec({ agentId: 'crash-a' }));
    const taskId = rt.tasks.createTask('crash-a', validInput, 't');
    dbOf(rt).prepare(`UPDATE task_record SET status='running', startedAt='2026-01-01T00:00:00Z' WHERE taskId=?`).run(taskId);
    rt.close();

    const rt2 = Runtime.withProvider(
      // @ts-expect-error 测试复用内部 provider
      { chat: async () => { throw new Error('不应被调用'); }, name: 'mock' },
      ['mock-model'], dataDir, process.cwd(),
    );
    const report = rt2.startup('restart');
    expect(report.crashMarkedTasks).toEqual([taskId]);
    const row = rt2.tasks.getTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Runtime(CrashRecovery)');
    const events = rt2.trace.readEvents(taskId).map((e) => e.eventType);
    expect(events).toContain('crash_recovery_marked');
    expect(events[events.length - 1]).toBe('task_failed');
    expect((rt2.failures.forTask(taskId) as { subClass: string }[]).at(-1)!.subClass).toBe('CrashRecovery');

    // 幂等：二次重启不再改写已终态记录
    const report2 = rt2.startup('restart2');
    expect(report2.crashMarkedTasks).toEqual([]);
    rt2.close();
  });

  it('F-1：Queued 遗留重启不迁移（A3 §6 收窄口径），可由后续进程 Queued→Running 正常执行至 Succeeded', async () => {
    // 进程 A（create）：仅创建任务，Queued 落库后退出
    const { rt, dataDir } = makeHarness();
    registerAndRelease(rt, sampleSpec({ agentId: 'f1-a' }));
    const taskId = rt.tasks.createTask('f1-a', validInput, 't');
    expect(rt.tasks.getTask(taskId).status).toBe('queued');
    rt.close();

    // 进程 B（run）：启动恢复扫描不得触碰 Queued；随后取出执行 → Succeeded
    const rt2 = Runtime.withProvider(
      new MockProvider([{ kind: 'text', text: validJson }]),
      ['mock-model'], dataDir, process.cwd(),
    );
    const report = rt2.startup('run-process');
    expect(report.crashMarkedTasks).toEqual([]); // F-1 核心：Queued 不被误判为 CrashRecovery
    expect(rt2.tasks.getTask(taskId).status).toBe('queued');
    const row = await rt2.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded');
    const events = rt2.trace.readEvents(taskId).map((e) => e.eventType);
    expect(events).not.toContain('crash_recovery_marked');
    rt2.close();
  });

  it('kill-9 窗口：JSONL 有事件但索引缺行 → 对账重建（以文件为唯一真源，幂等）', async () => {
    const { rt, dataDir } = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(rt, sampleSpec({ agentId: 'idx-a' }));
    const taskId = rt.tasks.createTask('idx-a', validInput, 't');
    await rt.tasks.runTask(taskId);

    // 模拟崩溃窗口：文件写入成功但索引行丢失（D-6 次序=先文件后索引）
    dbOf(rt).prepare(`DELETE FROM trace_index WHERE taskId = ?`).run(taskId);
    rt.close();

    const rt2 = Runtime.withProvider({ chat: async () => { throw new Error('不应被调用'); }, name: 'mock' } as never, ['mock-model'], dataDir, process.cwd());
    const report = rt2.startup('restart');
    expect(report.reconciledTasks).toEqual([taskId]);
    const count = dbOf(rt2).prepare(`SELECT COUNT(*) c FROM trace_index WHERE taskId=?`).get(taskId) as { c: number };
    expect(count.c).toBe(rt2.trace.readEvents(taskId).length);
    // 幂等：重复执行结果一致
    rt2.state.recover();
    const count2 = dbOf(rt2).prepare(`SELECT COUNT(*) c FROM trace_index WHERE taskId=?`).get(taskId) as { c: number };
    expect(count2.c).toBe(count.c);
    rt2.close();
  });

  it('对账先于崩溃标记：崩溃任务的 CrashRecovery Trace 追加在完整索引之上', () => {
    const { rt, dataDir } = makeHarness();
    registerAndRelease(rt, sampleSpec({ agentId: 'order-a' }));
    const taskId = rt.tasks.createTask('order-a', validInput, 't');
    // 手工补一条「文件有、索引无」的事件 + 遗留 running
    const events = rt.trace.readEvents(taskId);
    const orphan = { ...events[0], eventId: 'orphan-event-0001', eventType: 'task_queued' };
    appendFileSync(rt.trace.traceFile(taskId), JSON.stringify(orphan) + '\n', 'utf8');
    dbOf(rt).prepare(`UPDATE task_record SET status='running' WHERE taskId=?`).run(taskId);
    rt.close();

    const rt2 = Runtime.withProvider({ chat: async () => { throw new Error('x'); }, name: 'mock' } as never, ['mock-model'], dataDir, process.cwd());
    const report = rt2.startup('restart');
    expect(report.reconciledTasks).toContain(taskId);
    expect(report.crashMarkedTasks).toContain(taskId);
    // 索引行数 == 文件行数（崩溃标记事件也在索引内）
    const count = dbOf(rt2).prepare(`SELECT COUNT(*) c FROM trace_index WHERE taskId=?`).get(taskId) as { c: number };
    expect(count.c).toBe(rt2.trace.readEvents(taskId).length);
    rt2.close();
  });
});

describe('T3 发布安全', () => {
  it('ModelGateway 无配置即拒绝启动（fail-fast）', async () => {
    const { ConfigError, loadRuntimeConfig } = await import('../src/config.js');
    expect(() => loadRuntimeConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadRuntimeConfig({ SHANHAI_CONFIG: 'Z:/missing.json' } as unknown as NodeJS.ProcessEnv)).toThrow(/未找到配置文件/);
  });

  it('发布扫描：植入密钥与权重文件命中即非零，干净目录零命中', async () => {
    const { scanForRelease } = await import('../src/scripts/releaseScan.js');
    const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const dir = mkdtempSync(path.join(tmpdir(), 'scan-'));
    // 拆分构造密钥样例：源码中不得出现完整密钥模式（T3 扫描零命中）
    const fakeSecret = ['sk-ant-api', '03-xxxxxxxxxx', 'xxxxxxxxxxxxxx'].join('');
    wf(path.join(dir, 'leak.js'), `const k = "${fakeSecret}";\n`);
    wf(path.join(dir, 'model.gguf'), 'binary');
    // F-4：魔数检查——权重文件改名（无权重扩展名）后仍须命中
    wf(path.join(dir, 'renamed-weight.dat'), Buffer.from([0x47, 0x47, 0x55, 0x46, 0x00, 0x01, 0x02, 0x03]));
    const findings = scanForRelease(dir);
    expect(findings.some((f) => f.kind === 'secret')).toBe(true);
    expect(findings.some((f) => f.kind === 'model_weight')).toBe(true);
    expect(findings.some((f) => f.kind === 'model_weight' && f.file === 'renamed-weight.dat')).toBe(true);
    const clean = mkdtempSync(path.join(tmpdir(), 'scan-clean-'));
    wf(path.join(clean, 'ok.ts'), 'export const x = 1;\n');
    expect(scanForRelease(clean)).toEqual([]);
  });
});
