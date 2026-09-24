import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validOutput, type Harness } from './helpers.js';
import { FIXTURE_TOOLS, inProcMcpHandler } from './fixtures/inProcMcpServer.js';
import { McpClient, InProcMcpTransport, StdioMcpTransport, resolveEnvRefs, stdioTransportFactory, type McpServerConfig } from '../src/mcp/client.js';
import { connectMcpServer, toolIdOf } from '../src/mcp/connect.js';
import { McpToolBridge } from '../src/mcp/bridge.js';
import { ToolExecutor, ToolTerminalFailure } from '../src/modules/toolExecutor.js';

const validJson = JSON.stringify(validOutput());

function dbOf(h: Harness): Database.Database {
  return (h.rt as unknown as { db: Database.Database }).db;
}

function auditOf(h: Harness, eventType: string): { payload: string; who: string }[] {
  return dbOf(h)
    .prepare(`SELECT who, payload FROM audit_events WHERE eventType = ? ORDER BY whenAt`)
    .all(eventType) as { payload: string; who: string }[];
}

const SERVERS: Record<string, McpServerConfig> = { weather: { transport: 'stdio', command: 'inproc-fixture' } };

/** in-proc transport 工厂（测试注入——不 spawn 子进程） */
function inProcFactory() {
  return () => new InProcMcpTransport(inProcMcpHandler(FIXTURE_TOOLS));
}

/** 连接夹具 server（默认 --yes 全 L3） */
async function connectFixture(h: Harness, opts: Parameters<typeof connectMcpServer>[2] = {}) {
  return connectMcpServer(
    { registry: h.rt.registry, servers: SERVERS, who: 'tester', transportFactory: inProcFactory() },
    'weather',
    { yes: true, ...opts },
  );
}

/** 夹具 harness：mcpServers + in-proc transport 注入（调用桥走同一工厂） */
function mcpHarness(script: Parameters<typeof makeHarness>[0] = []): Harness {
  return makeHarness(script, process.cwd(), { mcpServers: SERVERS, mcpTransportFactory: inProcFactory() });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// §4.2 MCP client + 夹具（in-proc 主 + 真实子进程冒烟）
// ============================================================

describe('WP-4B 批次一 §4.2：MCP client（最小 JSON-RPC 子集）', () => {
  it('in-proc：initialize 握手 → tools/list 发现 → tools/call 回显（D-28 退路形态）', async () => {
    const client = await McpClient.connect(inProcFactory()());
    expect(client.serverInfo).toEqual({ name: 'fixture-inproc', version: '9.9.9' });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'fail']);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' });
    const result = await client.callTool('echo', { city: 'shanghai', days: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('echo:{"city":"shanghai","days":3}');
    await client.close();
  });

  it('in-proc：isError 结果与未知工具的 JSON-RPC error 均可观测（不静默）', async () => {
    const client = await McpClient.connect(inProcFactory()());
    const failed = await client.callTool('fail', {});
    expect(failed.isError).toBe(true);
    await expect(client.callTool('nope', {})).rejects.toThrow(/未知工具/);
    await expect(client.request('bogus/method', {})).rejects.toThrow(/method not found/);
    await client.close();
  });

  it('真实子进程冒烟：StdioMcpTransport + node mcpEchoServer.mjs 全链（initialize/list/call）', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/mcpEchoServer.mjs', import.meta.url));
    const transport = new StdioMcpTransport(process.execPath, [fixturePath]);
    const client = await McpClient.connect(transport);
    expect(client.serverInfo).toEqual({ name: 'fixture-subprocess', version: '1.2.3' });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const result = await client.callTool('echo', { hello: 'world' });
    expect(result.content[0].text).toBe('echo:{"hello":"world"}');
    await client.close();
  }, 20000);

  it('envRefs 解析：${VAR} 唯一通道；非占位形态与缺失环境变量均 fail-fast（D-29 语义前置）', () => {
    expect(resolveEnvRefs({ API_KEY: '${OK_VAR}' }, { OK_VAR: 'v1' } as NodeJS.ProcessEnv)).toEqual({ API_KEY: 'v1' });
    expect(() => resolveEnvRefs({ API_KEY: 'sk-literal' }, {})).toThrow(/\$\{...\}/);
    expect(() => resolveEnvRefs({ API_KEY: '${MISSING_VAR}' }, {})).toThrow(/MISSING_VAR/);
  });

  it('stdioTransportFactory 校验：http/sse 字段位预留本期拒绝；command 缺失拒绝', () => {
    expect(() => stdioTransportFactory({ transport: 'http' })).toThrow(/stdio/);
    expect(() => stdioTransportFactory({ transport: 'stdio' })).toThrow(/command/);
    const t = stdioTransportFactory({ transport: 'stdio', command: process.execPath, args: ['--version'] });
    expect(t).toBeInstanceOf(StdioMcpTransport);
  });
});

