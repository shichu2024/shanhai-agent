#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Runtime, defaultDataDir } from './runtime.js';
import { queryT1, queryT2 } from './evidence.js';
import { RegistrationError } from './modules/registry.js';
import { TaskCreationRejected } from './modules/taskManager.js';

// A5 §2 CLI 命令表：agent register/release/deprecate/rollback/list/show + task + query

const repoRoot = process.cwd();
const dataDir = process.env.SHANHAI_DATA_DIR ?? defaultDataDir(repoRoot);

function usage(): never {
  console.log(`shanhai — 山海司第一阶段最小 Runtime CLI

用法：
  shanhai agent register <spec.json> [--by <who>]
  shanhai agent release <agentId> <versionId> [--by <who>]
  shanhai agent deprecate <agentId> <versionId> [--by <who>]
  shanhai agent rollback <agentId> <versionId> [--by <who>]
  shanhai agent list <agentId>
  shanhai agent show <agentId> [<versionId>]
  shanhai task create <agentId> <input.json> [--by <who>] [--draft]
  shanhai task run <taskId> [--strategy native|prompt] [--draft]
  shanhai task cancel <taskId> [--by <who>]
  shanhai task get <taskId>
  shanhai query t1 <taskId>
  shanhai query t2 <versionId>

环境：SHANHAI_DATA_DIR（数据目录，默认 <repo>/data）；SHANHAI_CONFIG / config.local.json + 密钥环境变量（T3）`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const rt = Runtime.fromConfig(dataDir, repoRoot);
  rt.startup('cli');
  const by = flagValue(rest, '--by') ?? 'cli';
  const pos = positional(rest);

  switch (cmd) {
    case 'agent': {
      if (sub === 'register') {
        const file = pos[0];
        if (!file || !existsSync(file)) usage();
        const spec = JSON.parse(readFileSync(file, 'utf8'));
        const versionId = rt.registry.registerSpec(spec, by, validationDeps(rt));
        console.log(JSON.stringify({ ok: true, versionId }, null, 2));
      } else if (sub === 'release' || sub === 'deprecate' || sub === 'rollback') {
        const [agentId, versionId] = pos;
        if (!agentId || !versionId) usage();
        rt.registry[sub](agentId, versionId, by);
        console.log(JSON.stringify({ ok: true, agentId, versionId, op: sub }, null, 2));
      } else if (sub === 'list') {
        const [agentId] = pos;
        if (!agentId) usage();
        console.log(JSON.stringify(
          rt.registry.listVersions(agentId).map(({ versionId, version, contentHash, status, registeredAt }) => ({ versionId, version, contentHash, status, registeredAt })),
          null, 2,
        ));
      } else if (sub === 'show') {
        const [agentId, maybeVersion] = pos;
        if (!agentId) usage();
        const versionId = maybeVersion ?? rt.registry.getPointer(agentId);
        if (!versionId) usage();
        const row = rt.registry.getVersion(versionId);
        if (!row) {
          console.error(JSON.stringify({ ok: false, error: `版本不存在：${versionId}` }));
          process.exit(1);
        }
        console.log(JSON.stringify({ ...row, specSnapshot: JSON.parse(row.specSnapshot) }, null, 2));
      } else usage();
      break;
    }
    case 'task': {
      if (sub === 'create') {
        const [agentId, inputFile] = pos;
        if (!agentId || !inputFile || !existsSync(inputFile)) usage();
        const input = JSON.parse(readFileSync(inputFile, 'utf8'));
        const taskId = rt.tasks.createTask(agentId, input, by, { allowDraft: rest.includes('--draft') });
        console.log(JSON.stringify({ ok: true, taskId }, null, 2));
      } else if (sub === 'run') {
        const [taskId] = pos;
        if (!taskId) usage();
        const strategyFlag = flagValue(rest, '--strategy');
        const strategy = strategyFlag === 'native' || strategyFlag === 'prompt' ? strategyFlag : null;
        const row = await rt.tasks.runTask(taskId, strategy);
        console.log(JSON.stringify({
          ok: true, taskId, status: row.status, terminalFailureClass: row.terminalFailureClass,
          modelCallCount: row.modelCallCount, tokensUsed: row.tokensUsed,
        }, null, 2));
      } else if (sub === 'cancel') {
        const [taskId] = pos;
        if (!taskId) usage();
        rt.tasks.cancel(taskId, by);
        console.log(JSON.stringify({ ok: true, taskId, note: 'Queued→Cancelled 即时；Running 等待当前原子调用完成后生效' }, null, 2));
      } else if (sub === 'get') {
        const [taskId] = pos;
        if (!taskId) usage();
        console.log(JSON.stringify(rt.tasks.getTask(taskId), null, 2));
      } else usage();
      break;
    }
    case 'query': {
      if (sub === 't1') {
        const [taskId] = pos;
        if (!taskId) usage();
        console.log(JSON.stringify(queryT1(rt, taskId), null, 2));
      } else if (sub === 't2') {
        const [versionId] = pos;
        if (!versionId) usage();
        console.log(JSON.stringify(queryT2(rt, versionId), null, 2));
      } else usage();
      break;
    }
    default:
      usage();
  }
}

function validationDeps(rt: Runtime) {
  return {
    getTool: (id: string) => {
      const t = rt.registry.getTool(id);
      return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null;
    },
    modelWhitelist: rt.gateway.modelWhitelist,
  };
}

function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('--'));
}

function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

main().catch((err) => {
  if (err instanceof RegistrationError || err instanceof TaskCreationRejected) {
    console.error(JSON.stringify({ ok: false, error: err.message, issues: err.issues }, null, 2));
  } else {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message ?? String(err) }, null, 2));
  }
  process.exit(1);
});
