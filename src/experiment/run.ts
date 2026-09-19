import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Runtime } from '../runtime.js';
import { loadRuntimeConfig, buildProviderFromConfig, modelWhitelistOf } from '../config.js';
import { generateReport } from './report.js';

// 假设 #4 验证实验（11 号 §2.2，定稿 §7）：3 类 Spec × 10 任务，策略 A/B 对照，
// 首次通过率主指标；实验数据走 TraceRecorder 标准通道（「实验数据 = Trace 数据」）。
// 制品冻结：specs/ 与 tasks/ 已提交 Git，启动哈希记录于报告首部；启动后不得修改。

const REPO_ROOT = process.cwd();
const SPEC_IDS = ['s1-summary', 's2-extraction', 's3-decision-report'] as const;
const STRATEGIES = ['A', 'B'] as const;

function usage(): never {
  console.log('用法：node dist/experiment/run.js [--concurrency 3]');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const concurrency = Number(args[args.indexOf('--concurrency') + 1] ?? 3) || 3;

  const config = loadRuntimeConfig();
  const model = [...modelWhitelistOf(config)][0];
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dataDir = path.join(REPO_ROOT, 'experiment-runs', `hyp4-${runStamp}`);
  mkdirSync(dataDir, { recursive: true });

  const rt = new Runtime({
    dataDir,
    repoRoot: REPO_ROOT,
    provider: buildProviderFromConfig(config),
    whitelist: modelWhitelistOf(config),
  });
  const startup = rt.startup('experiment');
  console.log(`[experiment] 模型=${model} 数据目录=${dataDir} 恢复=${JSON.stringify(startup)}`);

  // 注册并发布 3 类 Spec（__EXPERIMENT_MODEL__ 占位替换为配置模型——T3：模型不在制品中）
  const deps = {
    getTool: (id: string) => {
      const t = rt.registry.getTool(id);
      return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null;
    },
    modelWhitelist: rt.gateway.modelWhitelist,
  };
  const specVersions: Record<string, string> = {};
  for (const specId of SPEC_IDS) {
    const file = path.join(REPO_ROOT, 'experiments', 'hypothesis4', 'specs', `${specId}.json`);
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    spec.modelPolicy.allowedModels = [model];
    const versionId = rt.registry.registerSpec(spec, 'experiment', deps);
    rt.registry.release(spec.identity.agentId, versionId, 'experiment');
    specVersions[specId] = versionId;
  }

  interface Job {
    specId: string; strategy: (typeof STRATEGIES)[number]; task: { id: string } & Record<string, unknown>;
    taskId: string | null; error: string | null;
  }
  const jobs: Job[] = [];
  for (const specId of SPEC_IDS) {
    const tasks = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'experiments', 'hypothesis4', 'tasks', `${specId.split('-')[0]}.json`), 'utf8'),
    ) as { id: string }[];
    for (const strategy of STRATEGIES) {
      for (const task of tasks) {
        jobs.push({ specId, strategy, task, taskId: null, error: null });
      }
    }
  }

  let cursor = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      const input = { ...job.task };
      delete (input as Record<string, unknown>).id;
      try {
        const taskId = rt.tasks.createTask(`hyp4-${job.specId}`, input, 'experiment');
        job.taskId = taskId;
        const row = await rt.tasks.runTask(taskId, job.strategy === 'A' ? 'native' : 'prompt');
        completed += 1;
        console.log(`[experiment ${completed}/${jobs.length}] ${job.specId}/${job.strategy}/${job.task.id} → ${row.status}${row.terminalFailureClass ? `(${row.terminalFailureClass})` : ''}`);
      } catch (err) {
        job.error = (err as Error).message;
        completed += 1;
        console.error(`[experiment FAIL ${completed}/${jobs.length}] ${job.specId}/${job.strategy}/${job.task.id}: ${job.error}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const gitHash = getGitHead();
  const report = generateReport({
    rt,
    specIds: [...SPEC_IDS],
    specLabels: Object.fromEntries(SPEC_IDS.map((s) => [s, s])),
    strategies: [...STRATEGIES],
    model,
    gitHash,
    jobs,
  });
  const reportPath = path.join(REPO_ROOT, 'experiments', 'reports', `hypothesis4-${runStamp}.md`);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report, 'utf8');
  console.log(`[experiment] 报告已写入：${reportPath}`);
  rt.close();
}

function getGitHead(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return '(git 不可用)';
  }
}

if (!existsSync(path.join(REPO_ROOT, 'experiments', 'hypothesis4'))) usage();
main().catch((err) => {
  console.error(`[experiment] 致命错误：${(err as Error).stack ?? err}`);
  process.exit(1);
});