// ============================================================
// §4.2 connect 流水线（A-12）
// ============================================================

describe('WP-4B 批次一 A-12：`tool mcp connect` 接入流水线', () => {
  it('A-12 主断言：--yes 全部缺省 L3 登记（kind=external、source=mcp:weather）+ 审计齐 + 留痕 + 计时 + Spec 片段', async () => {
    const h = makeHarness();
    const result = await connectFixture(h);

    expect(result.aborted).toBe(false);
    expect(result.registrations).toHaveLength(2);
    for (const reg of result.registrations) {
      expect(reg.riskLevel).toBe('L3'); // 缺省 L3（D-27）
      const row = h.rt.registry.getTool(reg.toolId)!;
      expect(row.kind).toBe('external');
      expect(row.source).toBe('mcp:weather');
      expect(row.registeredBy).toBe('tester'); // 确认清单留痕落点（审计载荷）
    }
    expect(result.registrations.map((r) => r.toolId)).toEqual([toolIdOf('weather', 'echo'), toolIdOf('weather', 'fail')]);
    expect(result.serverInfo).toEqual({ name: 'fixture-inproc', version: '9.9.9' });
    expect(result.spawnMs).toBeGreaterThanOrEqual(0); // spawn+initialize 往返计时（健康检查并入 connect）
    expect(result.listMs).toBeGreaterThanOrEqual(0);

    const audits = auditOf(h, 'tool_registered').filter((a) => JSON.parse(a.payload).source === 'mcp:weather');
    expect(audits).toHaveLength(2);
    for (const a of audits) {
      const payload = JSON.parse(a.payload) as { registeredBy: string; source: string; riskLevel: string };
      expect(payload.registeredBy).toBe('tester');
      expect(payload.source).toBe('mcp:weather');
      expect(payload.riskLevel).toBe('L3');
    }
  });

  it('Schema 转换：maximum/minimum 机械转译 paramRanges 候选；enum 进提示；Spec 声明片段可直接消费（P1-3 搬运通道）', async () => {
    const h = makeHarness();
    const result = await connectFixture(h);
    const echo = result.candidates.find((c) => c.mcpName === 'echo')!;
    expect(echo.paramRanges).toEqual({ days: { min: 1, max: 7 } }); // 受控字段候选（编写建议，非执行面）
    expect(echo.enumNotes).toEqual(['mode']); // enum 无法映射 paramRanges → 提示 agent 作者
    expect(JSON.parse(h.rt.registry.getTool(echo.toolId)!.paramSchema)).toMatchObject({ type: 'object' }); // inputSchema 原样转 paramSchema

    const snippet = JSON.parse(result.specSnippet) as { toolId: string; riskLevel: string; controlledFields?: unknown }[];
    expect(snippet).toHaveLength(2);
    const echoDecl = snippet.find((s) => s.toolId === echo.toolId)!;
    expect(echoDecl.riskLevel).toBe('L3');
    expect(echoDecl.controlledFields).toEqual({ paramRanges: { days: { min: 1, max: 7 } } }); // 镜像进 Spec 才有强制力（A-13 前提）
  });

  it('确认清单：显式评级生效（per-tool L2）；返回 null = 中止不登记；L4 拒绝（D-27 永禁前置）', async () => {
    const h = makeHarness();
    const result = await connectFixture(h, { yes: false, confirm: () => ({ 'weather-echo': 'L2' }) });
    expect(h.rt.registry.getTool('weather-echo')!.riskLevel).toBe('L2');
    expect(h.rt.registry.getTool('weather-fail')).toBeNull(); // 未确认项不登记
    expect(result.registrations.map((r) => r.toolId)).toEqual(['weather-echo']);

    const h2 = makeHarness();
    const aborted = await connectFixture(h2, { yes: false, confirm: () => null });
    expect(aborted.aborted).toBe(true);
    expect(h2.rt.registry.listTools({ kind: 'external' })).toEqual([]);

    const h3 = makeHarness();
    await expect(connectFixture(h3, { yes: false, confirm: () => ({ 'weather-echo': 'L4' }) })).rejects.toThrow(/L4/);
  });

  it('未知 server 名拒绝；非交互无 --yes 无 confirm 拒绝（P3-1）', async () => {
    const h = makeHarness();
    await expect(
      connectMcpServer({ registry: h.rt.registry, servers: SERVERS, who: 't', transportFactory: inProcFactory() }, 'nosuch', { yes: true }),
    ).rejects.toThrow(/nosuch/);
    await expect(connectFixture(h, { yes: false })).rejects.toThrow(/--yes/);
  });
});

