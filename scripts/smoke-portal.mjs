#!/usr/bin/env node
// WP-6B 批次四（6-4/4）冒烟脚本（入库留档，形态参数化——P2-1 收口：形态标签/dataDir 目录名/命令行入档）。
//
// 用法（仓库根目录）：
//   node scripts/smoke-portal.mjs --form dist            # dist 形态（需先 npm run build）
//   node scripts/smoke-portal.mjs --form tsx             # 开发态（node 直启 npx-cli.js 调 tsx，Windows 不 spawn .cmd）
// 可选：--port 17891（门户固定高端口；--port 0 不被 parsePortalArgs 接受）；--out <file>（证据落盘）
//
// 全链路（与批次三实测同链路 + 批次四 P3 收口验证）：
//   mock anthropic（独立子进程）→ MCP echo 登记（external L3）→ agent 注册发布 → task run → L3 挂起（exit 3）
//   → 门户启动（真实 CLI 常驻进程）→ API：看到 Paused → approve → POST resume（真实 detached 子进程续跑）
//   → 终态 succeeded → resume-log → 事件链 → CLI approval approve（前台 spawn resume，P3-① execArgv 透传）
//   → CLI evolution show 不存在候选（P3 收口：not_found + exit 1）
//
// 证据自证头部：形态标签 / 入口命令行 / node 版本 / repoRoot / dataDir / 各步时间戳与判据。
//
// 7-4（TASK-104）新增：
//   - Agent 四读面断言（/api/agents/:id 的 card/insight/trend/report）+ 门户 UI 产物含 Agent 页接线；
//   - P3-2 修复：tsx 形态下 npx→tsx→cli 为进程树，portal.kill() 只终止直接子进程会遗留孙进程——
//     改为 Windows taskkill /T /F 整树终止 + POSIX SIGTERM，并以 exit 事件确认退出（check 留档）。

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------- 参数 ----------

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const FORM = flagValue('--form');
if (FORM !== 'dist' && FORM !== 'tsx') {
  console.error('用法：node scripts/smoke-portal.mjs --form dist|tsx [--port 17891] [--out <file>]');
  process.exit(2);
}
const PORT = Number(flagValue('--port') ?? '17891');
const OUT = flagValue('--out');
const REPO_ROOT = process.cwd();
if (!existsSync(path.join(REPO_ROOT, 'src/cli.ts'))) {
  console.error('必须在仓库根目录运行（当前目录无 src/cli.ts）');
  process.exit(2);
}

// 形态 → CLI 入口命令行（形态标签与命令行一并入档）
function entryOf(form) {
  if (form === 'dist') {
    return { label: 'dist', cmd: process.execPath, baseArgs: ['dist/cli.js'] };
  }
  const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return { label: 'tsx', cmd: process.execPath, baseArgs: [npxCli, 'tsx', 'src/cli.ts'] };
}
const ENTRY = entryOf(FORM);
const CLI_COMMAND_LINE = [ENTRY.cmd, ...ENTRY.baseArgs].join(' ');

let portalOut = ''; // portal 进程输出（跨 try/catch 可见，崩溃定位用）
let portal = null; // 跨 try/catch 可见（FATAL 时报告 exitCode/signal）

const DATA_DIR = path.join(tmpdir(), `shanhai-smoke-${FORM}-${Date.now()}`);
const TOKEN = 'smoke-token-fixed-0000000000000000';
const ENV = {
  ...process.env,
  SHANHAI_CONFIG: path.join(DATA_DIR, 'config.json'),
  SHANHAI_DATA_DIR: DATA_DIR,
  SHANHAI_SMOKE_TOKEN: 'smoke-not-a-secret',
  SHANHAI_PORTAL_PORT: '', // 不走 env 端口；--port 旗标显式
};

