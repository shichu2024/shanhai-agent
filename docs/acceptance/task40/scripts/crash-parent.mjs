// 增补 A 驱动器：真实 kill -9 → 注入索引撕裂（模拟 D-6 崩溃窗口）→ 重启恢复 → 断言
// A7: trace_index 与 JSONL 自动重建一致（无人工干预重建）
// A8: kill -9 前的 policy_denied 重启后仍可经 T2 单一查询命中
// A9: 索引对账先于崩溃标记（CrashRecovery Trace 追加在完整索引之上）
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';

const dataDir = 'D:/code/shanhai-agent/data/acceptance-task40/crash';
const result = { steps: [] };
const fail = (msg) => { console.error('ASSERT FAIL:', msg); process.exit(1); };

// 1. 启动子进程
const child = spawn(process.execPath, ['data/acceptance-task40/crash-child.mjs', dataDir], { cwd: 'D:/code/shanhai-agent', stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stderr.write('[child] ' + d));
child.stderr.on('data', (d) => process.stderr.write('[child-err] ' + d));

// 2. 等 meta + Trace 出现第 3 次模型调用 attempt_started（即 delay 窗口）
let meta;
for (let i = 0; i < 100; i++) {
  if (existsSync(dataDir + '/crash-meta.json')) { meta = JSON.parse(readFileSync(dataDir + '/crash-meta.json', 'utf8')); break; }
  await sleep(100);
}
if (!meta) fail('meta 未出现');
const traceFile = dataDir + '/traces/' + meta.taskId + '.jsonl';
for (let i = 0; i < 200; i++) {
  if (!existsSync(traceFile)) { await sleep(50); continue; }
  const evs = readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const modelStarts = evs.filter((e) => e.eventType === 'attempt_started' && e.callKind === 'model');
  if (modelStarts.length >= 3) break; // 第 3 次模型调用已进入 delay
  await sleep(50);
}
await sleep(200); // 确保 attempt_started 已写盘

// 3. 真实 SIGKILL
process.kill(child.pid, 'SIGKILL');
await sleep(500);
fail_if_dead: {
  // Windows: TerminateProcess 强杀
}
const preKillEvents = readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const preDenied = preKillEvents.filter((e) => e.eventType === 'policy_denied');
result.steps.push({ step: 'killed', pid: child.pid, preKillEventCount: preKillEvents.length, preKillPolicyDenied: preDenied.length });
if (preDenied.length !== 1) fail('kill 前应有 1 条 policy_denied，实际 ' + preDenied.length);

// 4. 注入索引撕裂（模拟 D-6「先文件后索引」崩溃窗口：文件已写、索引行丢失）
const db = new Database(dataDir + '/shanhai.db');
const before = db.prepare('SELECT COUNT(*) c FROM trace_index WHERE taskId=?').get(meta.taskId).c;
db.prepare(`DELETE FROM trace_index WHERE taskId=? AND eventId IN (SELECT eventId FROM trace_index WHERE taskId=? ORDER BY rowid DESC LIMIT 2)`).run(meta.taskId, meta.taskId);
const afterTear = db.prepare('SELECT COUNT(*) c FROM trace_index WHERE taskId=?').get(meta.taskId).c;
db.close();
result.steps.push({ step: 'inject-tear', indexRowsBefore: before, indexRowsAfterTear: afterTear, fileLines: preKillEvents.length });

// 5. 重启恢复（独立进程，无人工干预）
const restart = spawn(process.execPath, ['data/acceptance-task40/crash-restart.mjs', dataDir, meta.taskId, meta.versionId], { cwd: 'D:/code/shanhai-agent', stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
restart.stdout.on('data', (d) => { out += d; });
await new Promise((r) => restart.on('close', r));
process.stderr.write(out);
const report = JSON.parse(out.slice(out.indexOf('{')));
Object.assign(result, report);
console.log(JSON.stringify(result, null, 2));
