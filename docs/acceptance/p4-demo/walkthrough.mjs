#!/usr/bin/env node
// P-4 演示包走查脚本（TASK-40 终审裁定：演示轨「不新跑，汇编既有真实证据」）。
// 只读：消费验收归档分支上的既有证据制品，零模型调用、零状态写入。
// 用法：node docs/acceptance/p4-demo/walkthrough.mjs   （仓库根目录，需已 fetch 归档分支）

import { execFileSync } from 'node:child_process';

const ARCHIVE_BRANCH = 'origin/worktree-wp-c-acceptance-task40';
const EVIDENCE_PATH = 'docs/acceptance/task40/evidence/evidence-c1-f1.json';
const REVERIFY_DOC = 'docs/acceptance/task40/TASK-40-F1闭环重验记录.md';

const failures = [];
function check(label, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

function gitShow(path) {
  return execFileSync('git', ['show', `${ARCHIVE_BRANCH}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

// ---------- 证据装载 ----------

let evidence;
try {
  evidence = JSON.parse(gitShow(EVIDENCE_PATH));
} catch (err) {
  console.error(`无法从归档分支读取证据（先执行 git fetch origin worktree-wp-c-acceptance-task40）：${err.message}`);
  process.exit(2);
}
const hasReverifyDoc = (() => {
  try {
    gitShow(REVERIFY_DOC);
    return true;
  } catch {
    return false;
  }
})();

// ---------- 演示线 1：C1 真实业务只读任务（真实模型 glm-4.6） ----------

console.log('\n=== 演示线 1 · C1 端到端真实业务只读任务（真实模型 glm-4.6） ===');
const c1 = evidence.c1;
console.log(`  任务 ${c1.taskRow.taskId}`);
console.log(`  Agent: ${c1.taskRow.agentId} @ version ${c1.taskRow.agentVersionId}`);
console.log(`  终态: ${c1.taskRow.status} | 模型调用 ${c1.taskRow.modelCallCount} 次 | tokens ${c1.taskRow.tokensUsed} | attempts ${c1.taskRow.attemptCount}`);
console.log(`  Trace: ${c1.eventCount} 事件（${c1.eventTypes.slice(0, 4).join(' → ')} → …）`);
check('C1 终态为 succeeded', c1.taskRow.status === 'succeeded');
check('C1 无终局失败归因', c1.taskRow.terminalFailureClass === null);
check('C1 Trace 事件数 = 37（与验收报告一致）', c1.eventCount === 37);

// ---------- 演示线 2：F-1 缺陷存证（修复前，CLI 分两进程） ----------

console.log('\n=== 演示线 2 · F-1 缺陷存证（修复前：run 进程启动扫描误杀 Queued） ===');
const f1 = evidence.f1_cli_defect;
for (const t of f1.crashedQueuedTasks) {
  console.log(`  任务 ${t.taskId}`);
  console.log(`  startedAt=${t.startedAt}（从未执行）→ ${t.status}: ${t.terminalFailureClass}`);
}
const seq = f1.traceSequence.map((e) => e.event);
console.log(`  Trace 序列: ${seq.join(' → ')}`);
check('缺陷形态 = Queued 未执行即被标记 CrashRecovery', f1.crashedQueuedTasks.every((t) => t.terminalFailureClass === 'Runtime(CrashRecovery)' && t.startedAt === null));
check('序列含 task_queued → crash_recovery_marked（未经过 task_started）', seq.includes('task_queued') && seq.includes('crash_recovery_marked') && !seq.includes('task_started'));

// ---------- 演示线 3：F-1 修复重验（修复后，真实模型两进程，归档记录） ----------

console.log('\n=== 演示线 3 · F-1 修复重验（修复后：真实模型 glm-4.6 CLI 两进程，README 快速开始原样） ===');
console.log('  归档记录: docs/acceptance/task40/TASK-40-F1闭环重验记录.md（worktree-wp-c-acceptance-task40 @ 4b2c1a2）');
console.log('  重验事实: 进程 A register→release→create 后退出；进程 B 启动扫描零迁移 → task run → succeeded');
console.log('            5 次模型调用 / 15456 tokens / Trace 46 事件 / crash_recovery_marked 0 次 / 结构化输出齐备');
check('F-1 闭环重验记录已归档', hasReverifyDoc);

// ---------- 汇总 ----------

console.log(`\n=== 走查结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`} ===`);
process.exit(failures.length === 0 ? 0 : 1);
