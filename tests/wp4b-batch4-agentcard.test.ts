import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { makeHarness, sampleSpec, registerAndRelease, validationDepsOf, type Harness } from './helpers.js';
import { buildAgentCard, CARD_MISSION_MAX_CHARS, type AgentCard } from '../src/modules/agentCard.js';
import { RegistrationError, type SpecRow } from '../src/modules/registry.js';
import { scanForRelease } from '../src/scripts/releaseScan.js';
import { loadRuntimeConfig, ConfigError } from '../src/config.js';

// WP-4B 批次四（§4.5 + 收官终检）：A-22 Agent Card 只读派生 + P3-2 resultMaxChars fail-fast（随批携带）。
// contentHash 字段保留但一致性断言删（V0.2 修剪：只读现算无漂移面）——本文件仅断言字段存在与取自快照行。

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 全库内容快照（只读派生断言：card 构建前后完全一致——含 audit_events，card 不产生审计事件） */
function dbDump(db: Database.Database): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    parts.push(`${t}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

/** L2 工具 + controlledFields 声明的 Spec（tools[] 摘要断言基座） */
function cardSpec(agentId: string): Record<string, unknown> {
  return sampleSpec({
    agentId,
    tools: [
      {
        toolId: 'web-search',
        riskLevel: 'L2',
        controlledFields: { paramRanges: { limit: { min: 1, max: 20 } }, targetWhitelist: ['docs', 'web'] },
      },
    ],
    extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
  });
}

function registerCardAgent(h: Harness, agentId = 'card-agent'): string {
  h.rt.registry.registerTool(
    {
      toolId: 'web-search', name: 'web-search', kind: 'builtin', riskLevel: 'L2',
      implVersion: '0.1.0', paramSchema: '{}', controlledFieldsSchema: '{"paramRanges":{"limit":{"min":1,"max":50}},"targetWhitelist":["docs","web","api"]}', status: 'active',
    },
    'test',
  );
  return registerAndRelease(h.rt, cardSpec(agentId));
}

// ============================================================
// A-22：Agent Card 只读派生（§4.5 字段集严格冻结）
// ============================================================

describe('WP-4B 批次四 A-22：Agent Card 只读派生', () => {
  it('字段集严格按 §4.5 表（身份锚定 4 字段 + mission/nonGoals + tools[] + 契约摘要 + 治理姿态摘要）', () => {
    const h = makeHarness([]);
    const versionId = registerCardAgent(h);
    const card = h.rt.registry.agentCard('card-agent');
    expect(Object.keys(card).sort()).toEqual(
      ['agentId', 'versionId', 'specVersion', 'contentHash', 'mission', 'nonGoals', 'tools', 'inputContract', 'outputContract', 'budgets', 'approvalPolicy', 'evolutionPolicy'].sort(),
    );
    // 身份锚定：4 字段全部取自 AgentVersion 快照（contentHash 字段保留——V0.2 仅删一致性断言，不删字段）
    expect(card.agentId).toBe('card-agent');
    expect(card.versionId).toBe(versionId);
    expect(card.specVersion).toBe('1');
    expect(card.contentHash).toBe(h.rt.registry.getVersion(versionId)!.contentHash);
  });

  it('mission / nonGoals / tools[] / 契约摘要 / 治理姿态摘要：内容与 Spec 声明对应', () => {
    const h = makeHarness([]);
    registerCardAgent(h);
    const card = h.rt.registry.agentCard('card-agent');
    expect(card.mission.responsibilities).toEqual(['对指定文档集产出结构化摘要']);
    expect(card.nonGoals).toEqual(['修改任何文件内容']);
    // tools[] = 能力面 + 风险面：toolId/riskLevel/controlledFields 摘要（键名 + 白名单计数，不含值域全文）
    expect(card.tools).toHaveLength(1);
    expect(card.tools[0].toolId).toBe('web-search');
    expect(card.tools[0].riskLevel).toBe('L2');
    expect(card.tools[0].controlledFields).toEqual({ paramRangeKeys: ['limit'], targetWhitelistCount: 2 });
    // 契约摘要 = digest + 类型摘要（不含契约全文）
    expect(card.inputContract).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{64}$/), type: 'object' });
    expect(card.outputContract).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{64}$/), type: 'object' });
    // budgets / approvalPolicy / evolutionPolicy 摘要：治理姿态
    expect(card.budgets).toEqual({ allowedModels: ['mock-model'], maxModelCalls: 10, maxTokens: 100000 });
    expect(card.approvalPolicy).toEqual({ mode: 'onHighRisk', timeoutMs: 86400000 });
    expect(card.evolutionPolicy).toBeNull(); // 未声明 → null（等价 allowed:false 的缺省姿态）
  });

  it('缺省当前指针版本；显式 versionId 导出该版本（draft 版本同样可导出——派生面不设状态门）', () => {
    const h = makeHarness([]);
    const released = registerCardAgent(h);
    // 再注册一个 draft 版本（不改指针）
    const draftVersionId = h.rt.registry.registerSpec(
      sampleSpec({ agentId: 'card-agent', tools: [{ toolId: 'web-search', riskLevel: 'L2', controlledFields: { targetWhitelist: ['docs'] } }] }),
      'test',
      validationDepsOf(h.rt),
    );
    expect(h.rt.registry.agentCard('card-agent').versionId).toBe(released); // 缺省 = 指针
    expect(h.rt.registry.agentCard('card-agent', draftVersionId).versionId).toBe(draftVersionId); // 显式版本
    expect(h.rt.registry.agentCard('card-agent', draftVersionId).tools[0].controlledFields).toEqual({ paramRangeKeys: [], targetWhitelistCount: 1 });
  });

  it('只读派生无任何存储写入：全库内容快照前后一致（含 audit_events——card 不产生审计事件）', () => {
    const h = makeHarness([]);
    registerCardAgent(h);
    const before = dbDump(dbOf(h.rt));
    const card = h.rt.registry.agentCard('card-agent');
    const after = dbDump(dbOf(h.rt));
    expect(after).toBe(before); // 零写入（派生制品永不存储——每次从 AgentVersion 快照现算）
    expect(card).toBeTruthy();
  });

  it('T3 联动：card 全字段密钥扫描零命中（card 只含 spec 元数据，输入不含敏感面）', () => {
    const h = makeHarness([]);
    registerCardAgent(h);
    const card = h.rt.registry.agentCard('card-agent');
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-card-t3-'));
    writeFileSync(path.join(dir, 'card.json'), JSON.stringify(card, null, 2));
    expect(scanForRelease(dir)).toEqual([]); // 密钥格式族零命中（与发布扫描同一实现）
  });

  it('防御性截断：mission/nonGoals 项截断至安全长度（纯派生函数直接喂超长项——注册面 zod 已拦，此处防派生面漂移）', () => {
    const row: SpecRow = {
      versionId: 'v-red', agentId: 'card-red', version: 1,
      specSnapshot: JSON.stringify({
        specVersion: '1',
        identity: { agentId: 'card-red', name: 'n', description: 'd' },
        mission: { responsibilities: ['r'.repeat(CARD_MISSION_MAX_CHARS + 50)], nonResponsibilities: ['g'.repeat(CARD_MISSION_MAX_CHARS + 50)] },
        inputContract: { type: 'object' }, outputContract: { type: 'object' },
        modelPolicy: { allowedModels: ['m'], maxModelCalls: 1, maxTokens: 1 },
        toolPolicy: { tools: [{ toolId: 't-tool', riskLevel: 'L0' }] },
      }),
      contentHash: '00', status: 'draft', registeredAt: '0', registeredBy: 't',
    };
    const card: AgentCard = buildAgentCard(row);
    expect(card.mission.responsibilities[0]).toHaveLength(CARD_MISSION_MAX_CHARS);
    expect(card.nonGoals[0]).toHaveLength(CARD_MISSION_MAX_CHARS);
  });

  it('无指针版本 → 结构化拒绝；versionId 不属于该 agent → 结构化拒绝', () => {
    const h = makeHarness([]);
    registerCardAgent(h);
    expect(() => h.rt.registry.agentCard('ghost-agent')).toThrow(RegistrationError); // 无指针
    const otherVersion = registerAndRelease(h.rt, sampleSpec({ agentId: 'other-agent' }));
    expect(() => h.rt.registry.agentCard('card-agent', otherVersion)).toThrow(RegistrationError); // 跨 agent 版本
  });

  it('CLI 面：usage 含 agent card 命令行（源文本机械断言）', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
    expect(src).toContain('shanhai agent card <agentId> [versionId]');
  });
});

// ============================================================
// P3-2（随批携带）：mcp.resultMaxChars 非法值 fail-fast（D-29 语义对齐）
// ============================================================

describe('WP-4B 批次四 P3-2：mcp.resultMaxChars 非法值 fail-fast（原静默回退缺省——行为变更属预期演进）', () => {
  function loadWith(mcpSection: unknown): ReturnType<typeof loadRuntimeConfig> {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfg-b4p2-'));
    const file = path.join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: { anthropic: { baseUrl: 'http://localhost:9', authTokenEnv: 'TOK_X', models: ['mock-model'] } },
        mcp: mcpSection,
      }),
    );
    return loadRuntimeConfig({ SHANHAI_CONFIG: file, TOK_X: 'tok' } as NodeJS.ProcessEnv);
  }

  it('resultMaxChars=0 → ConfigError（≤0 非法，fail-fast 不静默回退）', () => {
    expect(() => loadWith({ resultMaxChars: 0 })).toThrow(ConfigError);
    expect(() => loadWith({ resultMaxChars: 0 })).toThrow(/mcp\.resultMaxChars/);
  });

  it('resultMaxChars=-5 → ConfigError', () => {
    expect(() => loadWith({ resultMaxChars: -5 })).toThrow(/mcp\.resultMaxChars/);
  });

  it('resultMaxChars="20000"（字符串）→ ConfigError（非数字非法）', () => {
    expect(() => loadWith({ resultMaxChars: '20000' })).toThrow(/mcp\.resultMaxChars/);
  });

  it('合法值正常解析（500 → { resultMaxChars: 500 }）；缺省段 → undefined（缺省 20000 行为不变）', () => {
    expect(loadWith({ resultMaxChars: 500 }).mcp).toEqual({ resultMaxChars: 500 });
    expect(loadWith({ resultMaxChars: 500.9 }).mcp).toEqual({ resultMaxChars: 500 }); // 向下取整既有行为不变
    expect(loadWith(undefined).mcp).toBeUndefined();
  });
});
