import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { BUILTIN_TOOL_VERSION } from '../src/tools/builtin.js';
import { hostAllowed } from '../src/portal/auth.js';
import { getContractBody } from '../src/modules/specValidator.js';
import { McpToolBridge } from '../src/mcp/bridge.js';
import { connectMcpServer } from '../src/mcp/connect.js';
import { InProcMcpTransport, type McpServerConfig } from '../src/mcp/client.js';
import { inProcMcpHandler } from './fixtures/inProcMcpServer.js';
import { makeHarness, sampleSpec, registerAndRelease, validInput, validationDepsOf, type Harness } from './helpers.js';

// wp264（第五十批 · 覆盖加固蓄余量）：纯测试触达的低风险只读/错误分支补测。
// 覆盖面分组：auth Host 校验防御 ×3（IPv4 越界段 / IPv6 方括号内无冒号 / 首段非十六进制）/
// evolution 触发器过滤跳过 ×1（triggers 不含 repeated_failure → 不聚合）/
// specValidator stripAllowEmpty 非对象防御 ×1（getContractBody(null/数组) 原样返回）/
// runtime startup 内置工具版本漂移重登记 ×1（implVersion 过期 → 重登记回 BUILTIN_TOOL_VERSION）/
// mcp bridge source 形态防御 ×1（external 工具 source 非 mcp:<server> → 拒绝分派）/
// taskManager 灰度缺省 roll ×1（未注入 dispatchRoll → Math.random 兜底路径）/
// connect 生成 toolId 字符集 fail-fast ×2（server 工具名不合规 → 结构化拒绝）。
// 零 src 改动、零门值改动、零既有用例改动。

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 造一个契约失败任务（Model(schema_violation) 终局，批次三同款驱动） */
async function runFailingTask(h: Harness, agentId: string): Promise<void> {
  const failing = JSON.stringify({ broken: true });
  h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
  const t = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(t);
  expect(row.status).toBe('failed');
}

describe('wp264 覆盖加固：auth Host 校验防御分支', () => {
  it('通配绑定 + 点分四段但段值越界（>255）→ 拒绝（非 IP 形态不进私网白名单）', () => {
    expect(hostAllowed('999.1.1.1:8080', '0.0.0.0')).toBe(false);
  });

  it('通配绑定 + IPv6 方括号形态但内部无冒号 → 拒绝', () => {
    expect(hostAllowed('[abc]:8080', '::')).toBe(false);
  });

  it('通配绑定 + IPv6 首段非十六进制（NaN）→ 拒绝', () => {
    expect(hostAllowed('[gg::1]:8080', '::')).toBe(false);
  });
});

describe('wp264 覆盖加固：evolution 触发器过滤', () => {
  it('policy.allowed 但 triggers 不含 repeated_failure → 达阈值也不聚合（触发面由 policy 显式圈定）', async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({
      agentId: 'wp264-trig',
      extraTop: { evolutionPolicy: { allowed: true, failureThreshold: 3, triggers: ['capability_degradation'] } },
    });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'wp264-trig');
    const created = h.rt.evolutions.aggregateRepeatedFailures((id) => h.rt.registry.evolutionPolicyOf(id));
    expect(created).toEqual([]); // 失败记录已足量，但触发器不匹配 → 跳过
    const rows = dbOf(h.rt).prepare(`SELECT COUNT(*) AS c FROM failure_record WHERE agentId = 'wp264-trig'`).get() as { c: number };
    expect(rows.c).toBeGreaterThan(0); // 前置证实：非「无失败记录」的空转通过
  });
});

describe('wp264 覆盖加固：specValidator stripAllowEmpty 非对象防御', () => {
  it('getContractBody(null) → 原样返回（allowEmpty 剥离仅对普通对象生效）', () => {
    expect(getContractBody(null as unknown as Record<string, unknown>)).toBe(null);
  });

  it('getContractBody(数组) → 原样返回（数组不进对象解构路径）', () => {
    const arr = ['not', 'an', 'object'];
    expect(getContractBody(arr as unknown as Record<string, unknown>)).toBe(arr);
  });
});

