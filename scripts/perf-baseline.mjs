#!/usr/bin/env node
// TASK-235（每日优化第二十九批）性能基线脚本（新维度首探）。
//
// 用法（仓库根目录，须先 npm ci && npm run build 出 dist/cli.js）：
//   node scripts/perf-baseline.mjs [--out <file>] [--port 17970] [--samples 300] [--cli-samples 16]
//
// 度量面（本机开发机口径，非 CI 基准——建档批不设门，见 docs/performance-baseline.md）：
//   ① 门户核心读端点延迟：独立临时 dataDir + 种子（复用 smoke/walkthrough 种子机制：
//      CLI 基础种子 → SQLite 直写扩展种子），起 dist 门户，对核心读端点各打点 N（缺省 300）
//      次取 P50/P95（含 Token 鉴权与 Host 门，真实 HTTP 往返）；
//   ② CLI 冷启动：`node dist/cli.js`（无参 usage 路径）计时 N（缺省 16）次取 P50/P95。
//
// 输出：结构化 JSON（--out 落盘）+ 人读表格（stdout）。
// 清理：跑完删除临时 dataDir、taskkill 整树终止门户子进程、exit 事件确认，零残留。
//
// 自证头部：repo SHA / node 版本 / 机器信息（os.cpus）— 基线归属档案。

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- 参数 ----------

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const OUT = flagValue('--out');
const PORT = Number(flagValue('--port') ?? '17970');
// 缺省 300 次/端点（交错轮询采样）：60 次连续块采样实测双跑 P50 波动可达 ~22%、P95 ~26%；
// 300 次交错将 P50 双跑差异压到 <15% 通过线内（实测最差 12.9%）。P95 尾部分位在共享开发机
// 上为调度噪声主导（实测双跑最差 ~26%），建档口径=P50 为稳定性锚、P95 如实记录不设线
//（见 docs/performance-baseline.md 波动实测节）。
const SAMPLES = Number(flagValue('--samples') ?? '300');
const CLI_SAMPLES = Number(flagValue('--cli-samples') ?? '16');

const REPO_ROOT = process.cwd();
if (!existsSync(path.join(REPO_ROOT, 'src/cli.ts'))) {
  console.error('必须在仓库根目录运行（当前目录无 src/cli.ts）');
  process.exit(2);
}
if (!existsSync(path.join(REPO_ROOT, 'dist/cli.js'))) {
  console.error('缺 dist/cli.js——先 npm ci && npm run build');
  process.exit(2);
}
const REPO_SHA = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

// ---------- 工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeoutMs = 60000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${desc}（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}
function percentile(sorted, p) {
  // 线性插值（与常见库一致）：序号 = p*(n-1)
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p95: Math.round(percentile(sorted, 95) * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}
// node:http 一次性连接（agent:false）：与冒烟脚本同口径，规避连接池复用干扰（每次真实往返）。
function timedGet(apiPath, token) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, method: 'GET', path: apiPath, agent: false,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = performance.now() - t0;
          resolve({ status: res.statusCode, ms, bytes: Buffer.concat(chunks).length });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------- 进程回收（与冒烟脚本同：Windows taskkill 整树，防遗留孙进程） ----------

function killTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}
function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

// ---------- 主流程 ----------

const DATA_DIR = path.join(os.tmpdir(), `shanhai-perf-${Date.now()}`);
const TOKEN = 'perf-baseline-token-fixed-000000000';
const ENV = {
  ...process.env,
  SHANHAI_CONFIG: path.join(DATA_DIR, 'config.json'),
  SHANHAI_DATA_DIR: DATA_DIR,
  SHANHAI_SMOKE_TOKEN: 'smoke-not-a-secret',
  SHANHAI_PORTAL_PORT: '',
};
let portal = null;
let portalOut = '';

function runCli(cliArgs, { timeoutMs = 120000 } = {}) {
  const res = spawnSync(process.execPath, ['dist/cli.js', ...cliArgs], {
    cwd: REPO_ROOT, env: ENV, encoding: 'utf8', timeout: timeoutMs,
  });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}
