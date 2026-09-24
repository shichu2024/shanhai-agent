import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { makeHarness, type Harness } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { ToolExecutor } from '../src/modules/toolExecutor.js';
import type { RiskLevel } from '../src/types.js';

// WP-4B 批次一 §4.1：青龙·工具注册中心（元数据 3 列 + retire + listTools 过滤）。
// 独立文件（不含 mcp 导入）：红阶段对既有代码逐断言失败。

function dbOf(h: Harness): Database.Database {
  return (h.rt as unknown as { db: Database.Database }).db;
}

function auditOf(h: Harness, eventType: string): { payload: string; who: string }[] {
  return dbOf(h)
    .prepare(`SELECT who, payload FROM audit_events WHERE eventType = ? ORDER BY whenAt`)
    .all(eventType) as { payload: string; who: string }[];
}

describe('WP-4B 批次一 §4.1：注册中心元数据与 CLI 模块面', () => {
  it('tool_registry 元数据 3 列：存量库 ADD COLUMN 原地迁移，零回填（新列默认 NULL）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-mig-'));
    const raw = new Database(path.join(dir, 'shanhai.db'));
    // 建旧 schema（无 source/registeredBy/description 三列）+ 一行存量数据
    raw.exec(`
      CREATE TABLE tool_registry (
        toolId TEXT PRIMARY KEY, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('builtin','external')),
        riskLevel TEXT NOT NULL CHECK (riskLevel IN ('L0','L1','L2','L3','L4')),
        implVersion TEXT NOT NULL, paramSchema TEXT NOT NULL,
        controlledFieldsSchema TEXT, status TEXT NOT NULL CHECK (status IN ('active','retired')),
        registeredAt TEXT NOT NULL
      );
    `);
    raw.prepare(`INSERT INTO tool_registry VALUES ('legacy-tool','旧工具','builtin','L0','0.0.1','{}',NULL,'active','2020-01-01')`).run();
    raw.close();

    openDatabase(dir); // 迁移：ADD COLUMN ×3
    const db = new Database(path.join(dir, 'shanhai.db'));
    const cols = (db.prepare(`PRAGMA table_info(tool_registry)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['source', 'registeredBy', 'description']));
    const row = db.prepare(`SELECT * FROM tool_registry WHERE toolId='legacy-tool'`).get() as Record<string, unknown>;
    expect(row.source).toBeNull(); // 零回填：新列默认 NULL
    expect(row.registeredBy).toBeNull();
    expect(row.description).toBeNull();
    expect(row.name).toBe('旧工具'); // 存量数据保留
    db.close();
  });

  it('A-12 元数据落点：registerTool(external) 携带 source/registeredBy/description 落库 + 审计载荷含 registeredBy 与来源（留痕）', () => {
    const h = makeHarness();
    h.rt.registry.registerTool(
      {
        toolId: 'wx__query', name: '天气查询', kind: 'external', riskLevel: 'L3',
        implVersion: 'mcp-1.0.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active',
        source: 'mcp:wx', registeredBy: 'alice', description: '外部天气服务',
      },
      'alice',
    );
    const row = h.rt.registry.getTool('wx__query')!;
    expect(row.kind).toBe('external');
    expect(row.source).toBe('mcp:wx');
    expect(row.registeredBy).toBe('alice');
    expect(row.description).toBe('外部天气服务');

    const audits = auditOf(h, 'tool_registered').filter((a) => {
      const p = JSON.parse(a.payload) as { source?: string };
      return p.source === 'mcp:wx';
    });
    expect(audits).toHaveLength(1); // builtin 种子登记（3 条）不带 source，不混入
    const payload = JSON.parse(audits[0].payload) as { registeredBy?: string; source?: string; riskLevel?: string };
    expect(payload.registeredBy).toBe('alice');
    expect(payload.source).toBe('mcp:wx');
    expect(payload.riskLevel).toBe('L3');
    // builtin 种子登记不带来源（缺省 NULL，不伪造）
    const builtin = h.rt.registry.getTool('docs-list')!;
    expect(builtin.source).toBeNull();
    expect(builtin.registeredBy).toBeNull();
  });

  it('重登记路径同样写入元数据；等级只升不降语义在新列在场时保持', () => {
    const h = makeHarness();
    const base = {
      toolId: 'wx__query', name: '天气查询', kind: 'external', riskLevel: 'L3' as RiskLevel,
      implVersion: 'mcp-1.0.0', paramSchema: '{}', controlledFieldsSchema: null as string | null, status: 'active' as const,
      source: 'mcp:wx', registeredBy: 'alice', description: 'v1',
    };
    h.rt.registry.registerTool(base, 'alice');
    h.rt.registry.registerTool({ ...base, description: 'v2', implVersion: 'mcp-2.0.0' }, 'alice');
    expect(h.rt.registry.getTool('wx__query')!.description).toBe('v2');
    expect(() => h.rt.registry.registerTool({ ...base, riskLevel: 'L2' }, 'alice')).toThrow(/只能升不能降/);
  });

  it('retireTool：status=retired + tool_reregistered 审计载荷 action=retire；在飞调用点按已退役拦截', async () => {
    const h = makeHarness();
    h.rt.registry.registerTool(
      {
        toolId: 'wx__query', name: '天气查询', kind: 'external', riskLevel: 'L3',
        implVersion: 'mcp-1.0.0', paramSchema: '{}', controlledFieldsSchema: null, status: 'active',
        source: 'mcp:wx', registeredBy: 'alice',
      },
      'alice',
    );
    h.rt.registry.retireTool('wx__query', 'ops');
    expect(h.rt.registry.getTool('wx__query')!.status).toBe('retired');
    const audits = auditOf(h, 'tool_reregistered');
    expect(audits).toHaveLength(1);
    const payload = JSON.parse(audits[0].payload) as { action?: string; registeredBy?: string };
    expect(payload.action).toBe('retire');
    expect(audits[0].who).toBe('ops');

    // 既有闸门行为（§4.1 表：在飞调用点「已退役不可调用」拦截）
    const exec = new ToolExecutor({
      base: { taskId: 't1', agentId: 'a', agentVersionId: 'v', specContentHash: 'h' },
      trace: h.rt.trace,
      getTool: (id) => h.rt.registry.getTool(id),
      impls: new Map(),
      declared: [{ toolId: 'wx__query', riskLevel: 'L3' }],
      maxConsecutiveDenials: 5, maxAttempts: 1, toolTimeoutMs: 1000,
      getDenialCount: () => 0, setDenialCount: () => {},
    });
    const outcome = await exec.execute(1, 'wx__query', {});
    expect(outcome.outcome).toBe('denied');
    expect((outcome as { denied: { reasonCode: string } }).denied.reasonCode).toBe('not_declared_in_spec');
    expect(() => h.rt.registry.retireTool('nonexistent', 'ops')).toThrow(/不存在/);
  });

  it('listTools 过滤：kind / riskLevel（CLI `tool list` 模块面）', () => {
    const h = makeHarness();
    const all = h.rt.registry.listTools();
    expect(all.length).toBeGreaterThanOrEqual(3); // builtin 种子
    expect(h.rt.registry.listTools({ kind: 'external' })).toEqual([]);
    expect(h.rt.registry.listTools({ kind: 'builtin' }).every((t) => t.kind === 'builtin')).toBe(true);
    expect(h.rt.registry.listTools({ riskLevel: 'L0' }).every((t) => t.riskLevel === 'L0')).toBe(true);
  });
});
