import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { ConfigError } from '../src/config.js';
import { buildCapabilityTrend } from '../src/modules/trend.js';
import { buildAgentInsight } from '../src/modules/insight.js';
import { buildAgentReport } from '../src/modules/report.js';
import type { CapabilityRow } from '../src/modules/capabilityRegistry.js';
import { queryT1 } from '../src/evidence.js';
import { makeHarness, sampleSpec, registerAndRelease, validationDepsOf, validInput, validOutput } from './helpers.js';
import { startPortalServer, stopPortalServer, envPortalPort, type PortalHandle } from '../src/portal/server.js';
import { parseHash } from '../src/portal/view/router.js';
import { eventSummary } from '../src/portal/view/events.js';
import { parseRefInput, evidenceSummary } from '../src/portal/view/evidence.js';
import { capabilitySummary, trendSummary } from '../src/portal/view/capability.js';
import { insightSummary, reportSummary } from '../src/portal/view/agent.js';
import { evolutionSummary } from '../src/portal/view/evolution.js';

// WP-6B 批次二（6-2/4）：读面全景。
// DoD 断言：A-37 全量（events/evidence/capability+trend/insight/card/report/evolution 读端点
//           与对应 Manager/构建函数输出深度相等——时点漂移字段按类型归一，批次一先例）；
//           TrendError → 400 族结构化错误；空 Registry 非错误口径与 CLI 一致；
//           门户层零写入零审计（dbDump 快照断言，derived/聚合惰性写 settle 后验证）；
//           P3-② SHANHAI_PORTAL_PORT 非数字 fail-fast（对齐 D-49 严格口径）。
// 稳定性注（TASK-119）：本文件真实 server 往返用例统一显式 timeout=20s——历史上三次
//           （TASK-96/110/116 验收期）trend 族用例在高负载下以 5000ms 出头（如 5147ms）
//           触发 vitest 缺省 5s 超时红，属余量不足非代码缺陷；此处收口余量，断言与被测面不变。

