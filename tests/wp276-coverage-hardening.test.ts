import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { rootExemption, scanForRelease, DEFAULT_SCAN_CONFIG } from '../src/scripts/releaseScan.js';
import { StdioMcpTransport } from '../src/mcp/client.js';
import { ConfigError } from '../src/config.js';
import { buildCapabilityTrend } from '../src/modules/trend.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, validationDepsOf, type Harness } from './helpers.js';

// wp276（第五十八批 · 覆盖蓄量第二度）：纯测试触达的低风险分支补测，零 src 改动。
// 选题依据：基线 b295e11 亲跑 coverage（statements 98.80% 4870/4929），门 98.6 余量仅 ~10 条语句；
// 本批按「先蓄量后进档」从 json-summary 未覆盖语句清单中选取可单线程触达的面，目标净增 ≥10 条、实测 ≥98.9%。
// 覆盖面分组（文件:行号 = 基线实测未覆盖语句）：
//  ① releaseScan.ts:101 → rootExemption 畸形豁免段（空段/长于扫描根）continue 短路——fail-closed 不误豁免 ×1；
//  ② releaseScan.ts:119 → scanForRelease 扫描根不存在 → walk 入口 existsSync 短路空返回 ×1；
//  ③ mcp/client.ts:116/136 → StdioMcpTransport 真实子进程：杂散空行不进分发 + close 幂等 ×2；
//  ④ runtime.ts:134/135 → Runtime.fromConfig 配置驱动双臂：无配置拒绝启动（T3）+ 完整配置构造 ×2；
//  ⑤ approval.ts:306 → supersedePending 遇任务行缺失 → ApprovalError(not_found) 防御 ×1；
//  ⑥ capabilityRegistry.ts:351 → deriveR2 terminal Tool 失败无法关联 toolId（无同 callNo requested）→ 跳过 ×1；
//  ⑦ capabilityRegistry.ts:412 → insertRow 非 UNIQUE 约束异常（触发器 RAISE(ABORT) 模拟）→ 原样上抛 ×1；
//  ⑧ trend.ts:158/159 → 记忆面窗口外事件双守卫（< since / > until 各一臂，index 与文件时间戳解耦构造）×2；
//  ⑨ runtime/delegation.ts:211 → resolveAgent 无注入 dispatchRoll → 缺省随机源兜底（灰度分派 weight=100 必中）×1。
// 不可测面备案（不随批扩科）：taskManager 435-455（微任务竞速窗口，wp268 已实测论证）、
// toolExecutor 213 / modelGateway 140 / executor 206（源码注明「不可达路径」防御）、
// types.ts:13（类型层）、releaseScan.ts:264（size≥10 而 readSync<9 的物理竞态）、
// capabilityRegistry.ts:434（parseEvidenceRef 只抛 EvidenceRefError）。
// 零 src 改动、零门值改动、零既有用例改动。

const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 取任务行锚（agentVersionId / specContentHash）——构造 trace 事件基座 */
function taskBase(h: Harness, agentId: string, taskId: string): { taskId: string; agentId: string; agentVersionId: string; specContentHash: string } {
  const row = dbOf(h.rt).prepare('SELECT agentVersionId, specContentHash FROM task_record WHERE taskId = ?').get(taskId) as {
    agentVersionId: string;
    specContentHash: string;
  };
  return { taskId, agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash };
}

// ---------- ①② releaseScan：豁免锚定防御 / 扫描根缺失短路 ----------

describe('wp276 releaseScan 豁免与扫描根防御分支', () => {
  it('rootExemption：豁免段为空（空 path）或段序列长于扫描根 → continue 短路，不误豁免（fail-closed）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wp276-root-'));
    const config = {
      ...DEFAULT_SCAN_CONFIG,
      exemptions: [
        { path: '', reason: 'wp276 空段豁免（畸形配置面）' },
        { path: 'a/b/c/d/e/f/g/h/i/j/k', reason: 'wp276 段序列长于任何临时扫描根' },
      ],
    };
    expect(rootExemption(root, config)).toBeNull();
  });

  it('scanForRelease：扫描根路径不存在 → 空发现返回（walk 入口 existsSync 短路；CLI 层另有 exit 2 语义不在此层）', () => {
    expect(scanForRelease(path.join(tmpdir(), 'wp276-no-such-root-xyz'))).toEqual([]);
  });
});

