import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../src/hash.js';
import { SECRET_PATTERNS } from '../src/scripts/releaseScan.js';
import { redactEventPayload } from '../src/modules/redaction.js';
import { queryT1, queryT2 } from '../src/evidence.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput } from './helpers.js';

// A6 §8 v1.1（D-11）：写入时脱敏、原文不落盘；排除表零改写；digest 脱敏前按原文计算（跨任务对账稳定）。
// 注意：测试源码不得出现完整密钥模式（T3 扫描零命中）——样例拆分构造（recovery.test.ts 同惯例）。

/** 拆分构造密钥样例（源码零完整模式命中） */
function fakeSecret(): string {
  return ['sk-ant-api', '03-xxxxxxxxxx', 'xxxxxxxxxxxxxx'].join('');
}

/** 含密钥的合法输出（outputContract: summary 为 string） */
function outputWithSecret() {
  return { summary: `结果摘要（含凭据 ${fakeSecret()}，请勿外传）`, filesCovered: 3, verdict: 'ok' as const };
}

describe('DoD-① 脱敏排除表：信封 / bindingSnapshot / *Digest 字段零改写', () => {
  it('载荷中密钥与 email 被改写为 [REDACTED:*]，排除表字段与 digest 原样保留', async () => {
    const output = outputWithSecret();
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(output) }]);
    const versionId = registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-excl' }));
    const inputWithSecret = { topic: `联系人 a@corp.com 与凭据 ${fakeSecret()}` };
    const taskId = h.rt.tasks.createTask('rd-excl', inputWithSecret, 't');
    await h.rt.tasks.runTask(taskId);

    const events = h.rt.trace.readEvents(taskId);
    const line = readFileSync(h.rt.trace.traceFile(taskId), 'utf8');
    expect(line).not.toContain(fakeSecret()); // 原文不落盘
    expect(line).not.toContain('a@corp.com');
    expect(line).toContain('[REDACTED:');

    // 排除表：信封 10 字段 + bindingSnapshot + *Digest 零改写
    const started = events.find((e) => e.eventType === 'task_started') as { bindingSnapshot: unknown };
    expect(started.bindingSnapshot).toBeTruthy(); // 结构化快照不动
    const succeeded = events.find((e) => e.eventType === 'task_succeeded') as unknown as Record<string, unknown>;
    expect(succeeded.outputDigest).toBe(sha256Hex(JSON.stringify(output)).slice(0, 16)); // digest = 原文口径
    expect(succeeded.outputContractVerdict).toBe('pass'); // 结构化枚举值不被规则误伤
    for (const key of ['eventId', 'timestamp', 'traceId', 'taskId', 'agentId', 'agentVersionId', 'specContentHash', 'eventType', 'callNo', 'callKind', 'attemptNo']) {
      expect(succeeded[key]).toBeDefined(); // 信封字段仍在（未参与脱敏路径）
    }

    // 留痕摘要：redacted: [{ruleId, count}]，不含原文
    const redacted = succeeded.redacted as { ruleId: string; count: number }[];
    expect(redacted.length).toBeGreaterThanOrEqual(1);
    expect(redacted.some((r) => r.ruleId.startsWith('secret-'))).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain(fakeSecret());
  });

  it('digest 字段被规则命中形态保护（*Digest 后缀键零改写）', () => {
    // 单元级：redactEventPayload 直接断言排除表
    const out = redactEventPayload(
      {
        outputDigest: sha256Hex(fakeSecret()).slice(0, 16),
        bindingSnapshot: { promptHash: sha256Hex(fakeSecret()) },
        note: `凭据 ${fakeSecret()}`,
      },
      { rules: [{ ruleId: 'any-secret', pattern: 'sk-ant-[A-Za-z0-9_-]{20,}', scope: 'all' }] },
    );
    expect(out.payload.outputDigest).toBe(sha256Hex(fakeSecret()).slice(0, 16)); // *Digest 键零改写
    expect((out.payload.bindingSnapshot as { promptHash: string }).promptHash).toBe(sha256Hex(fakeSecret())); // bindingSnapshot 键零改写
    expect(out.payload.note).toBe('凭据 [REDACTED:any-secret]');
    expect(out.redacted).toEqual([{ ruleId: 'any-secret', count: 1 }]);
  });
});

