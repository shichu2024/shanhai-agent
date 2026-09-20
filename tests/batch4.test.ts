import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { buildAgentReport, buildOtelHealthPanel, OTEL_TRACE_EVENT_THRESHOLD } from '../src/modules/report.js';
import { scanForRelease, DEFAULT_SCAN_CONFIG } from '../src/scripts/releaseScan.js';
import { MEMORY_BOUNDARY_START } from '../src/modules/memory.js';
import {
  makeHarness, sampleSpec, registerAndRelease, registerL3Tool, validInput, validOutput, validationDepsOf,
} from './helpers.js';

const validJson = JSON.stringify(validOutput());
const failing = JSON.stringify({ broken: true });

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

const FIXTURES = path.join('tests', 'fixtures', 'positive-controls');
const FIXTURES_ABS = path.join(process.cwd(), FIXTURES);

describe('DoD-① OTel 条件监测健康面板（§4.8，D-15——只读指标，无后台进程）', () => {
  it('小库：事件/文件计数正确、T1 P95 样本不足输出 null、未触发', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }, { kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'hp-a' }));
    for (let i = 0; i < 2; i++) {
      const t = h.rt.tasks.createTask('hp-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    const report = buildAgentReport(dbOf(h.rt), 'hp-a', { t1: (taskId) => h.rt.trace.readEvents(taskId) });
    const panel = report.healthPanel;
    expect(panel.traceFileCount).toBe(2);
    expect(panel.traceEventCount).toBeGreaterThan(0);
    expect(panel.traceEventCount).toBeLessThanOrEqual(OTEL_TRACE_EVENT_THRESHOLD);
    expect(panel.t1QueryP95Ms).toBeNull(); // 样本 <5——不假装
    expect(panel.triggered).toBe(false);
    expect(panel.note).toContain('未达');
  });

  it('触发条件①：Trace 事件 > 10000 → triggered=true（条件触发模型，面板可见即义务）', () => {
    const h = makeHarness();
    const insert = dbOf(h.rt).prepare('INSERT INTO trace_index (eventId, taskId, agentVersionId, eventType, timestamp) VALUES (?,?,?,?,?)');
    const bulk = dbOf(h.rt).transaction(() => {
      for (let i = 0; i <= OTEL_TRACE_EVENT_THRESHOLD; i++) {
        insert.run(`fake-${i}`, 'hp-bulk', 'v', 'task_created', '2026-01-01T00:00:00Z');
      }
    });
    bulk();
    const panel = buildOtelHealthPanel(dbOf(h.rt));
    expect(panel.traceEventCount).toBeGreaterThan(OTEL_TRACE_EVENT_THRESHOLD);
    expect(panel.triggered).toBe(true);
    expect(panel.note).toContain('投影层设计'); // 触发后提示 §4.8 归档设计直接实施（真源单一性不变）
  });

  it('T1 P95 实测采样：≥5 任务样本 → 非 null 数值（条件①第二指标的度量对象）', async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'hp-p95' }));
    h.provider.script.push(...Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: validJson })));
    for (let i = 0; i < 6; i++) {
      const t = h.rt.tasks.createTask('hp-p95', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    const panel = buildOtelHealthPanel(dbOf(h.rt), (taskId) => h.rt.trace.readEvents(taskId));
    expect(panel.t1QueryP95Ms).not.toBeNull();
    expect(panel.t1QueryP95Ms!).toBeLessThan(500); // 单机小库远低于触发线
    expect(panel.triggered).toBe(false);
  });
});

