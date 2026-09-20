import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput } from './helpers.js';
import { Runtime } from '../src/runtime.js';
import { buildAgentReport } from '../src/modules/report.js';
import { defaultRedactionPolicy } from '../src/modules/redaction.js';
import { loadRuntimeConfig } from '../src/config.js';
import { ModelGateway } from '../src/modules/modelGateway.js';

// WP-3B 批次四（收官批，§4.7 + 决策官 01a0bdb0 留档收口清单）：TDD 红阶段用例。
// 结构断言沿用批次一/二/三已认可形态（源文本级机械断言——防再漂移）。
// 命名注记：tests/batch4.test.ts 是第二阶段 WP-2B 收官批存量文件——本批用 wp3b- 前缀避让。

const validJson = JSON.stringify(validOutput());
const failing = JSON.stringify({ broken: true });
const srcDir = path.resolve(process.cwd(), 'src');
const readSrc = (rel: string): string => readFileSync(path.join(srcDir, rel), 'utf8');

function dbOf(rt: Runtime) {
  return (rt as unknown as { db: import('better-sqlite3').Database }).db;
}

afterEach(() => vi.restoreAllMocks());

// ---------- A.2（批次三 P2）report 分子对称化 ----------

describe('A.2 report 分子对称化（分子排除 cancelled，与分母同口径）', () => {
  it('取消前已计入契约失败的任务：分子分母同排除 → 通过率不低估不为负', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'num-a' }));
    // 1 契约失败任务（schema_violation 计入 countedInContractRate）后被治理性取消 + 1 成功任务
    h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
    const bad = h.rt.tasks.createTask('num-a', validInput, 't');
    await h.rt.tasks.runTask(bad);
    dbOf(h.rt).prepare(`UPDATE task_record SET status = 'cancelled', cancelReason = 'user' WHERE taskId = ?`).run(bad);
    h.provider.script.push({ kind: 'text', text: validJson });
    const ok = h.rt.tasks.createTask('num-a', validInput, 't');
    await h.rt.tasks.runTask(ok);

    const report = buildAgentReport(dbOf(h.rt), 'num-a');
    const stable = report.groups.find((g) => g.assignmentSource === 'stable')!;
    expect(stable.tasks).toBe(2); // 原始计数可见
    expect(stable.excludedCancelled).toBe(1);
    expect(stable.contractFailures).toBe(0); // 分子对称排除（现不排除 → 1，通过率被低估）
    expect(stable.contractPassRate).toBe(1); // 分母 = 2−1 = 1；分子 = 0 → (1−0)/1
  });

  it('极端面：小组内计入失败的任务全部被取消 → 分母零基线仍 null（分子排除后不出现负通过率）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'num-b' }));
    h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
    const bad = h.rt.tasks.createTask('num-b', validInput, 't');
    await h.rt.tasks.runTask(bad);
    dbOf(h.rt).prepare(`UPDATE task_record SET status = 'cancelled', cancelReason = 'user' WHERE taskId = ?`).run(bad);

    const report = buildAgentReport(dbOf(h.rt), 'num-b');
    const stable = report.groups.find((g) => g.assignmentSource === 'stable')!;
    expect(stable.excludedCancelled).toBe(1);
    expect(stable.contractPassRate).toBeNull(); // 无分母不假装（不为负、不低估）
  });
});

// ---------- A.3（批次二 P3）redactReason 退化分支可观测痕迹 ----------

describe('A.3 redactReason 解析失败退化分支补可观测痕迹（stderr 一行）', () => {
  it('非法 JSON rejectReason → 字符串级退化仍脱敏（批次二回归）+ stderr 痕迹一行（现静默）', () => {
    const h = makeHarness([]);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const secret = ['sk-ant-api', '03-zzzzzzzzzz', 'zzzzzzzzzzzzzz'].join('');
    h.rt.audit.rejectedRequest({
      kind: 'cli_command',
      who: 't',
      target: 'num-c',
      inputHash: '00'.repeat(16),
      rejectReason: `not-json {broken ${secret}`,
    });
    const row = dbOf(h.rt).prepare(`SELECT rejectReason FROM audit_events ORDER BY rowid DESC LIMIT 1`).get() as { rejectReason: string };
    expect(row.rejectReason).not.toContain(secret); // 退化仍过管道（既有行为不回退）
    expect(row.rejectReason).toContain('REDACTED');
    const wrote = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(wrote).toContain('redactReason'); // 退化痕迹（现无 → 红）
  });
});

// ---------- B.1 §4.7-1 RedactionRule.scope 装饰字段删除 ----------

