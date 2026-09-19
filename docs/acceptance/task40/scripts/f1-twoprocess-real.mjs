// F-1 闭环重验：CLI 分两进程 task create → task run → Succeeded（README 快速开始原样，真实模型 glm-4.6）
// 过程 A（独立 node 进程）：agent register + release + task create → 进程退出
// 过程 B（独立 node 进程）：task run → 断言 Succeeded；Trace 断言 crash_recovery_marked 零出现
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const dataDir = path.join(root, 'tmp-f1-recheck', 'data');
rmSync(path.join(root, 'tmp-f1-recheck'), { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const env = { ...process.env, SHANHAI_DATA_DIR: dataDir };
const cli = path.join(root, 'dist', 'cli.js');
const scripts = path.join(root, 'docs', 'acceptance', 'task40', 'scripts');
const specFile = path.join(scripts, 'spec-c1.json');
const inputFile = path.join(scripts, 'input-c1.json');

function run(step, args) {
  const r = spawnSync('node', [cli, ...args], { env, encoding: 'utf8', cwd: root });
  const ok = r.status === 0;
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* non-JSON */ }
  console.log(JSON.stringify({ step, exit: r.status, stdout: parsed ?? (r.stdout || '').slice(0, 400), stderr: (r.stderr || '').slice(0, 400) }));
  if (!ok) { console.log(`FAIL: ${step} 退出码 ${r.status}`); process.exit(1); }
  return parsed;
}

// ===== 过程 A：注册 + 发布 + 创建（进程退出，Queued 落库）=====
const reg = run('A.agent.register', ['agent', 'register', specFile, '--by', 'f1-recheck']);
run('A.agent.release', ['agent', 'release', 'docs-analyst', reg.versionId, '--by', 'f1-recheck']);
const created = run('A.task.create', ['task', 'create', 'docs-analyst', inputFile, '--by', 'f1-recheck']);
const taskId = created.taskId;

// ===== 过程 B：新进程执行（启动扫描 + runTask）=====
const ran = run('B.task.run', ['task', 'run', taskId]);
if (String(ran.status).toLowerCase() !== 'succeeded') {
  console.log(`FAIL: 终态 ${ran.status}（terminalFailureClass=${ran.terminalFailureClass}）`);
  process.exit(1);
}
console.log(`PASS: 两进程 create→run→Succeeded（modelCallCount=${ran.modelCallCount}, tokensUsed=${ran.tokensUsed}）`);

// ===== Trace 断言：crash_recovery_marked 零出现 =====
const traceFile = path.join(dataDir, 'traces', `${taskId}.jsonl`);
const lines = readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const crashMarked = lines.filter((e) => e.eventType === 'crash_recovery_marked');
const succeeded = lines.find((e) => e.eventType === 'task_succeeded');
const idx = lines.findIndex((e) => e.eventType === 'task_index_rebuilt' || e.eventType === 'reconciled');
if (crashMarked.length !== 0) {
  console.log(`FAIL: 出现 crash_recovery_marked × ${crashMarked.length}`);
  process.exit(1);
}
if (!succeeded || !succeeded.output || !Array.isArray(succeeded.output.subdirs) || !succeeded.output.filesCovered) {
  console.log('FAIL: task_succeeded 缺失或输出不含结构化字段');
  process.exit(1);
}
console.log(`PASS: crash_recovery_marked 零出现；Trace ${lines.length} 事件；输出结构化（subdirs=${JSON.stringify(succeeded.output.subdirs)}, filesCovered=${succeeded.output.filesCovered}, verdict=${succeeded.output.verdict}）`);
console.log(JSON.stringify({ summary: succeeded.output.summary, keyFinding: succeeded.output.keyFinding }));
console.log('ALL PASS');