// ---------- ③ mcp/client：真实子进程 stdio transport 边界 ----------

describe('wp276 StdioMcpTransport 真实子进程边界', () => {
  it('杂散空行不进消息分发（server 启动噪声容忍）；close() 幂等（二次调用直接短路）', async () => {
    // 子进程：先输出两行空行（杂散噪声）再输出一条合法 ndjson 消息；stdin resume 保活等待父侧 end
    const transport = new StdioMcpTransport(process.execPath, [
      '-e',
      'process.stdout.write("\\n\\n{\\"id\\":1}\\n"); process.stdin.resume();',
    ]);
    const got: unknown[] = [];
    transport.onMessage((m) => got.push(m));
    const deadline = Date.now() + 4000;
    while (got.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(got).toEqual([{ id: 1 }]); // 空行被 116 短路，唯一一条合法消息进分发

    await transport.close(); // stdin.end() → 子进程 stdin 流结束自然退出 → exit resolve
    await transport.close(); // 幂等：closed 已置位直接返回
  }, 10000);
});

// ---------- ④ runtime.ts：fromConfig 配置驱动双臂 ----------

describe('wp276 Runtime.fromConfig 配置驱动', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('配置文件缺失 → ConfigError（T3：无配置即拒绝启动，不留缺省臂）', () => {
    vi.stubEnv('SHANHAI_CONFIG', path.join(tmpdir(), 'wp276-missing-config.json'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wp276-rt-'));
    expect(() => Runtime.fromConfig(dataDir, process.cwd())).toThrow(ConfigError);
  });

  it('完整配置（baseUrl/密钥环境变量引用/模型白名单）→ 构造 Runtime（生产构造路径）', () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), 'wp276-cfg-'));
    const cfgPath = path.join(cfgDir, 'config.wp276.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        providers: { anthropic: { baseUrl: 'https://wp276.invalid', authTokenEnv: 'WP276_TOKEN', models: ['wp276-model'] } },
      }),
      'utf8',
    );
    vi.stubEnv('SHANHAI_CONFIG', cfgPath);
    vi.stubEnv('WP276_TOKEN', 'wp276-token-placeholder');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wp276-rt2-'));
    const rt = Runtime.fromConfig(dataDir, process.cwd());
    expect(rt).toBeInstanceOf(Runtime);
  });
});

// ---------- ⑤ approval：任务行缺失防御 ----------