describe('DoD-②/③/④ T3 扫描清单配置化 + 阳性对照 + 夹具豁免 + safetensors 嗅探', () => {
  it('DoD-② 每族一个阳性对照：夹具目录在无豁免配置下全命中（secret/扩展名/魔数/safetensors 四族）', () => {
    const noExemptions = { ...DEFAULT_SCAN_CONFIG, exemptions: [] };
    const findings = scanForRelease(FIXTURES_ABS, noExemptions);
    const files = findings.map((f) => f.file);
    expect(files).toContain('positive-control.secret.txt'); // 密钥族（sk-ant- 与通用 sk- 两条正则各报一条）
    expect(files).toContain('positive-control.gguf'); // 权重扩展名族
    expect(files).toContain('renamed-weight.dat'); // 魔数族（改名）
    expect(files).toContain('positive-control.safetensors'); // safetensors 结构族（真实样本形态）
    expect(findings.filter((f) => f.file === 'positive-control.secret.txt').length).toBe(2); // 双正则命中（逐条报告可审计）
    expect(findings.filter((f) => f.kind === 'model_weight')).toHaveLength(3); // 扩展名/魔数/safetensors 各一
  });

  it('DoD-② 夹具豁免规则（豁免入配置、可审计——P2-4）：默认配置下夹具零误报（含子树扫描口径）', () => {
    expect(DEFAULT_SCAN_CONFIG.exemptions.length).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_SCAN_CONFIG.exemptions[0].reason).toBeTruthy(); // 无理由的豁免不允许
    expect(scanForRelease(FIXTURES_ABS, DEFAULT_SCAN_CONFIG)).toEqual([]); // 夹具目录直接扫描：豁免生效
    const testsScan = scanForRelease(path.join(process.cwd(), 'tests'), DEFAULT_SCAN_CONFIG);
    expect(testsScan.filter((f) => toForward(f.file).includes('positive-controls'))).toEqual([]); // 子树扫描：后缀段豁免同样生效
  });

function toForward(p: string): string {
  return p.split(path.sep).join('/');
}

  it('DoD-③ safetensors 真实样本嗅探：结构特征命中；非权重文件不误报', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'st-sniff-'));
    // 真实样本形态：8B LE headerLen + JSON header + 数据区
    const header = Buffer.from('{"format":"pt"}', 'utf8');
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(header.length));
    writeFileSync(path.join(dir, 'model-weights-st'), Buffer.concat([lenBuf, header, Buffer.alloc(16)]));
    // 反例：headerLen 与文件不符 / 首字节非 '{' → 不命中
    writeFileSync(path.join(dir, 'not-st-a'), Buffer.concat([Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('not-json'), Buffer.alloc(16)]));
    writeFileSync(path.join(dir, 'not-st-b'), Buffer.from('plain text content here'));
    const findings = scanForRelease(dir, { ...DEFAULT_SCAN_CONFIG, exemptions: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('model-weights-st');
    expect(findings[0].detail).toContain('safetensors');
  });

  it('DoD-④ T3 断言在新（配置化）清单上全过：仓库根默认配置扫描零命中', () => {
    // 等价 npm run release-scan（同 DEFAULT_SCAN_CONFIG + 内置豁免）；夹具目录被豁免覆盖
    const findings = scanForRelease(process.cwd(), DEFAULT_SCAN_CONFIG);
    expect(findings).toEqual([]); // 新清单 + safetensors 嗅探 + 豁免——零命中通过
  });

  it('清单配置化：自定义清单生效（默认密钥正则移除后同文件不再命中）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scan-cfg-'));
    const secret = ['sk-ant-api', '03-bbbbbbbbbb', 'bbbbbbbbbbbbbb'].join('');
    writeFileSync(path.join(dir, 'leak.txt'), `k=${secret}\n`);
    expect(scanForRelease(dir, { ...DEFAULT_SCAN_CONFIG, exemptions: [] })).toHaveLength(2); // 默认清单命中（sk-ant- 与通用 sk-）
    const custom = scanForRelease(dir, {
      ...DEFAULT_SCAN_CONFIG,
      exemptions: [],
      secretPatterns: [{ name: '内部令牌', pattern: 'INTERNAL-[0-9]{4}' }], // 清单可裁/可换（配置形态）
    });
    expect(custom).toEqual([]); // 新清单不含密钥正则 → 不命中（可审计的清单变更）
    // 反向：自定义规则命中自定义样本
    writeFileSync(path.join(dir, 'internal.txt'), 'INTERNAL-1234\n');
    const hit = scanForRelease(dir, { ...DEFAULT_SCAN_CONFIG, exemptions: [], secretPatterns: [{ name: '内部令牌', pattern: 'INTERNAL-[0-9]{4}' }] });
    expect(hit).toHaveLength(1);
    expect(hit[0].detail).toContain('内部令牌');
  });
});