describe('B.1 scope 装饰字段删除（类型 + 默认规则集两处；存量配置条目被忽略，零迁移）', () => {
  it('默认规则集不再携带 scope 键（纯装饰未实现，§4.7-1）', () => {
    for (const r of defaultRedactionPolicy().rules) {
      expect(Object.prototype.hasOwnProperty.call(r, 'scope')).toBe(false);
    }
  });

  it('config 加载：无 scope 的规则被接受（现被校验过滤丢弃——存量兼容注记）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfg-b4-'));
    const file = path.join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: { anthropic: { baseUrl: 'http://localhost:9', authTokenEnv: 'TOK_X', models: ['mock-model'] } },
        redaction: { rules: [{ ruleId: 'r1', pattern: 'abc' }] },
      }),
    );
    const cfg = loadRuntimeConfig({ SHANHAI_CONFIG: file, TOK_X: 'tok' } as NodeJS.ProcessEnv);
    expect(cfg.redaction.rules).toHaveLength(1); // 现被 scope 校验过滤 → 0（红）
    expect(cfg.redaction.rules[0]).toEqual({ ruleId: 'r1', pattern: 'abc' });
  });
});

// ---------- B.2 §4.7-2 config.ts:33 退化三元删除（D-26 裁定字面） ----------

describe('B.2 config.ts:33 退化三元删除 + 注释去 config.json 回退表述（D-26）', () => {
  it('源文本机械断言：无退化双分支、注释无 config.json 回退、回退链单一显式', () => {
    const src = readSrc('config.ts');
    expect(src).toContain("env.SHANHAI_CONFIG ?? 'config.local.json'"); // 单一显式回退
    expect(src).not.toContain(`? 'config.local.json' : 'config.local.json'`); // 退化三元消亡
    expect(src).not.toContain('./config.json'); // 注释-行为漂移归零（回退从未生效，git 史核实）
  });
});

// ---------- B.3 §4.7-4 CrashRecovery 终局清 abortRequested 残留 ----------

describe('B.3 CrashRecovery 终局清 abortRequested 残留（§4.7-4）', () => {
  it('Running 遗留且 abortRequested=1 → 崩溃标记终局后标志归零（跨进程中止意图不外溢到终态行）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'cr-a' }));
    const t = h.rt.tasks.createTask('cr-a', validInput, 't');
    dbOf(h.rt).prepare(`UPDATE task_record SET status = 'running', abortRequested = 1 WHERE taskId = ?`).run(t);
    const rep = h.rt.state.recover();
    expect(rep.crashMarkedTasks).toContain(t);
    const row = dbOf(h.rt).prepare(`SELECT status, abortRequested FROM task_record WHERE taskId = ?`).get(t) as { status: string; abortRequested: number };
    expect(row.status).toBe('failed');
    expect(row.abortRequested).toBe(0); // 现残留 1（红）
  });
});

// ---------- B.4 §4.7-5 ModelGateway 构造器自检（择项） ----------

describe('B.4 ModelGateway 构造器自检（择项——A5 §4-2 无配置即拒绝启动）', () => {
  it('无 provider / 空白名单 → 构造期拒绝；有效配置 → 构造通过', () => {
    expect(() => new ModelGateway(null as never, new Set(['m']))).toThrow('拒绝启动');
    expect(() => new ModelGateway({} as never, new Set())).toThrow('拒绝启动');
    expect(() => new ModelGateway({} as never, new Set(['m']))).not.toThrow();
  });
});

// ---------- B.5 §4.7-6 成文注记（口径显式化，不改行为） ----------

describe('B.5 成文注记机械断言（P95 / scan 段浅合并 / SKIP_DIRS / OTel 留位 / Evolution 事件 / 消费点清单登记）', () => {
  it('A5：P95 采样口径（LIMIT 10 最近任务）+ OTel 条件②/③单机留位 注记在场', () => {
    const a5 = readFileSync(path.join(process.cwd(), 'docs', 'spec', 'A5-版本状态机.md'), 'utf8');
    expect(a5).toContain('LIMIT 10'); // P95 采样口径注记（现缺 → 红）
    expect(a5).toMatch(/留位[^\n]*OTel|OTel[^\n]*留位/); // 条件②/③单机显式留位注记（现缺 → 红）
  });

  it('A6：scan 配置段浅合并（整段替换非深合并）+ SKIP_DIRS 全局匹配（不计防线）+ Evolution 无专属事件 注记在场', () => {
    const a6 = readFileSync(path.join(process.cwd(), 'docs', 'spec', 'A6-事件模型.md'), 'utf8');
    expect(a6).toContain('浅合并'); // scan 配置段浅合并注记（现缺 → 红）
    expect(a6).toMatch(/SKIP_DIRS[^\n]*全局|全局[^\n]*SKIP_DIRS/); // SKIP_DIRS 全局匹配注记（现缺 → 红）
    expect(a6).toMatch(/Evolution[^\n]*(专属|Trace)事件|未为 Evolution 定义/); // Evolution 无专属事件注记成文（现缺 → 红）
  });

  it('消费点清单：canaryRounds 切轮事件命名纪律登记（批次三 #2 裁定）', () => {
    const doc = readFileSync(path.join(process.cwd(), 'docs', 'phase3', '02-批次二-四落盘面消费点清单.md'), 'utf8');
    expect(doc).toMatch(/canaryRounds|切轮事件/); // 命名纪律登记（现缺 → 红）
    expect(doc).toMatch(/命名纪律|须同步扩展/);
  });
});