describe('wp276 approval supersedePending 防御', () => {
  it('pending 请求的任务行已缺失 → ApprovalError(not_found)（taskOf 防御，不留半更新态）', () => {
    const h = makeHarness([]);
    dbOf(h.rt)
      .prepare(
        `INSERT INTO approval_request (requestId, taskId, agentVersionId, toolId, riskLevel, requestedAt, decision, timeoutAt, callRef)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'wp276-req-1',
        'wp276-ghost-task',
        'wp276-ver',
        'shell',
        'L3',
        '2026-11-01T00:00:00.000000000Z',
        'pending',
        '2026-11-02T00:00:00.000000000Z',
        'wp276-callref',
      );
    expect(() => h.rt.approvals.supersedePending('wp276-ghost-task', 'tester')).toThrow(/任务不存在/);
  });
});

// ---------- ⑥⑦ capabilityRegistry：R2 归因跳过 / 非 UNIQUE 异常上抛 ----------

describe('wp276 capabilityRegistry 防御分支', () => {
  it('deriveR2：terminal Tool 失败无法关联 toolId（无同 callNo 的 requested）→ 该样本跳过，不构成 R2 判据', () => {
    const h = makeHarness([]);
    const agentId = 'wp276-cap-a';
    registerAndRelease(h.rt, sampleSpec({ agentId }));
    const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
    const base = taskBase(h, agentId, taskId);
    h.rt.trace.recordCallEvent(base, 'tool_call_requested', 'tool', 1, 1, { toolId: 'wp276-tool-known', argsDigest: 'd' });
    // callNo=2 无 requested 关联 → toolId 归因为空 → continue（窗口内 terminal Tool 失败不计样本）
    h.rt.trace.recordCallEvent(base, 'attempt_failed', 'tool', 2, 1, {
      failureClass: 'Tool',
      subClass: 'execution_failed',
      message: 'wp276 无法归因的工具失败',
      willRetry: false,
    });
    expect(h.rt.capabilities.recomputeDerived()).toEqual([]); // 零新建：失败样本被跳过
  });

  it('insertRow：非 UNIQUE 约束异常（触发器 RAISE(ABORT) 模拟库级阻断）→ 原样上抛（不吞不换语义）', () => {
    const h = makeHarness([]);
    const agentId = 'wp276-cap-b';
    registerAndRelease(h.rt, sampleSpec({ agentId }));
    dbOf(h.rt).exec(`CREATE TRIGGER wp276_block_cap BEFORE INSERT ON capability_registry BEGIN SELECT RAISE(ABORT, 'wp276-block-insert'); END`);
    expect(() =>
      h.rt.capabilities.add({ agentId, kind: 'capability', statement: 'wp276 触发器阻断演示断言' }),
    ).toThrow(/wp276-block-insert/);
  });
});

// ---------- ⑧ trend：记忆面窗口外事件双守卫 ----------

describe('wp276 trend 记忆面窗口守卫', () => {
  it('文件事件 timestamp < since 与 > until 双守卫各跳过一臂（index 与文件时间戳解耦构造，逐臂计数断言）', () => {
    const h = makeHarness([]);
    const agentId = 'wp276-trend-a';
    registerAndRelease(h.rt, sampleSpec({ agentId }));

    // 任务 A：a0（文件侧早于下界）+ a1（窗口内）；任务 B：b0（文件侧晚于上界）+ b1（窗口内）
    const stamp = (taskId: string): { taskId: string; agentId: string; agentVersionId: string; specContentHash: string } => taskBase(h, agentId, taskId);
    const taskA = h.rt.tasks.createTask(agentId, validInput, 't');
    const baseA = stamp(taskA);
    h.rt.trace.recordTaskEvent(baseA, 'memory_state_changed', { memoryId: 'wp276-a0', from: 'candidate', to: 'active', evidenceCount: 1, contradictionCount: 0, evidenceCountAtLastTransition: 1 });
    h.rt.trace.recordTaskEvent(baseA, 'memory_state_changed', { memoryId: 'wp276-a1', from: 'candidate', to: 'active', evidenceCount: 1, contradictionCount: 0, evidenceCountAtLastTransition: 1 });
    const taskB = h.rt.tasks.createTask(agentId, validInput, 't');
    const baseB = stamp(taskB);
    h.rt.trace.recordTaskEvent(baseB, 'memory_state_changed', { memoryId: 'wp276-b0', from: 'candidate', to: 'active', evidenceCount: 1, contradictionCount: 0, evidenceCountAtLastTransition: 1 });
    h.rt.trace.recordTaskEvent(baseB, 'memory_state_changed', { memoryId: 'wp276-b1', from: 'candidate', to: 'active', evidenceCount: 1, contradictionCount: 0, evidenceCountAtLastTransition: 1 });

    // 文件侧时间戳改写（readEvents 直读 JSONL，无哈希校验）：a0 → 窗口前；a1/b1 → 窗口内；b0 → 窗口后
    const fileTs: Record<string, string> = {
      'wp276-a0': '2026-09-19T23:00:00.000000000Z',
      'wp276-a1': '2026-09-20T12:30:00.000000000Z',
      'wp276-b0': '2026-09-22T00:00:00.000000000Z',
      'wp276-b1': '2026-09-20T14:00:00.000000000Z',
    };
    for (const taskId of [taskA, taskB]) {
      const file = path.join(h.dataDir, 'traces', `${taskId}.jsonl`);
      const rewritten = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const ev = JSON.parse(line) as { memoryId?: string };
          const target = ev.memoryId !== undefined ? fileTs[ev.memoryId] : undefined;
          return JSON.stringify(target === undefined ? ev : { ...ev, timestamp: target });
        })
        .join('\n') + '\n';
      writeFileSync(file, rewritten, 'utf8');
    }
    // index 侧时间戳统一挪入窗口 → 两任务均被定向读取选中（memTaskIds 判定走 index）
    dbOf(h.rt).prepare(`UPDATE trace_index SET timestamp = ? WHERE taskId IN (?, ?)`).run('2026-09-20T12:00:00.000000000Z', taskA, taskB);

    const trend = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, agentId, {
      since: '2026-09-20T00:00:00Z',
      until: '2026-09-21T00:00:00Z',
      bucket: 'day',
    });
    // index 侧全史最小时间戳 = 挪入窗口后的值（证明两任务确实被选中读取）
    expect(trend.coverage.memoryFrom).toBe('2026-09-20T12:00:00.000000000Z');
    const bucket = trend.buckets.find((b) => b.key === '2026-09-20');
    expect(bucket).toBeDefined();
    // 恰好 2 条（a1+b1）：a0 被 < since 守卫跳过、b0 被 > until 守卫跳过——任一守卫失效即 3
    expect(bucket!.memoryEvents).toBe(2);
  });
});

// ---------- ⑨ delegation：无注入 dispatchRoll 的缺省随机源兜底 ----------

describe('wp276 resolveAgent 缺省随机源兜底（灰度分派 weight=100 必中 canary）', () => {
  it('不注入 dispatchRoll → ?? 兜底随机源参与灰度判定，canary weight=100 下分派到 canary 版并留痕', async () => {
    const delegateArgs = { agentId: 'wp276-canary-child', input: validInput, note: 'wp276 委托说明' };
    // 注意：第三个参数缺省——dispatchRoll 为 undefined，resolveAgent 走缺省随机源兜底
    const h = makeHarness(
      [
        { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: delegateArgs }] },
        { kind: 'text', text: validJson }, // 子（canary 版）终答
        { kind: 'text', text: validJson }, // 父收摘要后终答
      ],
      process.cwd(),
    );
    const parentSpec = sampleSpec({
      agentId: 'wp276-canary-parent',
      tools: [{ toolId: 'task-delegate', riskLevel: 'L3', controlledFields: { targetWhitelist: ['wp276-canary-child'] } }],
      extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
    });
    registerAndRelease(h.rt, parentSpec);
    const v1 = h.rt.registry.registerSpec(sampleSpec({ agentId: 'wp276-canary-child' }), 't', validationDepsOf(h.rt));
    h.rt.registry.release('wp276-canary-child', v1, 't');
    const v2Spec = sampleSpec({ agentId: 'wp276-canary-child', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 't', validationDepsOf(h.rt));
    h.rt.registry.release('wp276-canary-child', v2, 't', { noPointer: true });
    h.rt.registry.canarySet('wp276-canary-child', v2, 100, 't');

    const parentTaskId = h.rt.tasks.createTask('wp276-canary-parent', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const parentFinal = await h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    expect(parentFinal.status).toBe('succeeded');

    const childRow = dbOf(h.rt)
      .prepare('SELECT taskId, agentVersionId, assignmentSource FROM task_record WHERE parentTaskId = ?')
      .get(parentTaskId) as { taskId: string; agentVersionId: string; assignmentSource: string };
    expect(childRow.agentVersionId).toBe(v2); // 兜底随机源 [0,100) < weight=100 → 必中 canary 指针
    expect(childRow.assignmentSource).toBe('canary'); // 分派来源留痕不变式保持
  });
});