describe('DoD-⑤（增）resume 重建记忆注入——决策官 P3 裁决修改 + 规格 v1.2 注记', () => {
  it('双断言：续跑段 system 含边界标记（快照冻结 policy + 重建时刻 active 集）；续跑失败 contradiction 递增', async () => {
    const h = makeHarness([]);
    registerL3Tool(h);
    // 同一 Spec：memoryPolicy.persistent(injection=context) + approvalPolicy(L3)——快照冻结 policy 的真实载体
    const spec = sampleSpec({
      agentId: 'ri-a',
      tools: [{ toolId: 'l3-op', riskLevel: 'L3' }],
      extraTop: {
        approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 },
        memoryPolicy: { type: 'persistent', injection: 'context' },
      },
    });
    registerAndRelease(h.rt, spec);

    // 先造 active 记忆（两个独立 taskId 成功复证同一输出）
    h.provider.script.push({ kind: 'text', text: validJson }, { kind: 'text', text: validJson });
    for (let i = 0; i < 2; i++) {
      const t = h.rt.tasks.createTask('ri-a', validInput, 't');
      await h.rt.tasks.runTask(t);
    }
    const mem = h.rt.memories.list()[0];
    expect(mem.status).toBe('active');

    // 第三任务：L3 挂起（首段注入 active 记忆）→ approve → resume
    h.provider.script.push({ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: {} }] });
    const taskId = h.rt.tasks.createTask('ri-a', validInput, 't');
    await h.rt.tasks.runTask(taskId); // Paused
    const request = h.rt.approvals.pendingForTask(taskId)!;
    h.rt.approvals.approve(request.requestId, 'human');

    // 续跑段脚本：失败输出 ×3（attempt 耗尽 → Failed）
    h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
    const before = h.rt.memories.get(mem.memoryId)!.contradictionCount;
    const row = await h.rt.tasks.runTask(taskId, null, { resume: true });

    // 断言 1（裁决要求）：续跑段 system 含边界标记（重建注入——快照冻结 policy + 当前 active 集）
    expect(row.status).toBe('failed');
    const resumedSystem = h.provider.receivedCalls.at(-1)!.system!;
    expect(resumedSystem).toContain(MEMORY_BOUNDARY_START); // v1.2：注入语义覆盖任务全程
    // 断言 2（裁决要求）：续跑失败 contradiction 计数递增（注入清单非空）
    const after = h.rt.memories.get(mem.memoryId)!.contradictionCount;
    expect(after).toBe(before + 1);
  });
});

// 规格注记存在性（v1.2 修订注记随批提交——文档义务机械断言）
describe('规格 v1.2 修订注记随批提交（A1/A3）', () => {
  it('A1 §2.1 与 A3 §2 均含 v1.2 注记（resume 重建注入）', () => {
    const a1 = readFileSync(path.join(process.cwd(), 'docs', 'spec', 'A1-Spec-Schema-v1.md'), 'utf8');
    const a3 = readFileSync(path.join(process.cwd(), 'docs', 'spec', 'A3-Task-状态机.md'), 'utf8');
    expect(a1).toContain('v1.2 修订注记');
    expect(a1).toContain('重建注入');
    expect(a3).toContain('v1.2 修订注记');
    expect(a3).toContain('重建记忆注入');
  });
});