function j(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const result = {
  meta: {
    repo: REPO_SHA,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemGB: Math.round(os.totalmem() / 1024 ** 3),
    samples: SAMPLES,
    cliSamples: CLI_SAMPLES,
    startedAt: new Date().toISOString(),
    note: '本机开发机口径，非 CI 基准；建档批不设性能门（基线数字仅记录）',
  },
  api: [],
  cli: null,
  cleanup: {},
};

try {
  // ========== 1. 种子（复用 smoke/walkthrough 种子机制） ==========

  mkdirSync(DATA_DIR, { recursive: true });
  // 不起 mock anthropic：性能面只走读端点，provider 不被调用；baseUrl 指向保留端口占位。
  writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: { anthropic: { baseUrl: 'http://127.0.0.1:9', authTokenEnv: 'SHANHAI_SMOKE_TOKEN', models: ['mock-model'] } },
    mcpServers: { echo: { transport: 'stdio', command: process.execPath, args: [path.join(REPO_ROOT, 'tests/fixtures/mcpEchoServer.mjs')] } },
    portal: { token: TOKEN },
  }, null, 2));
  const SPEC = {
    specVersion: '1',
    identity: { agentId: 'perf-a', name: '性能基线代理', description: '性能基线打点种子', author: 'perf-baseline' },
    mission: { responsibilities: ['执行一次可回显的 L3 工具调用'], nonResponsibilities: ['修改任何文件内容'] },
    inputContract: { type: 'object', properties: { topic: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['topic'], additionalProperties: false },
    outputContract: {
      type: 'object',
      properties: { summary: { type: 'string', minLength: 1, maxLength: 500 }, filesCovered: { type: 'integer', minimum: 0, maximum: 1000 }, verdict: { type: 'string', enum: ['ok', 'needs-review'] } },
      required: ['summary', 'filesCovered', 'verdict'], additionalProperties: false,
    },
    modelPolicy: { allowedModels: ['mock-model'], maxModelCalls: 10, maxTokens: 100000 },
    toolPolicy: { tools: [{ toolId: 'echo-echo', riskLevel: 'L3' }] },
    approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 },
  };
  writeFileSync(path.join(DATA_DIR, 'spec.json'), JSON.stringify(SPEC, null, 2));
  writeFileSync(path.join(DATA_DIR, 'input.json'), JSON.stringify({ topic: '性能基线' }));

  const reg = runCli(['tool', 'mcp', 'connect', 'echo', '--yes', '--by', 'perf']);
  if (reg.code !== 0) throw new Error(`tool mcp connect 失败：exit=${reg.code} ${reg.err.slice(0, 200)}`);
  const agentReg = runCli(['agent', 'register', path.join(DATA_DIR, 'spec.json'), '--by', 'perf']);
  const versionId = j(agentReg.out)?.versionId;
  if (agentReg.code !== 0 || typeof versionId !== 'string') throw new Error(`agent register 失败：exit=${agentReg.code}`);
  const release = runCli(['agent', 'release', 'perf-a', versionId, '--by', 'perf']);
  if (release.code !== 0) throw new Error(`agent release 失败：exit=${release.code}`);
  const create = runCli(['task', 'create', 'perf-a', path.join(DATA_DIR, 'input.json'), '--by', 'perf']);
  const taskA = j(create.out)?.taskId;
  if (create.code !== 0 || typeof taskA !== 'string') throw new Error(`task create 失败：exit=${create.code}`);

  // ---- SQLite 扩展种子（与 wp264 走查种子同构：多状态任务 + trace + 审批 + 能力 + 演进） ----
  const { createRequire } = await import('node:module');
  const Database = createRequire(path.join(REPO_ROOT, 'package.json'))('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'shanhai.db'));
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const uuid = () => crypto.randomUUID();
  const HASH = db.prepare('SELECT specContentHash AS h FROM task_record LIMIT 1').get().h;
  const insTask = db.prepare(`INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, attemptCount, modelCallCount, tokensUsed, createdAt, startedAt, traceFile, delegationDepth)
    VALUES (?,?,?,?,?,?,?,1,300,?,?,'',0)`);
  const seededTasks = [];
  for (const [status, minAgo] of [['created', 90], ['queued', 80], ['running', 70], ['paused', 60], ['failed', 50], ['cancelled', 40], ['succeeded', 35], ['succeeded', 34], ['succeeded', 33], ['succeeded', 32], ['succeeded', 31], ['succeeded', 30]]) {
    const id = uuid();
    seededTasks.push(id);
    insTask.run(id, 'perf-a', versionId, HASH, '{"seed":"perf"}', status, status === 'failed' ? 2 : 1, iso(minAgo), iso(minAgo));
  }
  // 证据链载体（trend/evidence 端点数据面）：trace 2 事件 + failure 1 + memory 1
  const bigId = uuid();
  seededTasks.push(bigId);
  insTask.run(bigId, 'perf-a', versionId, HASH, JSON.stringify(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, 'value-'.repeat(10) + i]))), 'succeeded', 1, iso(29), iso(29));
  // 每个任务一个 Trace 文件（report 端点的 T1 采样按「最近 10 任务」逐个 queryT1——
  // 无 Trace 文件的任务会使该端点 500，种子须全量配齐；信封字段对齐 TraceEnvelope）。
  mkdirSync(path.join(DATA_DIR, 'traces'), { recursive: true });
  const envelopeOf = (id, taskId, minAgo) => ({
    eventId: id, timestamp: iso(minAgo), traceId: `trace-${taskId}`, taskId,
    agentId: 'perf-a', agentVersionId: versionId, specContentHash: HASH,
    eventType: 'task_started', callNo: 0, callKind: null, attemptNo: 1,
  });
  const evIds = [uuid(), uuid()];
  writeFileSync(path.join(DATA_DIR, 'traces', `${bigId}.jsonl`),
    evIds.map((id) => JSON.stringify(envelopeOf(id, bigId, 31)) + '\n').join(''));
  const insTrace = db.prepare('INSERT INTO trace_index (eventId, taskId, agentVersionId, eventType, timestamp) VALUES (?,?,?,?,?)');
  for (const id of evIds) insTrace.run(id, bigId, versionId, 'task_started', iso(31));
  for (const tid of [taskA, ...seededTasks]) {
    if (tid === bigId) continue;
    const evId = uuid();
    writeFileSync(path.join(DATA_DIR, 'traces', `${tid}.jsonl`), JSON.stringify(envelopeOf(evId, tid, 60)) + '\n');
    insTrace.run(evId, tid, versionId, 'task_started', iso(60));
  }
  db.prepare(`INSERT INTO failure_record (recordId, taskId, agentId, agentVersionId, attemptNo, failureClass, subClass, reasonCode, message, expectedVsActual, countedInContractRate, occurredAt)
    VALUES (?,?,?,?,1,'contract','tool.shell.timeout','TIMEOUT','shell 调用超时','期望 2s 内返回；实际 30s 未返回',1,?)`)
    .run(uuid(), bigId, 'perf-a', versionId, iso(32));
  db.prepare(`INSERT INTO memory_record (memoryId, agentId, agentVersionId, taskId, kind, content, contentDigest, evidenceCount, evidenceCountAtLastTransition, contradictionCount, status, createdAt, lastUpdatedAt)
    VALUES (?,?,?,?, 'episodic', '性能种子记忆：shell 调用须带超时护栏', ?, 1, 1, 0, 'active', ?, ?)`)
    .run(uuid(), 'perf-a', versionId, bigId, 'a'.repeat(64), iso(29), iso(29));
  const pendingReq = uuid();
  db.prepare(`INSERT INTO approval_request (requestId, taskId, agentVersionId, toolId, riskLevel, requestedAt, decision, decidedAt, timeoutAt, callRef)
    VALUES (?,?,?,?,'L2',?,'pending',NULL,?,?)`)
    .run(pendingReq, seededTasks[3], versionId, 'shell.exec', iso(40), iso(-30), `call-${uuid()}`);
  const insCap = db.prepare(`INSERT INTO capability_registry (capabilityId, agentId, kind, statement, origin, evidenceRefs, statementDigest, status, createdAt, lastUpdatedAt, decidedAt, decidedBy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insCap.run(uuid(), 'perf-a', 'capability', '能稳定完成 shell 调用并按契约回传', 'derived', JSON.stringify([{ ref: `task:${bigId}` }]), 'd'.repeat(64), 'active', iso(200), iso(100), iso(100), 'op-perf');
  insCap.run(uuid(), 'perf-a', 'capability', '待补证据的能力条目', 'derived', '[]', 'e'.repeat(64), 'candidate', iso(150), iso(150), null, null);
  insCap.run(uuid(), 'perf-a', 'limitation', 'L'.repeat(100), 'manual', '[]', 'f'.repeat(64), 'retired', iso(300), iso(300), iso(80), 'op-perf');
  const insEvo = db.prepare(`INSERT INTO evolution_candidate (candidateId, agentId, trigger, evidenceRefs, status, proposedChange, createdAt, decidedAt, decidedBy, derivedVersionIds, dismissedAt)
    VALUES (?,?,?,?,?,?,?,?,?,'[]',NULL)`);
  insEvo.run(uuid(), 'perf-a', 'repeated_failure', JSON.stringify([{ taskId: bigId, agentVersionId: versionId, subClass: 'tool.shell.timeout', occurredAt: iso(45) }]), 'open', '建议人工评审 shell 超时失败模式', iso(45), null, null);
  insEvo.run(uuid(), 'perf-a', 'capability_degradation', '[]', 'confirmed', '已确认的演进项', iso(300), iso(100), 'op-perf');
  db.close();
  console.log(`种子完成：13 任务 + 2 trace + 1 审批 + 3 能力 + 2 演进（DATA_DIR=${DATA_DIR}）`);

  // ========== 2. 门户启动（dist 形态，--no-open 不拉浏览器） ==========

  portal = spawn(process.execPath, ['dist/cli.js', 'portal', '--port', String(PORT), '--dataDir', DATA_DIR, '--no-open'], {
    cwd: REPO_ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let portalReady = false;
  portal.stdout.on('data', (c) => { portalOut += String(c); if (portalOut.includes('已启动')) portalReady = true; });
  portal.stderr.on('data', (c) => { portalOut += String(c); });
  await waitFor(`门户启动（port=${PORT}）`, () => portalReady, 60000, 250);
  await sleep(1000); // 启动后短暂静置：让启动期 IO（WAL 恢复/崩溃恢复扫描）完成再计时
  console.log(`门户已启动：port=${PORT}`);

  // ========== 3. 核心读端点打点（每端点 SAMPLES 次，P50/P95） ==========

  const detailId = seededTasks[3]; // paused 任务
  const endpoints = [
    { name: 'GET /api/tasks（列表全量）', path: '/api/tasks' },
    { name: 'GET /api/tasks?status=succeeded（过滤）', path: '/api/tasks?status=succeeded' },
    { name: 'GET /api/tasks/:id（详情）', path: `/api/tasks/${detailId}` },
    { name: 'GET /api/tasks/:id/events（时间线）', path: `/api/tasks/${bigId}/events` },
    { name: 'GET /api/tasks/:id/evidence（证据链）', path: `/api/tasks/${bigId}/evidence` },
    { name: 'GET /api/approvals?pending=true（待审批）', path: '/api/approvals?pending=true' },
    { name: 'GET /api/capabilities（能力矩阵）', path: '/api/capabilities' },
    { name: 'GET /api/evolution（演进列表）', path: '/api/evolution' },
    { name: 'GET /api/agents/:id/card（能力卡）', path: '/api/agents/perf-a/card' },
    { name: 'GET /api/agents/:id/trend?bucket=day（趋势）', path: '/api/agents/perf-a/trend?bucket=day' },
    { name: 'GET /api/agents/:id/insight（洞察）', path: '/api/agents/perf-a/insight' },
    { name: 'GET /api/agents/:id/report（报告摘要）', path: '/api/agents/perf-a/report' },
  ];
  // 预热各端点一次（排除首查建句柄/惰性派生冷效应，只计稳态延迟）
  for (const ep of endpoints) {
    const warm = await timedGet(ep.path, TOKEN);
    if (warm.status !== 200) throw new Error(`预热失败 ${ep.name}：status=${warm.status}`);
  }
  console.log(`预热完成（${endpoints.length} 端点 ×1）`);
  // 交错轮询采样：每轮命中全部端点各一次、共 SAMPLES 轮——端点耗时序列在时间轴上均匀铺开，
  // 机器环境漂移（后台负载/降频）对各端点同窗共担，而非集中污染某端点的连续采样块。
  const samplesBy = new Map(endpoints.map((ep) => [ep.name, []]));
  const bytesBy = new Map();
  for (let round = 0; round < SAMPLES; round++) {
    for (const ep of endpoints) {
      const r = await timedGet(ep.path, TOKEN);
      if (r.status !== 200) throw new Error(`${ep.name} 第 ${round + 1} 轮非 200：${r.status}`);
      samplesBy.get(ep.name).push(r.ms);
      bytesBy.set(ep.name, r.bytes);
    }
  }
  for (const ep of endpoints) {
    const s = stats(samplesBy.get(ep.name));
    const lastBytes = bytesBy.get(ep.name);
    result.api.push({ endpoint: ep.name, path: ep.path, ...s, bytes: lastBytes });
    console.log(`  ${ep.name.padEnd(44)} P50=${String(s.p50).padStart(7)}ms  P95=${String(s.p95).padStart(7)}ms  min=${String(s.min).padStart(7)}ms  max=${String(s.max).padStart(7)}ms  bytes=${lastBytes}`);
  }

  // ========== 4. CLI 冷启动（无参 usage 路径，进程起→exit 全程计时） ==========

  const cliSamples = [];
  for (let i = 0; i < CLI_SAMPLES; i++) {
    const t0 = performance.now();
    const res = spawnSync(process.execPath, ['dist/cli.js'], { cwd: REPO_ROOT, env: ENV, encoding: 'utf8', timeout: 60000 });
    const ms = performance.now() - t0;
    if (res.status !== 1) throw new Error(`CLI 无参 usage 应 exit 1，实际 ${res.status}`);
    cliSamples.push(ms);
  }
  result.cli = { command: 'node dist/cli.js（无参 usage）', ...stats(cliSamples) };
  console.log(`  ${'CLI 冷启动 node dist/cli.js（无参 usage）'.padEnd(44)} P50=${String(result.cli.p50).padStart(7)}ms  P95=${String(result.cli.p95).padStart(7)}ms  min=${String(result.cli.min).padStart(7)}ms  max=${String(result.cli.max).padStart(7)}ms`);

  result.meta.finishedAt = new Date().toISOString();
} finally {
  // ========== 5. 清理（零残留：进程树退出确认 + dataDir 删除确认） ==========
  killTree(portal);
  const portalExited = await waitForExit(portal);
  let dataDirRemoved = false;
  try { rmSync(DATA_DIR, { recursive: true, force: true }); dataDirRemoved = !existsSync(DATA_DIR); } catch { dataDirRemoved = false; }
  result.cleanup = { portalExited, dataDirRemoved, dataDir: DATA_DIR };
  console.log(`清理：portal 退出=${portalExited}，dataDir 删除=${dataDirRemoved}`);
}

// ---------- 输出 ----------

console.log('\n=== 性能基线（JSON 归档形态）===');
const json = JSON.stringify(result, null, 2);
if (OUT) writeFileSync(OUT, json + '\n', 'utf8');
console.log(json);
process.exit(result.cleanup.portalExited && result.cleanup.dataDirRemoved ? 0 : 1);