const lines = [];
const failures = [];
function log(line = '') {
  const stamped = line;
  lines.push(stamped);
  console.log(stamped);
}
function check(label, ok, detail = '') {
  const at = new Date().toISOString();
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}  @${at}`);
  if (!ok) failures.push(label);
}

// ---------- 工具 ----------

function runCli(cliArgs, { timeoutMs = 180000 } = {}) {
  const res = spawnSync(ENTRY.cmd, [...ENTRY.baseArgs, ...cliArgs], {
    cwd: REPO_ROOT, env: ENV, encoding: 'utf8', timeout: timeoutMs,
  });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

// node:http 一次性连接（agent:false）：不用全局 fetch 的连接池——长 spawnSync 阻塞后
// undici 池中 keep-alive socket 会失效（tsx 形态实测 ECONNRESET），每次新建连接规避。
function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path: apiPath, agent: false,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? '' : JSON.stringify(body));
  });
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- 进程回收（P3-2：tsx 形态 npx→tsx→cli 进程树整树终止，防遗留孙进程） ----------

function killTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Windows：SIGTERM（node 默认 TerminateProcess）只杀直接子进程——taskkill /T 按进程树终止
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

/** 等待进程 exit 事件（超时 → false，check 留档不掩盖） */
function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function waitFor(desc, fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${desc}（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------- 自证头部 ----------

log(`=== 山海门户冒烟（WP-6B 批次四入库脚本）===`);
log(`形态标签：${ENTRY.label}`);
log(`入口命令行：${CLI_COMMAND_LINE}`);
log(`node：${process.version}  平台：${process.platform}`);
log(`repoRoot：${REPO_ROOT}`);
log(`dataDir：${DATA_DIR}`);
log(`门户端口：${PORT}`);

try {
  // ---------- 0. mock anthropic（独立子进程） ----------

  const mock = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/fixtures/smoke-anthropic.mjs'), '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let mockPort = 0;
  mock.stdout.on('data', (c) => {
    const m = /MOCK_ANTHROPIC_READY port=(\d+)/.exec(String(c));
    if (m) mockPort = Number(m[1]);
  });
  await waitFor('mock anthropic 就绪', () => mockPort > 0, 15000, 100);
  log(`mock anthropic：http://127.0.0.1:${mockPort}/`);

  // ---------- 1. 配置与素材 ----------

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: { anthropic: { baseUrl: `http://127.0.0.1:${mockPort}`, authTokenEnv: 'SHANHAI_SMOKE_TOKEN', models: ['mock-model'] } },
    mcpServers: { echo: { transport: 'stdio', command: process.execPath, args: [path.join(REPO_ROOT, 'tests/fixtures/mcpEchoServer.mjs')] } },
    portal: { token: TOKEN },
  }, null, 2));
  const SPEC = {
    specVersion: '1',
    identity: { agentId: 'smoke-a', name: '冒烟代理', description: '门户全链路冒烟', author: 'wp6b-batch4' },
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
  writeFileSync(path.join(DATA_DIR, 'input.json'), JSON.stringify({ topic: '门户冒烟' }));

  // ---------- 2. 登记（MCP echo → external L3）----------

  const reg = runCli(['tool', 'mcp', 'connect', 'echo', '--yes', '--by', 'smoke']);
  check('tool mcp connect echo --yes（echo-echo 登记 external L3）', reg.code === 0 && reg.out.includes('echo-echo'), `exit=${reg.code}`);

  const agentReg = runCli(['agent', 'register', path.join(DATA_DIR, 'spec.json'), '--by', 'smoke']);
  const versionId = parseJsonSafe(agentReg.out)?.versionId;
  check('agent register', agentReg.code === 0 && typeof versionId === 'string', `exit=${agentReg.code}`);

  const release = runCli(['agent', 'release', 'smoke-a', versionId, '--by', 'smoke']);
  check('agent release', release.code === 0, `exit=${release.code}`);

  // ---------- 3. 任务 A：task run → L3 挂起（exit 3）----------

  const createA = runCli(['task', 'create', 'smoke-a', path.join(DATA_DIR, 'input.json'), '--by', 'smoke']);
  const taskA = parseJsonSafe(createA.out)?.taskId;
  check('task create（A：门户 approve+detached resume 链）', createA.code === 0 && typeof taskA === 'string', `exit=${createA.code}`);

  const runA = runCli(['task', 'run', taskA]);
  const reqA = /requestId=([^；;\s]+)/.exec(runA.err)?.[1];
  check('task run → paused（exit 3）+ requestId', runA.code === 3 && runA.out.includes('"status": "paused"') && !!reqA, `exit=${runA.code}`);

  // ---------- 4. 门户启动（真实 CLI 常驻进程；TASK-109：--dataDir 旗标形态实证——与 env 同值，旗标生效即正常起服）----------

  portal = spawn(ENTRY.cmd, [...ENTRY.baseArgs, 'portal', '--port', String(PORT), '--dataDir', DATA_DIR], {
    cwd: REPO_ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let portalReady = false;
  portal.stdout.on('data', (c) => { portalOut += String(c); if (portalOut.includes('已启动')) portalReady = true; });
  portal.stderr.on('data', (c) => { portalOut += String(c); });
  try {
    await waitFor(`门户启动（${ENTRY.label} 形态，port=${PORT}）`, () => portalReady, 60000, 250);
    check(`portal 启动（${ENTRY.label}）`, true, `port=${PORT}`);

    // ---------- 5. API 全链路（任务 A）----------

    const listRes = await api('GET', '/api/tasks?status=paused');
    check('GET /api/tasks?status=paused 看到 A', listRes.status === 200 && listRes.body.includes(taskA));

    const approveRes = await api('POST', `/api/approvals/${reqA}/approve`, {});
    const approveBody = parseJsonSafe(approveRes.body);
    check('POST approve → 200 且任务保持 paused', approveRes.status === 200 && approveBody?.taskStatus === 'paused', `status=${approveRes.status}`);

    const resumeRes = await api('POST', `/api/tasks/${taskA}/resume`, {});
    const resumeBody = parseJsonSafe(resumeRes.body);
    check('POST resume → 立即返回 {spawned:true}', resumeRes.status === 200 && resumeBody?.spawned === true, `logFile=${path.basename(String(resumeBody?.logFile ?? ''))}`);

    const finalA = await waitFor('任务 A detached 子进程续跑至终态', async () => {
      const r = await api('GET', `/api/tasks/${taskA}`);
      const row = parseJsonSafe(r.body);
      return row?.status === 'succeeded' ? row : null;
    }, 120000);
    check('detached 子进程续跑至终态 succeeded', finalA.status === 'succeeded');

    const logRes = await api('GET', `/api/tasks/${taskA}/resume-log`);
    check('GET resume-log 有内容（CLI JSON 输出）', logRes.status === 200 && parseJsonSafe(logRes.body)?.content?.includes('"status": "succeeded"'));

    const eventsRes = await api('GET', `/api/tasks/${taskA}/events`);
    const events = parseJsonSafe(eventsRes.body) ?? [];
    const types = events.map((e) => e.eventType);
    const resumed = events.find((e) => e.eventType === 'task_resumed');
    check('事件链含 approval_decided + task_resumed(manual-resume)',
      types.includes('approval_decided') && types.includes('task_resumed') && resumed?.resumedBy === 'manual-resume');

    // ---------- 5.5 Agent 四读面 + 门户 UI 产物（7-4 新页数据面与接线） ----------

    const agentCard = await api('GET', '/api/agents/smoke-a/card');
    check('GET /api/agents/:id/card → 200（FR-AG-1 能力卡数据面）',
      agentCard.status === 200 && parseJsonSafe(agentCard.body)?.agentId === 'smoke-a', `status=${agentCard.status}`);

    const insightRes = await api('GET', '/api/agents/smoke-a/insight');
    const insightBody = parseJsonSafe(insightRes.body);
    check('GET /api/agents/:id/insight → 200 含三区键 declared/assertions/behavior（FR-AG-2）',
      insightRes.status === 200 && !!insightBody?.declared && !!insightBody?.assertions && !!insightBody?.behavior, `status=${insightRes.status}`);

    const trendDay = await api('GET', '/api/agents/smoke-a/trend?bucket=day');
    const trendWeek = await api('GET', '/api/agents/smoke-a/trend?bucket=week');
    check('GET /api/agents/:id/trend?bucket=day|week → 200 桶数组（FR-AG-3）',
      trendDay.status === 200 && trendWeek.status === 200
        && Array.isArray(parseJsonSafe(trendDay.body)?.buckets) && Array.isArray(parseJsonSafe(trendWeek.body)?.buckets));

    const reportRes = await api('GET', '/api/agents/smoke-a/report');
    const reportBody = parseJsonSafe(reportRes.body);
    check('GET /api/agents/:id/report → 200 含 groups/promoteCriteria/healthPanel（FR-AG-4 reportSummary 源）',
      reportRes.status === 200 && Array.isArray(reportBody?.groups) && !!reportBody?.promoteCriteria && !!reportBody?.healthPanel, `status=${reportRes.status}`);

    const appJs = await api('GET', '/app.js');
    check('门户 UI 产物含 Agent 目录/详情页接线（7-4：agent-detail 路由 + 报告摘要渲染）',
      appJs.status === 200 && appJs.body.includes('agent-detail') && appJs.body.includes('报告摘要'), `bytes=${appJs.body.length}`);

    // ---------- 6. 任务 B：CLI approval approve 前台 spawn resume（P3-① execArgv 透传验证）----------

    const createB = runCli(['task', 'create', 'smoke-a', path.join(DATA_DIR, 'input.json'), '--by', 'smoke']);
    const taskB = parseJsonSafe(createB.out)?.taskId;
    const runB = runCli(['task', 'run', taskB]);
    const reqB = /requestId=([^；;\s]+)/.exec(runB.err)?.[1];
    check('task create+run（B：CLI approve 前台 spawn 链）', runB.code === 3 && !!reqB && !!taskB, `exit=${runB.code}`);

    const approveCli = runCli(['approval', 'approve', reqB, '--by', 'smoke'], { timeoutMs: 300000 });
    check(`CLI approval approve（前台 spawn resume，${ENTRY.label} 形态）→ exit 0`, approveCli.code === 0, `exit=${approveCli.code}`);

    const finalB = await waitFor('任务 B 续跑至终态', async () => {
      const r = await api('GET', `/api/tasks/${taskB}`);
      const row = parseJsonSafe(r.body);
      return row?.status === 'succeeded' ? row : null;
    }, 120000);
    check('CLI approve spawn 续跑至终态 succeeded', finalB.status === 'succeeded');

    // ---------- 7. P3 收口验证：evolution show 不存在候选 ----------

    const evo = runCli(['evolution', 'show', 'no-such-candidate']);
    check('CLI evolution show 不存在候选 → not_found + exit 1（批次 6-4 P3 收口）',
      evo.code === 1 && evo.err.includes('not_found') && evo.err.includes('演进候选不存在'), `exit=${evo.code}`);
  } finally {
    // P3-2：整树终止 + exit 事件确认（tsx 形态 npx→tsx→cli 遗留孙进程修复；check 留档）
    killTree(portal);
    const portalExited = await waitForExit(portal);
    check('portal 进程树退出无遗留（P3-2）', portalExited, `exitCode=${portal?.exitCode} signal=${portal?.signalCode}`);
    killTree(mock);
    await waitForExit(mock, 3000);
  }

  log('');
  log(`=== ${ENTRY.label} 形态冒烟：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`} ===`);
  log(`dataDir 保留（复查用）：${DATA_DIR}`);
  if (OUT) writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  process.exit(failures.length === 0 ? 0 : 1);
} catch (err) {
  log(`  FATAL  ${err?.message ?? err}${err?.cause ? `（cause: ${err.cause?.message ?? err.cause}）` : ''}`);
  log(`  portal 进程状态：exitCode=${portal.exitCode} signal=${portal.signalCode} killed=${portal.killed}`);
  if (portalOut.trim()) log(`  --- portal 进程输出（崩溃定位）---\n${portalOut.trim().split('\n').slice(-15).join('\n')}`);
  if (OUT) writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  process.exit(1);
}