const validJson = JSON.stringify(validOutput());
const failing = JSON.stringify({ broken: true });
const TOKEN = { Authorization: 'Bearer test-token-0000000000000000000000000000' };

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function dbDump(db: Database.Database): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    parts.push(`${t}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

interface TestResponse {
  status: number;
  body: string;
}

function httpRequest(port: number, method: string, pathName: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const servers: PortalHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await stopPortalServer(s);
});

async function startTestServer(rt: Runtime): Promise<PortalHandle> {
  const dir = mkdtempSync(path.join(tmpdir(), 'shanhai-srv-'));
  const handle = await startPortalServer(rt, { dataDir: dir, repoRoot: process.cwd(), host: '127.0.0.1', port: 0, token: 'test-token-0000000000000000000000000000' });
  servers.push(handle);
  return handle;
}

/** 造一个契约失败任务（Model(schema_violation) 终局，3 attempts）——evolution/failure 面种子 */
async function runFailingTask(h: ReturnType<typeof makeHarness>, agentId: string): Promise<void> {
  h.provider.script.push({ kind: 'text', text: failing }, { kind: 'text', text: failing }, { kind: 'text', text: failing });
  const t = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(t);
  expect(row.status).toBe('failed');
}

function policiesOf(rt: Runtime, agentId: string) {
  return rt.registry.evolutionPolicyOf(agentId);
}

// ---------- A-37：events 时间线 ----------

describe('WP6B2-1 GET /api/tasks/:id/events（A-37：与 trace.readEvents 深度相等）', () => {
  it('事件原样返回（信封 + 载荷逐字段相等）；未知任务 → 404', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-a' }));
    const t = h.rt.tasks.createTask('rd-a', validInput, 't');
    await h.rt.tasks.runTask(t);
    const handle = await startTestServer(h.rt);

    const res = await httpRequest(handle.port, 'GET', `/api/tasks/${t}/events`, TOKEN);
    expect(res.status).toBe(200);
    const events = JSON.parse(res.body) as { eventId: string; eventType: string }[];
    expect(events).toEqual(h.rt.trace.readEvents(t));
    expect(events.map((e) => e.eventType)).toContain('task_started');
    expect(events.map((e) => e.eventType)).toContain('task_succeeded');

    const missing = await httpRequest(handle.port, 'GET', '/api/tasks/no-such-task/events', TOKEN);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('not_found');
  });
});

// ---------- A-37：evidence 两端点 ----------

describe('WP6B2-2 evidence 端点（A-37：与 EvidenceStore 深度相等；payload 字节原样）', () => {
  it('GET /api/tasks/:id/evidence 与 taskEvidence 深度相等；未知任务 → 404 not_found', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-ev' }));
    const t = h.rt.tasks.createTask('rd-ev', validInput, 't');
    await h.rt.tasks.runTask(t);
    const handle = await startTestServer(h.rt);

    const res = await httpRequest(handle.port, 'GET', `/api/tasks/${t}/evidence`, TOKEN);
    expect(res.status).toBe(200);
    const chain = JSON.parse(res.body);
    expect(chain).toEqual(h.rt.evidence.taskEvidence(t));
    expect(chain.ok).toBe(true);
    expect(chain.trace.consistent).toBe(true);

    const missing = await httpRequest(handle.port, 'GET', '/api/tasks/no-such-task/evidence', TOKEN);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('not_found');
  });

  it('GET /api/evidence/:ref 各 kind 与 show 深度相等；eval → 501；未知 → 404；非法 ref → 400', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rd-ref' }));
    const ok = h.rt.tasks.createTask('rd-ref', validInput, 't');
    h.provider.script.push({ kind: 'text', text: validJson });
    await h.rt.tasks.runTask(ok);
    await runFailingTask(h, 'rd-ref');
    const handle = await startTestServer(h.rt);
    const failureId = (dbOf(h.rt).prepare(`SELECT recordId FROM failure_record LIMIT 1`).get() as { recordId: string }).recordId;
    const eventId = (JSON.parse(JSON.stringify(h.rt.trace.readEvents(ok))) as { eventId: string }[])[0].eventId;

    for (const ref of [`task:${ok}`, `trace_event:${eventId}`, `failure:${failureId}`]) {
      const res = await httpRequest(handle.port, 'GET', `/api/evidence/${encodeURIComponent(ref)}`, TOKEN);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(h.rt.evidence.show(ref));
    }

    const evalRef = await httpRequest(handle.port, 'GET', `/api/evidence/${encodeURIComponent('eval:whatever')}`, TOKEN);
    expect(evalRef.status).toBe(501);
    expect(JSON.parse(evalRef.body).code).toBe('not_implemented');

    const unknown = await httpRequest(handle.port, 'GET', `/api/evidence/${encodeURIComponent('task:no-such')}`, TOKEN);
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body).code).toBe('not_found');

    const badRef = await httpRequest(handle.port, 'GET', `/api/evidence/${encodeURIComponent('no-colon')}`, TOKEN);
    expect(badRef.status).toBe(400);
    expect(JSON.parse(badRef.body).code).toBe('invalid_ref');
    const badKind = await httpRequest(handle.port, 'GET', `/api/evidence/${encodeURIComponent('ghost:x')}`, TOKEN);
    expect(badKind.status).toBe(400);
    expect(JSON.parse(badKind.body).code).toBe('invalid_ref');
  });
});

// ---------- A-37：capability 列表（CLI 投影形状）+ 零写入 ----------

describe('WP6B2-3 GET /api/capabilities（A-37：CLI capability list 投影深度相等）', () => {
  it('投影形状与 CLI 相同（12 键冻结集）；过滤参数透传；非法 kind/status → 400', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'cap-a' }));
    const t = h.rt.tasks.createTask('cap-a', validInput, 't');
    await h.rt.tasks.runTask(t);

    // 种子：草稿（无证据）+ 已确认（task 证据）
    h.rt.capabilities.add({ agentId: 'cap-a', kind: 'capability', statement: '能对文档产出结构化摘要', by: 't' });
    const withEvidence = h.rt.capabilities.add({ agentId: 'cap-a', kind: 'limitation', statement: '不修改任何文件', evidence: [`task:${t}`], by: 't' });
    h.rt.capabilities.confirm(withEvidence.capabilityId, 't');
    h.rt.capabilities.list(); // settle：derived 惰性重算既有语义（与 CLI 同构）——之后门户读零写入
    const handle = await startTestServer(h.rt);

    const res = await httpRequest(handle.port, 'GET', '/api/capabilities', TOKEN);
    expect(res.status).toBe(200);
    const rows = JSON.parse(res.body) as Record<string, unknown>[];
    const cliShape = (r: CapabilityRow) => ({
      capabilityId: r.capabilityId, agentId: r.agentId, kind: r.kind, origin: r.origin,
      statement: r.statement, statementDigest: r.statementDigest, status: r.status,
      evidenceRefs: JSON.parse(r.evidenceRefs), evidencePending: (JSON.parse(r.evidenceRefs) as unknown[]).length === 0,
      createdAt: r.createdAt, decidedAt: r.decidedAt, decidedBy: r.decidedBy,
    });
    expect(rows).toEqual(h.rt.capabilities.list().map(cliShape));
    // 键集冻结（与 CLI 输出形状逐键一致）
    expect(Object.keys(rows[0])).toEqual([
      'capabilityId', 'agentId', 'kind', 'origin', 'statement', 'statementDigest', 'status',
      'evidenceRefs', 'evidencePending', 'createdAt', 'decidedAt', 'decidedBy',
    ]);
    const byStatus = rows.find((r) => r.status === 'candidate');
    expect(byStatus?.evidencePending).toBe(true); // 草稿派生标注
    const confirmed = rows.find((r) => r.status === 'active');
    expect(confirmed?.decidedBy).toBe('t');
    expect((confirmed?.evidenceRefs as unknown[]).length).toBe(1);

    const filtered = await httpRequest(handle.port, 'GET', '/api/capabilities?agent=cap-a&kind=limitation&status=active', TOKEN);
    expect(JSON.parse(filtered.body)).toEqual(h.rt.capabilities.list({ agent: 'cap-a', kind: 'limitation', status: 'active' }).map(cliShape));

    const badKind = await httpRequest(handle.port, 'GET', '/api/capabilities?kind=ghost', TOKEN);
    expect(badKind.status).toBe(400);
    const badStatus = await httpRequest(handle.port, 'GET', '/api/capabilities?status=ghost', TOKEN);
    expect(badStatus.status).toBe(400);
  });

  it('空 Registry → 200 空清单非错误（口径与 CLI 一致）', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    const handle = await startTestServer(h.rt);
    const res = await httpRequest(handle.port, 'GET', '/api/capabilities', TOKEN);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

// ---------- A-37：趋势 + TrendError → 400 族 ----------

describe('WP6B2-4 GET /api/agents/:id/trend（A-37 + TrendError 结构化 400）', () => {
  it('显式 since/until → 与 buildCapabilityTrend 深度相等；参数透传（bucket=week）', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'tr-a' }));
    const t = h.rt.tasks.createTask('tr-a', validInput, 't');
    await h.rt.tasks.runTask(t);
    await runFailingTask(h, 'tr-a');
    const handle = await startTestServer(h.rt);
    const since = '2020-01-01T00:00:00Z';
    const until = '2099-01-01T00:00:00Z';

    for (const bucket of [undefined, 'day', 'week']) {
      const qs = `?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}${bucket ? `&bucket=${bucket}` : ''}`;
      const res = await httpRequest(handle.port, 'GET', `/api/agents/tr-a/trend${qs}`, TOKEN);
      expect(res.status).toBe(200);
      const trend = JSON.parse(res.body);
      const expected = buildCapabilityTrend(dbOf(h.rt), h.rt.trace, 'tr-a', {
        since, until, ...(bucket ? { bucket: bucket as 'day' | 'week' } : {}),
      });
      expect(trend).toEqual(expected);
      expect(trend.buckets.length).toBeGreaterThan(0);
    }
  });

  it('缺省 until（时点漂移字段按类型归一，批次一先例）；无数据 agent → 200 空桶（空 Registry 非错误）', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'tr-b' }));
    registerAndRelease(h.rt, sampleSpec({ agentId: 'tr-empty' }));
    const t = h.rt.tasks.createTask('tr-b', validInput, 't');
    await h.rt.tasks.runTask(t);
    const handle = await startTestServer(h.rt);

    const res = await httpRequest(handle.port, 'GET', `/api/agents/tr-b/trend?since=${encodeURIComponent('2020-01-01T00:00:00Z')}`, TOKEN);
    expect(res.status).toBe(200);
    const normalize = (x: { until: unknown }) => ({ ...x, until: typeof x.until });
    expect(normalize(JSON.parse(res.body))).toEqual(normalize(
      buildCapabilityTrend(dbOf(h.rt), h.rt.trace, 'tr-b', { since: '2020-01-01T00:00:00Z' }),
    ));

    const empty = await httpRequest(handle.port, 'GET', '/api/agents/tr-empty/trend', TOKEN);
    expect(empty.status).toBe(200);
    expect((JSON.parse(empty.body) as { buckets: unknown[] }).buckets).toEqual([]);
  });

  it('TrendError → 400 族结构化错误（不裸抛 500）：非法 since / 非法 bucket', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    const handle = await startTestServer(h.rt);

    const badSince = await httpRequest(handle.port, 'GET', '/api/agents/x/trend?since=not-a-date', TOKEN);
    expect(badSince.status).toBe(400);
    expect(JSON.parse(badSince.body)).toMatchObject({ ok: false, code: 'invalid_bound' });

    const badBucket = await httpRequest(handle.port, 'GET', '/api/agents/x/trend?bucket=month', TOKEN);
    expect(badBucket.status).toBe(400);
    expect(JSON.parse(badBucket.body)).toMatchObject({ ok: false, code: 'invalid_bucket' });
  });
});

// ---------- A-37：insight / card / report ----------

describe('WP6B2-5 GET /api/agents/:id/insight（A-37 + 空 Registry 非错误）', () => {
  it('与 buildAgentInsight 深度相等（generatedAt 按类型归一）；versionId/since 透传', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'ins-a' }));
    const t = h.rt.tasks.createTask('ins-a', validInput, 't');
    await h.rt.tasks.runTask(t);
    const handle = await startTestServer(h.rt);
    const deps = { db: dbOf(h.rt), trace: h.rt.trace, registry: h.rt.registry, capabilities: h.rt.capabilities };
    h.rt.capabilities.list(); // settle derived（与 CLI 同构）

    const res = await httpRequest(handle.port, 'GET', `/api/agents/ins-a/insight?since=${encodeURIComponent('2020-01-01T00:00:00Z')}`, TOKEN);
    expect(res.status).toBe(200);
    const normalize = (x: { generatedAt: unknown }) => ({ ...x, generatedAt: typeof x.generatedAt });
    expect(normalize(JSON.parse(res.body))).toEqual(normalize(
      buildAgentInsight(deps, 'ins-a', { since: '2020-01-01T00:00:00Z' }),
    ));
    const answer = JSON.parse(res.body) as { assertions: { emptyHint: string | null }; behavior: { status: string } };
    expect(answer.assertions.emptyHint).not.toBeNull(); // 空 Registry 条目 → 空清单 + 提示（非错误）
    expect(answer.behavior.status).toBe('ok'); // 窗口内有任务数据
  });

  it('未知 agent → 404（RegistrationError → not_found）', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    const handle = await startTestServer(h.rt);
    const res = await httpRequest(handle.port, 'GET', '/api/agents/ghost/insight', TOKEN);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe('not_found');
  });
});

describe('WP6B2-6 GET /api/agents/:id/card（A-37）', () => {
  it('与 registry.agentCard 深度相等（缺省指针 / 显式 versionId）；未知 agent / 版本 → 404', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({ agentId: 'card-a' });
    const v1 = h.rt.registry.registerSpec(spec, 't', validationDepsOf(h.rt));
    h.rt.registry.release('card-a', v1, 't');
    const v2 = h.rt.registry.registerSpec({ ...spec, modelPolicy: { ...spec.modelPolicy, maxModelCalls: 11 } }, 't', validationDepsOf(h.rt));
    h.rt.registry.release('card-a', v2, 't');
    const handle = await startTestServer(h.rt);

    const res = await httpRequest(handle.port, 'GET', '/api/agents/card-a/card', TOKEN);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(h.rt.registry.agentCard('card-a'));

    const explicit = await httpRequest(handle.port, 'GET', `/api/agents/card-a/card?versionId=${encodeURIComponent(v1)}`, TOKEN);
    expect(JSON.parse(explicit.body)).toEqual(h.rt.registry.agentCard('card-a', v1));
    expect((JSON.parse(explicit.body) as { versionId: string }).versionId).toBe(v1);

    const ghost = await httpRequest(handle.port, 'GET', '/api/agents/ghost/card', TOKEN);
    expect(ghost.status).toBe(404);
    const badVersion = await httpRequest(handle.port, 'GET', `/api/agents/card-a/card?versionId=${encodeURIComponent('v-nope')}`, TOKEN);
    expect(badVersion.status).toBe(404);
  });
});

describe('WP6B2-7 GET /api/agents/:id/report（A-37：与 buildAgentReport + queryT1 注入同构）', () => {
  it('深度相等（t1QueryP95Ms 时点漂移按类型归一）；since 透传', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'rep-a' }));
    const t = h.rt.tasks.createTask('rep-a', validInput, 't');
    await h.rt.tasks.runTask(t);
    const handle = await startTestServer(h.rt);

    const res = await httpRequest(handle.port, 'GET', '/api/agents/rep-a/report', TOKEN);
    expect(res.status).toBe(200);
    const normalize = (x: { healthPanel: { t1QueryP95Ms: unknown } }) => ({ ...x, healthPanel: { ...x.healthPanel, t1QueryP95Ms: typeof x.healthPanel.t1QueryP95Ms } });
    expect(normalize(JSON.parse(res.body))).toEqual(normalize(
      buildAgentReport(dbOf(h.rt), 'rep-a', { t1: (taskId) => queryT1(h.rt, taskId) }),
    ));

    const since = await httpRequest(handle.port, 'GET', `/api/agents/rep-a/report?since=${encodeURIComponent('2020-01-01T00:00:00Z')}`, TOKEN);
    expect(normalize(JSON.parse(since.body))).toEqual(normalize(
      buildAgentReport(dbOf(h.rt), 'rep-a', { since: '2020-01-01T00:00:00Z', t1: (taskId) => queryT1(h.rt, taskId) }),
    ));
  });
});

// ---------- A-37：evolution（门户不执行惰性聚合——D-48 零写入） ----------

describe('WP6B2-8 evolution 端点（A-37 + 零写入：门户不聚合）', () => {
  it('未聚合库：GET /api/evolution 不触发惰性聚合（dbDump 不变，返回空清单）；settle 后与 list() 深度相等', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    const spec = sampleSpec({
      agentId: 'evo-a',
      extraTop: { evolutionPolicy: { allowed: true, triggers: ['repeated_failure'], failureThreshold: 3 } },
    });
    registerAndRelease(h.rt, spec);
    for (let i = 0; i < 3; i++) await runFailingTask(h, 'evo-a');
    const handle = await startTestServer(h.rt);

    // 门户读面不执行 CLI 的 aggregateRepeatedFailures（写路径）——未 settle 库上门户读零写入
    const before = dbDump(dbOf(h.rt));
    const early = await httpRequest(handle.port, 'GET', '/api/evolution', TOKEN);
    expect(early.status).toBe(200);
    expect(JSON.parse(early.body)).toEqual([]);
    expect(dbDump(dbOf(h.rt))).toBe(before);

    // settle（CLI 等价惰性聚合）后：深度相等 + 零写入
    h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id));
    const settled = dbDump(dbOf(h.rt));
    const res = await httpRequest(handle.port, 'GET', '/api/evolution', TOKEN);
    expect(JSON.parse(res.body)).toEqual(h.rt.evolutions.list());
    expect((JSON.parse(res.body) as unknown[]).length).toBe(1);

    const candidateId = (JSON.parse(res.body) as { candidateId: string }[])[0].candidateId;
    const one = await httpRequest(handle.port, 'GET', `/api/evolution/${encodeURIComponent(candidateId)}`, TOKEN);
    expect(one.status).toBe(200);
    expect(JSON.parse(one.body)).toEqual(h.rt.evolutions.get(candidateId));

    expect(dbDump(dbOf(h.rt))).toBe(settled); // 全部门户读零写入零审计

    const missing = await httpRequest(handle.port, 'GET', '/api/evolution/no-such-candidate', TOKEN);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('not_found');
  });
});

// ---------- 读面全景零写入 sweep（D-48 纪律，dbDump 快照断言范式沿用） ----------

describe('WP6B2-9 读面全景零写入 sweep（settle 后全端点 GET → dbDump 不变）', () => {
  it('events/evidence/capabilities/card/trend/insight/report/evolution 全景读零写入零审计', { timeout: 20_000 }, async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'sweep-a' }));
    const t = h.rt.tasks.createTask('sweep-a', validInput, 't');
    await h.rt.tasks.runTask(t);
    await runFailingTask(h, 'sweep-a');
    h.rt.capabilities.add({ agentId: 'sweep-a', kind: 'capability', statement: '能产出摘要', by: 't' });
    h.rt.capabilities.list(); // settle derived
    h.rt.evolutions.aggregateRepeatedFailures((id) => policiesOf(h.rt, id)); // settle 聚合（阈值未达 → 无候选，幂等）
    const handle = await startTestServer(h.rt);

    const eventId = h.rt.trace.readEvents(t)[0].eventId;
    const paths = [
      '/api/tasks', `/api/tasks/${t}`, `/api/tasks/${t}/events`, `/api/tasks/${t}/evidence`,
      '/api/approvals', '/api/capabilities', '/api/evolution',
      `/api/evidence/${encodeURIComponent(`task:${t}`)}`,
      `/api/evidence/${encodeURIComponent(`trace_event:${eventId}`)}`,
      '/api/agents/sweep-a/card',
      '/api/agents/sweep-a/insight',
      '/api/agents/sweep-a/report',
      `/api/agents/sweep-a/trend?since=${encodeURIComponent('2020-01-01T00:00:00Z')}&until=${encodeURIComponent('2099-01-01T00:00:00Z')}`,
    ];
    const before = dbDump(dbOf(h.rt));
    for (const p of paths) {
      const res = await httpRequest(handle.port, 'GET', p, TOKEN);
      expect([200]).toContain(res.status);
    }
    expect(dbDump(dbOf(h.rt))).toBe(before);
  });
});

// ---------- P3-②：SHANHAI_PORTAL_PORT fail-fast（随批修复） ----------

describe('WP6B2-10 envPortalPort（P3-②：非数字/非整数/越界 ConfigError 拒启动）', () => {
  it('合法值解析 / 缺省与空串视为未设置', () => {
    expect(envPortalPort({})).toBeUndefined();
    expect(envPortalPort({ SHANHAI_PORTAL_PORT: '' })).toBeUndefined();
    expect(envPortalPort({ SHANHAI_PORTAL_PORT: '7781' })).toBe(7781);
  });
  it('NaN / 非整数 / 越界（0、70000、负数）→ ConfigError fail-fast', () => {
    for (const raw of ['abc', 'NaN', '1.5', '0', '-1', '70000']) {
      expect(() => envPortalPort({ SHANHAI_PORTAL_PORT: raw })).toThrow(ConfigError);
    }
  });
  it('startPortalServer 消费 env 端口：非法值拒启动；合法值生效', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    const prev = process.env.SHANHAI_PORTAL_PORT;
    try {
      process.env.SHANHAI_PORTAL_PORT = 'not-a-port';
      await expect(
        startPortalServer(h.rt, { dataDir: mkdtempSync(path.join(tmpdir(), 'shanhai-srv-')), repoRoot: process.cwd(), token: 't' }),
      ).rejects.toThrow(ConfigError);

      process.env.SHANHAI_PORTAL_PORT = '28817';
      const handle = await startPortalServer(h.rt, { dataDir: mkdtempSync(path.join(tmpdir(), 'shanhai-srv-')), repoRoot: process.cwd(), token: 't' });
      servers.push(handle);
      expect(handle.port).toBe(28817);
    } finally {
      if (prev === undefined) delete process.env.SHANHAI_PORTAL_PORT;
      else process.env.SHANHAI_PORTAL_PORT = prev;
    }
  });
});

// ---------- 前端纯函数视图模块（假设 5 修订：入覆盖分母） ----------

describe('WP6B2-11 view 纯函数（批次 6-2 新视图）', () => {
  it('parseHash：新路由（capabilities/evolution/agents/evidence）', () => {
    expect(parseHash('#/capabilities')).toEqual({ view: 'capabilities' });
    expect(parseHash('#/evolution')).toEqual({ view: 'evolution' });
    expect(parseHash('#/evolution/c-1')).toEqual({ view: 'evolution-detail', id: 'c-1' });
    expect(parseHash('#/agents/ag-1')).toEqual({ view: 'agent-detail', id: 'ag-1' });
    expect(parseHash('#/evidence')).toEqual({ view: 'evidence' });
    expect(parseHash('#/tasks')).toEqual({ view: 'tasks' }); // 存量路由不回退
  });

  it('eventSummary：事件行展示变换（label 映射 + 未知事件回退原文）', () => {
    const s = eventSummary({ eventId: 'e-1', eventType: 'task_started', timestamp: '2026-09-27T00:00:00.000000000Z', callKind: null, callNo: 0 });
    expect(s.label).toBe('开始执行');
    const s2 = eventSummary({ eventId: 'e-2', eventType: 'tool_call_requested', timestamp: '2026-09-27T00:00:00.000000001Z', callKind: 'tool', callNo: 3 });
    expect(s2.label).toBe('工具调用请求');
    expect(s2.callLabel).toBe('调用 3 · tool');
    const s3 = eventSummary({ eventId: 'e-3', eventType: 'task_succeeded', timestamp: '2026-09-27T00:00:00.000000002Z', callKind: null, callNo: 0 });
    expect(s3.label).toBe('执行成功');
    expect(eventSummary({ eventId: 'e-4', eventType: 'ghost_event', timestamp: 't', callKind: null, callNo: 0 }).label).toBe('ghost_event');
  });

  it('parseRefInput / evidenceSummary：ref 前端预检 + 证据摘要（长 payload 折叠标记）', () => {
    expect(parseRefInput('task:t-1')).toEqual({ ok: true, ref: 'task:t-1' });
    expect(parseRefInput('task:t-1').ok).toBe(true);
    expect(parseRefInput('no-colon').ok).toBe(false);
    expect(parseRefInput('ghost:x').ok).toBe(false);
    expect(parseRefInput('task:').ok).toBe(false);

    const short = evidenceSummary({ ref: 'task:t-1', kind: 'task', status: 'succeeded', occurredAt: '2026-09-27T00:00:00.000000000Z', digest: '0123456789abcdef', payload: 'x'.repeat(100) });
    expect(short.digestShort).toBe('0123456789ab');
    expect(short.payloadCollapsed).toBe(false);
    const long = evidenceSummary({ ref: 'task:t-2', kind: 'task', status: 'succeeded', occurredAt: 't', digest: '0123456789abcdef', payload: 'x'.repeat(3000) });
    expect(long.payloadCollapsed).toBe(true); // >2KB 摘要展示（§12-3 递归渲染器折叠纪律）
  });

  it('capabilitySummary + trendSummary：断言/趋势展示变换', () => {
    const c = capabilitySummary({
      capabilityId: 'c-1', agentId: 'a', kind: 'capability', origin: 'manual', statement: 's',
      statementDigest: 'd', status: 'candidate', evidenceRefs: '[]', createdAt: 't', lastUpdatedAt: 't', decidedAt: null, decidedBy: null,
    });
    expect(c.statusLabel).toBe('待确认');
    expect(c.evidenceCount).toBe(0);
    expect(c.evidencePending).toBe(true);
    const c2 = capabilitySummary({
      capabilityId: 'c-2', agentId: 'a', kind: 'limitation', origin: 'derived', statement: 's',
      statementDigest: 'd', status: 'active', evidenceRefs: '[{"kind":"failure","id":"f","occurredAt":"t"}]', createdAt: 't', lastUpdatedAt: 't', decidedAt: 't2', decidedBy: 'me',
    });
    expect(c2.statusLabel).toBe('已生效');
    expect(c2.evidenceCount).toBe(1);

    const t = trendSummary({ agentId: 'a', bucket: 'day', since: null, until: 'u', coverage: { memoryFrom: null, note: 'n' }, buckets: [] });
    expect(t.hasData).toBe(false);
    const t2 = trendSummary({
      agentId: 'a', bucket: 'day', since: null, until: 'u', coverage: { memoryFrom: null, note: 'n' },
      buckets: [
        { key: '2026-09-26', tasks: { total: 2, succeeded: 1, excludedCancelled: 0, contractFailures: 1, contractPassRate: 0.5 }, failureBySubClass: {}, memoryEvents: 0, registry: { candidate: 0, active: 0, retired: 0 } },
        { key: '2026-09-27', tasks: { total: 0, succeeded: 0, excludedCancelled: 0, contractFailures: 0, contractPassRate: null }, failureBySubClass: {}, memoryEvents: 0, registry: { candidate: 0, active: 0, retired: 0 } },
      ],
    });
    expect(t2.hasData).toBe(true);
    expect(t2.latestKey).toBe('2026-09-27');
    expect(t2.latestRateLabel).toBe('—（无分母不假装）'); // null 通过率不假装
  });

  it('insightSummary + reportSummary：四层报告/健康面板展示变换', () => {
    const ins = insightSummary({
      agentId: 'a', versionId: 'v', generatedAt: 't',
      declared: {}, assertions: {
        active: { counts: { capability: 1, limitation: 2 }, entries: [] },
        openCandidates: { total: 1, evidencePending: 1 }, emptyHint: null,
      },
      behavior: { since: 's', bucket: 'day', buckets: [], status: 'insufficient-sample', insufficientNote: 'n' },
      limitations: { entries: [], evidenceSummary: {} },
    });
    expect(ins.behaviorLabel).toBe('样本不足');
    expect(ins.activeLabel).toBe('capability 1 / limitation 2');
    const ins2 = insightSummary({
      agentId: 'a', versionId: 'v', generatedAt: 't',
      declared: {}, assertions: { active: { counts: { capability: 0, limitation: 0 }, entries: [] }, openCandidates: { total: 0, evidencePending: 0 }, emptyHint: 'hint' },
      behavior: { since: 's', bucket: 'day', buckets: [], status: 'ok', insufficientNote: null },
      limitations: { entries: [], evidenceSummary: {} },
    });
    expect(ins2.behaviorLabel).toBe('正常');
    expect(ins2.emptyRegistryHint).toBe('hint');

    const rep = reportSummary({
      agentId: 'a', since: null, groups: [], promoteCriteria: { status: 'insufficient-sample', canaryPassRate: null, stablePassRate: null, canarySample: 0, threshold: 't' },
      sideColumns: { approvalTimeoutCount: 0, toolUpgradeAffectedSpecs: [], stale: { queued: 0, paused: 0 }, canaryRounds: { boundaryEvents: [], warning: null } },
      healthPanel: { traceEventCount: 10, traceFileCount: 1, t1QueryP95Ms: null, triggered: false, note: 'n' },
    });
    expect(rep.promoteLabel).toBe('样本不足');
    expect(rep.healthTriggered).toBe(false);
    const rep2 = reportSummary({
      agentId: 'a', since: null, groups: [], promoteCriteria: { status: 'promote-recommended', canaryPassRate: 0.9, stablePassRate: 0.85, canarySample: 30, threshold: 't' },
      sideColumns: { approvalTimeoutCount: 0, toolUpgradeAffectedSpecs: [], stale: { queued: 0, paused: 0 }, canaryRounds: { boundaryEvents: [], warning: null } },
      healthPanel: { traceEventCount: 20000, traceFileCount: 2, t1QueryP95Ms: 600, triggered: true, note: 'n' },
    });
    expect(rep2.promoteLabel).toBe('建议晋级');
    expect(rep2.healthTriggered).toBe(true);
  });

  it('evolutionSummary：演进候选展示变换', () => {
    const open = evolutionSummary({ candidateId: 'c-1', agentId: 'a', trigger: 'repeated_failure', evidenceRefs: '[{},{},{}]', status: 'open', createdAt: 't', proposedChange: null, decidedAt: null, decidedBy: null, derivedVersionIds: '[]', dismissedAt: null });
    expect(open.statusLabel).toBe('待裁决');
    expect(open.evidenceCount).toBe(3);
    expect(open.decided).toBe(false);
    const done = evolutionSummary({ candidateId: 'c-2', agentId: 'a', trigger: 'repeated_failure', evidenceRefs: '[]', status: 'confirmed', createdAt: 't', proposedChange: 'p', decidedAt: 't2', decidedBy: 'me', derivedVersionIds: '[]', dismissedAt: null });
    expect(done.statusLabel).toBe('已确认');
    expect(done.decided).toBe(true);
  });
});