// ============================================================
// §4.2-3 调用桥（A-13 / A-14）
// ============================================================

describe('WP-4B 批次一 A-13/A-14：external 调用桥', () => {
  async function externalHarness(script: Parameters<typeof makeHarness>[0]): Promise<Harness> {
    const h = mcpHarness(script);
    await connectMcpServer(
      { registry: h.rt.registry, servers: SERVERS, who: 'tester', transportFactory: inProcFactory() },
      'weather',
      { yes: false, confirm: () => ({ 'weather-echo': 'L2', 'weather-fail': 'L2' }) },
    );
    return h;
  }

  it('F-9 端到端：模型请求 external 工具 → gate 同链 → impl Miss → MCP tools/call → 结果回填', async () => {
    const h = await externalHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'weather-echo', args: { city: 'shanghai', days: 3 } }] },
      { kind: 'text', text: validJson },
    ]);
    registerAndRelease(h.rt, sampleSpec({
      agentId: 'mcp-e2e',
      tools: [{ toolId: 'weather-echo', riskLevel: 'L2', controlledFields: { paramRanges: { days: { min: 1, max: 7 } } } }],
    }));
    const taskId = h.rt.tasks.createTask('mcp-e2e', validInput, 't');
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded');
    const types = h.rt.trace.readEvents(taskId).map((e) => e.eventType);
    expect(types).toContain('tool_call_executed');
    // 工具结果确实来自 MCP server（echo 载荷出现在第二轮模型请求的 tool_results 中）
    const second = h.provider.receivedCalls[1];
    const toolResults = (second.messages as unknown as { role: string; results: { content: unknown }[] }[]).find((m) => m.role === 'tool_results')!;
    expect((toolResults.results[0].content as { content: string }).content).toBe('echo:{"city":"shanghai","days":3}');
  });

  it('A-13 同链同 reasonCode：external 未声明 → not_declared_in_spec；L2 参数越界 → param_out_of_range', async () => {
    const h = await externalHarness([
      { kind: 'tool_use', calls: [
        { id: 'c1', toolId: 'weather-fail', args: {} }, // 已登记未声明
        { id: 'c2', toolId: 'weather-echo', args: { city: 'x', days: 9 } }, // 声明但越界
      ] },
      { kind: 'text', text: validJson },
    ]);
    const gateSpec = sampleSpec({
      agentId: 'mcp-gate',
      tools: [{ toolId: 'weather-echo', riskLevel: 'L2', controlledFields: { paramRanges: { days: { min: 1, max: 7 } } } }],
    });
    (gateSpec.toolPolicy as Record<string, unknown>).maxConsecutiveDenials = 5; // 两次 denied 是本用例输入，非终局条件
    registerAndRelease(h.rt, gateSpec);
    const taskId = h.rt.tasks.createTask('mcp-gate', validInput, 't');
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('succeeded'); // denied 是结构化反馈非终局
    const denied = h.rt.trace.readEvents(taskId).filter((e) => e.eventType === 'policy_denied');
    expect(denied.map((e) => (e as unknown as { reasonCode: string }).reasonCode)).toEqual(['not_declared_in_spec', 'param_out_of_range']);
  });

  it('A-14 归因不漂移：MCP isError → attempt 重试 → 终局 Tool(execution_failed)，与 builtin 同构', async () => {
    const h = await externalHarness([
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'weather-fail', args: {} }] },
    ]);
    registerAndRelease(h.rt, sampleSpec({
      agentId: 'mcp-fail',
      tools: [{ toolId: 'weather-fail', riskLevel: 'L2', controlledFields: { paramRanges: {} } }], // L2 须声明受控字段（R-3）
    }));
    const taskId = h.rt.tasks.createTask('mcp-fail', validInput, 't');
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    expect(row.terminalFailureClass).toBe('Tool(execution_failed)');
    const attempts = h.rt.trace.readEvents(taskId).filter((e) => e.eventType === 'attempt_failed');
    expect(attempts).toHaveLength(3); // maxAttempts=3 全部重试后终局
    expect(attempts.map((a) => (a as unknown as { willRetry: boolean }).willRetry)).toEqual([true, true, false]);
  });

  it('A-14 单元面：externalCall 超时 → Tool(timeout)；抛错 → Tool(execution_failed)（同构断言）', async () => {
    const h = mcpHarness();
    h.rt.registry.registerTool(
      {
        toolId: 'weather-slow', name: '慢工具', kind: 'external', riskLevel: 'L2',
        implVersion: 'mcp-9', paramSchema: '{}', controlledFieldsSchema: null, status: 'active', source: 'mcp:weather',
      },
      't',
    );
    const make = (externalCall: (id: string, args: Record<string, unknown>) => Promise<unknown>, timeoutMs: number) =>
      new ToolExecutor({
        base: { taskId: 'u1', agentId: 'a', agentVersionId: 'v', specContentHash: 'h' },
        trace: h.rt.trace,
        getTool: (id) => h.rt.registry.getTool(id),
        impls: new Map(), // builtin impls Miss → external 分派
        declared: [{ toolId: 'weather-slow', riskLevel: 'L2' }],
        maxConsecutiveDenials: 2, maxAttempts: 2, toolTimeoutMs: timeoutMs,
        getDenialCount: () => 0, setDenialCount: () => {},
        externalCall,
      });

    const slow = make(async () => { await sleep(300); return {}; }, 60);
    await expect(slow.execute(1, 'weather-slow', {})).rejects.toMatchObject({ subClass: 'timeout' });

    const bad = make(async () => { throw new Error('server 不可达'); }, 5000);
    const err = await bad.execute(2, 'weather-slow', {}).catch((e) => e as ToolTerminalFailure);
    expect(err).toBeInstanceOf(ToolTerminalFailure);
    expect(err.subClass).toBe('execution_failed');
  });

  it('F-10-① 断连处置：server 配置缺失/不可达 → 结构化失败（不静默跳过、不缓存）', async () => {
    const h = makeHarness(); // 未注入 mcpServers
    h.rt.registry.registerTool(
      {
        toolId: 'weather-echo', name: '回显', kind: 'external', riskLevel: 'L2',
        implVersion: 'mcp-9', paramSchema: '{}', controlledFieldsSchema: null, status: 'active', source: 'mcp:weather',
      },
      't',
    );
    const bridge = new McpToolBridge({ db: dbOf(h), servers: {} });
    await expect(bridge.call('weather-echo', {})).rejects.toThrow(/weather/); // 无 server 配置 → 结构化拒绝
    // 非 external 工具不走 MCP 桥
    await expect(bridge.call('docs-list', {})).rejects.toThrow(/external/);
  });
});