describe('DoD-② 硬条款：digest 脱敏前按原文计算 + T1/T2 在脱敏开启库原样重跑', () => {
  it('跨任务对账：两任务同输出（含密钥）→ outputDigest 相同且等于原文 digest（落盘物已被改写）', async () => {
    const output = outputWithSecret();
    const json = JSON.stringify(output);
    const h = makeHarness([{ kind: 'text', text: json }, { kind: 'text', text: json }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-xtask' }));
    const t1 = h.rt.tasks.createTask('rd-xtask', validInput, 't');
    const t2 = h.rt.tasks.createTask('rd-xtask', validInput, 't');
    await h.rt.tasks.runTask(t1);
    await h.rt.tasks.runTask(t2);

    const expectedDigest = sha256Hex(json).slice(0, 16); // 原文口径（脱敏前）
    for (const t of [t1, t2]) {
      const evt = h.rt.trace.readEvents(t).find((e) => e.eventType === 'task_succeeded') as unknown as { outputDigest: string; output: unknown };
      expect(evt.outputDigest).toBe(expectedDigest); // 对账不失配（若 digest 按脱敏后文本计算，此处必失配）
      expect(JSON.stringify(evt.output)).not.toContain(fakeSecret()); // 落盘物已改写
    }
    const d1 = (h.rt.trace.readEvents(t1).find((e) => e.eventType === 'task_succeeded') as unknown as { outputDigest: string }).outputDigest;
    const d2 = (h.rt.trace.readEvents(t2).find((e) => e.eventType === 'task_succeeded') as unknown as { outputDigest: string }).outputDigest;
    expect(d1).toBe(d2); // 跨任务一致（灰度 report / 记忆去重依赖）
  });

  it('T1/T2 单一查询在脱敏开启库上原样工作（默认规则集=脱敏开启）', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(outputWithSecret()) }]);
    const versionId = registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-t12' }));
    const taskId = h.rt.tasks.createTask('rd-t12', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    const t1 = queryT1(h.rt, taskId);
    expect(t1.agentVersionId).toBe(versionId);
    expect(t1.bindingSnapshot).not.toBeNull(); // bindingSnapshot 经排除表保真
    const t2 = queryT2(h.rt, versionId);
    expect(t2.agentId).toBe('rd-t12');
    expect(t2.rejectedRequests).toEqual([]);
  });
});

describe('DoD-③ 密钥样本注入 Trace → 落盘物扫描零命中（T3 联动）', () => {
  it('全量 traces 落盘文件过 T3 密钥正则清单零命中', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(outputWithSecret()) }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-scan' }));
    const taskId = h.rt.tasks.createTask('rd-scan', { topic: `凭据 ${fakeSecret()}` }, 't');
    await h.rt.tasks.runTask(taskId);
    expect(readdirSync(h.rt.tracesDir).length).toBeGreaterThan(0);
    for (const file of readdirSync(h.rt.tracesDir)) {
      const content = readFileSync(path.join(h.rt.tracesDir, file), 'utf8');
      for (const { name, re } of SECRET_PATTERNS) {
        expect(re.test(content), `${file} 命中 ${name}`).toBe(false);
      }
    }
  });
});

describe('管道不可削（空规则集仍过管道）与规则集可裁', () => {
  it('rules: [] → 管道生效但无命中（无 redacted 字段、原文保留——规则集裁剪合法）', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(outputWithSecret()) }], process.cwd(), { redaction: { rules: [] } });
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-empty' }));
    const taskId = h.rt.tasks.createTask('rd-empty', validInput, 't');
    await h.rt.tasks.runTask(taskId);
    const evt = h.rt.trace.readEvents(taskId).find((e) => e.eventType === 'task_succeeded') as unknown as Record<string, unknown>;
    expect(evt.redacted).toBeUndefined(); // 无命中不附摘要
    expect(JSON.stringify(evt.output)).toContain(fakeSecret()); // 空规则集：无改写（管道在，规则空）
  });

  it('自定义规则集：仅 email 规则 → 密钥不命中（规则集内容可裁）', async () => {
    const h = makeHarness([{ kind: 'text', text: JSON.stringify(outputWithSecret()) }], process.cwd(), {
      redaction: { rules: [{ ruleId: 'email', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', scope: 'payload' }] },
    });
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-custom' }));
    const taskId = h.rt.tasks.createTask('rd-custom', { topic: '联系 b@corp.io' }, 't');
    await h.rt.tasks.runTask(taskId);
    const line = readFileSync(h.rt.trace.traceFile(taskId), 'utf8');
    expect(line).toContain('[REDACTED:email]');
    expect(line).toContain(fakeSecret()); // 自定义集不含密钥规则 → 不改写（规则集可裁，管道在）
  });
});