describe('wp264 覆盖加固：runtime 内置工具版本漂移重登记', () => {
  it('tool_registry 中内置工具 implVersion 过期 → startup() 重登记回 BUILTIN_TOOL_VERSION', () => {
    const h = makeHarness([]);
    dbOf(h.rt).prepare(`UPDATE tool_registry SET implVersion = 'stale-9.9.9' WHERE toolId = 'docs-list'`).run();
    expect(h.rt.registry.getTool('docs-list')!.implVersion).toBe('stale-9.9.9'); // 前置证实：漂移已注入
    h.rt.startup('re-test');
    expect(h.rt.registry.getTool('docs-list')!.implVersion).toBe(BUILTIN_TOOL_VERSION); // 漂移被收敛
    expect(h.rt.registry.getTool('docs-list')!.status).toBe('active');
  });
});

describe('wp264 覆盖加固：mcp bridge source 形态防御', () => {
  it('external 工具 source 非 mcp:<server> 形态 → 调用桥拒绝分派', async () => {
    const h = makeHarness([]);
    h.rt.registry.registerTool(
      {
        toolId: 'wp264-ext-bad', name: 'wp264-ext-bad', kind: 'external', riskLevel: 'L0',
        implVersion: 'x', paramSchema: '{}', controlledFieldsSchema: null, status: 'active',
        source: 'https://example.com/somewhere',
      },
      'test',
    );
    const bridge = new McpToolBridge({ db: dbOf(h.rt), servers: {} });
    await expect(bridge.call('wp264-ext-bad', {})).rejects.toThrow(/source 非 mcp:<server> 形态/);
  });
});

describe('wp264 覆盖加固：taskManager 灰度缺省 roll 兜底', () => {
  it('未注入 dispatchRoll → Math.random 兜底路径参与灰度分派（结果确定性由 random 桩固定）', () => {
    const h = makeHarness([]); // 不注入 dispatchRoll
    const v1 = registerAndRelease(h.rt, sampleSpec({ agentId: 'wp264-roll' }));
    const v2Spec = sampleSpec({ agentId: 'wp264-roll', modelPolicy: { maxModelCalls: 11, maxTokens: 100000 } });
    const v2 = h.rt.registry.registerSpec(v2Spec, 'a', validationDepsOf(h.rt));
    h.rt.registry.release('wp264-roll', v2, 'a', { noPointer: true });
    h.rt.registry.canarySet('wp264-roll', v2, 50, 'op');
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.01); // roll = floor(0.01*100) = 1 < 50 → canary
    try {
      const t = h.rt.tasks.createTask('wp264-roll', validInput, 't');
      expect(h.rt.tasks.getTask(t).assignmentSource).toBe('canary');
    } finally {
      spy.mockRestore();
    }
    expect(v1).toBeTruthy();
  });
});

describe('wp264 覆盖加固：connect 生成 toolId 字符集 fail-fast', () => {
  const SERVERS: Record<string, McpServerConfig> = { weather: { transport: 'stdio', command: 'inproc-fixture' } };

  it('server 工具名含非法字符（下划线/大写）→ 生成的 toolId 不合规即结构化拒绝', async () => {
    const h = makeHarness([], process.cwd(), {
      mcpServers: SERVERS,
      mcpTransportFactory: () => new InProcMcpTransport(inProcMcpHandler([{ name: 'Bad_Tool' }])),
    });
    await expect(
      connectMcpServer(
        { registry: h.rt.registry, servers: SERVERS, who: 'tester', transportFactory: () => new InProcMcpTransport(inProcMcpHandler([{ name: 'Bad_Tool' }])) },
        'weather',
        { yes: true },
      ),
    ).rejects.toThrow(/生成 toolId 不符合 Spec 声明字符集/);
    expect(h.rt.registry.getTool('weather-Bad_Tool')).toBeNull(); // 未登记（fail-fast 先于批量登记）
  });
});
