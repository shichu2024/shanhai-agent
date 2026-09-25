#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Runtime, defaultDataDir } from './runtime.js';
import { queryT1, queryT2, queryT2Prime } from './evidence.js';
import { RegistrationError, REVIEW_ITEMS } from './modules/registry.js';
import { TaskCreationRejected } from './modules/taskManager.js';
import { ApprovalError } from './modules/approval.js';
import { buildAgentReport } from './modules/report.js';
import { EvidenceRefError } from './modules/evidenceStore.js';
import { connectMcpServer, type ToolCandidate } from './mcp/connect.js';

// A5 §2 CLI 命令表（v1 + v1.1 增补命令族：review / approval / --resume / --force / --no-pointer）

const repoRoot = process.cwd();
const dataDir = process.env.SHANHAI_DATA_DIR ?? defaultDataDir(repoRoot);

function usage(): never {
  console.log(`shanhai — 山海司 Runtime CLI（第一阶段 + 第二阶段批次一：审批 / Reviewed / 中止）

用法：
  shanhai agent register <spec.json> [--by <who>] [--from-candidate <candidateId>]   （候选↔版本关联显式回填）
  shanhai agent release <agentId> <versionId> [--no-pointer] [--by <who>]
  shanhai agent review <agentId> <versionId> [--by <who>]          （Draft→Reviewed，diff 检视清单逐项确认）
  shanhai agent deprecate <agentId> <versionId> [--by <who>]
  shanhai agent rollback <agentId> <versionId> [--by <who>]
  shanhai agent canary set <agentId> <versionId> --weight N   （灰度目标须 Released 且 ≠ current）
  shanhai agent canary clear <agentId>
  shanhai agent promote <agentId>                              （canary→current + 清零；判据为建议，决定权留人）
  shanhai agent report <agentId> [--since <RFC3339>]          （分组通过率 + promote 判据 + 旁挂三单列）
  shanhai agent list <agentId>
  shanhai agent show <agentId> [<versionId>]
  shanhai agent card <agentId> [versionId]                            （Agent Card 只读派生导出；缺省当前指针版本，永不存储）
  shanhai task create <agentId> <input.json> [--by <who>] [--draft|--reviewed]
  shanhai task run <taskId> [--strategy native|prompt] [--resume] [--resumed-by approve-spawn|manual-resume]
  shanhai task cancel <taskId> [--by <who>] [--force]              （--force = abort 立即中止/跨进程登记）
  shanhai task get <taskId>
  shanhai approval list [--pending]
  shanhai approval show <requestId>
  shanhai approval approve <requestId> [--by <who>] [--detach]     （只写 decision；默认前台 spawn resume）
  shanhai approval deny <requestId> [--by <who>] [--reason <text>]
  shanhai memory list [--agent <agentId>]                           （白泽记忆；顺带惰性全量校正）
  shanhai tool register --file <def.json> [--by <who>]              （登记/重登记工具；等级只升不降）
  shanhai tool list [--kind builtin|external] [--risk L0..L4]       （含来源/登记人/状态）
  shanhai tool show <toolId>
  shanhai tool retire <toolId> [--by <who>]                         （status=retired；调用点拦截）
  shanhai tool mcp connect <name> [--yes] [--by <who>]              （MCP 接入：发现→确认清单→批量登记；--yes 全按缺省 L3）
  shanhai evolution list                                            （女娲演进候选；顺带惰性聚合）
  shanhai evolution show <candidateId>
  shanhai evolution confirm <candidateId> [--proposed-change <text>]
  shanhai evolution dismiss <candidateId>
  shanhai evidence show <ref>                                        （证据单条解析；ref=<kind>:<id>，封闭枚举 task/trace_event/failure/memory/eval 预留位）
  shanhai evidence task <taskId>                                     （任务全链证据链：trace 对账 + failure/memory 关联 + 委托父子链；只读派生）
  shanhai query t1 <taskId>
  shanhai query t2 <versionId>
  shanhai query t2p <versionId>                                    （T2′ 审批可举证）

环境：SHANHAI_DATA_DIR（数据目录，默认 <repo>/data）；SHANHAI_CONFIG / config_local.json + 密钥环境变量（T3）`);
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
        // §4.4-3（批次三，D-22）：--from-candidate 显式回填候选↔版本关联（不自动关联——决定留人）
        const fromCandidate = flagValue(rest, '--from-candidate');
        if (fromCandidate) {
          const row = rt.evolutions.attachDerivedVersion(fromCandidate, versionId);
          console.log(JSON.stringify({ ok: true, versionId, derivedFromCandidate: fromCandidate, derivedVersionIds: JSON.parse(row.derivedVersionIds) }, null, 2));
        } else {
          console.log(JSON.stringify({ ok: true, versionId }, null, 2));
        }
      } else if (sub === 'release') {
        const [agentId, versionId] = pos;
        if (!agentId || !versionId) usage();
        rt.registry.release(agentId, versionId, by, { noPointer: rest.includes('--no-pointer') });
        console.log(JSON.stringify({ ok: true, agentId, versionId, op: 'release', noPointer: rest.includes('--no-pointer') }, null, 2));
      } else if (sub === 'review') {
        const [agentId, versionId] = pos;
        if (!agentId || !versionId) usage();
        // A5 §1 v1.1：自动生成 diff 报告 → 人工按 5 项清单逐项确认
        const diff = rt.registry.buildReviewDiff(agentId, versionId);
        console.log(`\n=== review 检视清单（diff 基线：${diff.diffAgainst ?? '无上一 Released 版本'}）===`);
        for (const item of diff.items) {
          const mark = item.flag === 'red' ? ' [标红]' : item.flag === 'yellow' ? ' [标黄]' : '';
          console.log(`  ${item.item}${mark} ${item.changed ? '变化' : '无变化'}：${item.detail}`);
        }
        const checklist = await confirmChecklist(diff.items.map((i) => i.item));
        if (checklist === null) {
          console.error(JSON.stringify({ ok: false, error: '检视确认被中止——不迁移（Draft 保持）' }));
          process.exit(1);
        }
        const result = rt.registry.review(agentId, versionId, by, checklist);
        console.log(JSON.stringify({ ok: true, agentId, versionId, status: 'reviewed', diffAgainst: result.diffAgainst }, null, 2));
      } else if (sub === 'deprecate' || sub === 'rollback') {
        const [agentId, versionId] = pos;
        if (!agentId || !versionId) usage();
        rt.registry[sub](agentId, versionId, by);
        console.log(JSON.stringify({ ok: true, agentId, versionId, op: sub }, null, 2));
      } else if (sub === 'canary') {
        const op = pos[0];
        if (op === 'set') {
          const [agentId, versionId] = pos.slice(1);
          const weight = Number(flagValue(rest, '--weight'));
          if (!agentId || !versionId || !Number.isInteger(weight)) usage();
          rt.registry.canarySet(agentId, versionId, weight, by);
          console.log(JSON.stringify({ ok: true, agentId, versionId, weight, op: 'canary-set' }, null, 2));
        } else if (op === 'clear') {
          const [agentId] = pos.slice(1);
          if (!agentId) usage();
          rt.registry.canaryClear(agentId, by);
          console.log(JSON.stringify({ ok: true, agentId, op: 'canary-clear', canary: rt.registry.getCanary(agentId) }, null, 2));
        } else usage();
      } else if (sub === 'promote') {
        const [agentId] = pos;
        if (!agentId) usage();
        const versionId = rt.registry.promote(agentId, by);
        console.log(JSON.stringify({ ok: true, agentId, versionId, op: 'promote', canary: rt.registry.getCanary(agentId) }, null, 2));
      } else if (sub === 'report') {
        const [agentId] = pos;
        if (!agentId) usage();
        const report = buildAgentReport((rt as unknown as { db: import('better-sqlite3').Database }).db, agentId, {
          since: flagValue(rest, '--since') ?? undefined,
          t1: (taskId) => queryT1(rt, taskId), // 健康面板 T1 P95 实测采样（批次四 DoD-①，§4.8 条件触发监测）
        });
        console.log(JSON.stringify(report, null, 2));
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
      } else if (sub === 'card') {
        // 批次四（§4.5，D-33）：Agent Card 只读派生导出——缺省当前指针版本；派生制品永不存储
        const [agentId, maybeVersion] = pos;
        if (!agentId) usage();
        console.log(JSON.stringify(rt.registry.agentCard(agentId, maybeVersion), null, 2));
      } else usage();
      break;
    }
    case 'task': {
      if (sub === 'create') {
        const [agentId, inputFile] = pos;
        if (!agentId || !inputFile || !existsSync(inputFile)) usage();
        const input = JSON.parse(readFileSync(inputFile, 'utf8'));
        const taskId = rt.tasks.createTask(agentId, input, by, {
          allowDraft: rest.includes('--draft'),
          allowReviewed: rest.includes('--reviewed'),
        });
        console.log(JSON.stringify({ ok: true, taskId }, null, 2));
      } else if (sub === 'run') {
        const [taskId] = pos;
        if (!taskId) usage();
        const strategyFlag = flagValue(rest, '--strategy');
        const strategy = strategyFlag === 'native' || strategyFlag === 'prompt' ? strategyFlag : null;
        if (rest.includes('--resume')) {
          const resumedByFlag = flagValue(rest, '--resumed-by');
          const row = await rt.tasks.runTask(taskId, strategy, {
            resume: true,
            resumedBy: resumedByFlag === 'approve-spawn' ? 'approve-spawn' : 'manual-resume',
          });
          console.log(JSON.stringify({
            ok: true, taskId, status: row.status, terminalFailureClass: row.terminalFailureClass,
            modelCallCount: row.modelCallCount, tokensUsed: row.tokensUsed,
          }, null, 2));
          if (row.status === 'paused') {
            const pending = rt.approvals.pendingForTask(taskId);
            console.error(`任务挂起等待审批（requestId=${pending?.requestId ?? '?'}；approve 后由 resume 进程续跑）`);
            process.exitCode = 3; // exit code 提示「awaiting approval」（F-1 流）
          }
        } else {
          const row = await rt.tasks.runTask(taskId, strategy);
          console.log(JSON.stringify({
            ok: true, taskId, status: row.status, terminalFailureClass: row.terminalFailureClass,
            modelCallCount: row.modelCallCount, tokensUsed: row.tokensUsed,
          }, null, 2));
          if (row.status === 'paused') {
            const pending = rt.approvals.pendingForTask(taskId);
            console.error(`任务挂起等待审批（requestId=${pending?.requestId ?? '?'}；approve 后由 resume 进程续跑）`);
            process.exitCode = 3;
          }
        }
      } else if (sub === 'cancel') {
        const [taskId] = pos;
        if (!taskId) usage();
        const result = rt.tasks.cancel(taskId, by, { force: rest.includes('--force') });
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else if (sub === 'get') {
        const [taskId] = pos;
        if (!taskId) usage();
        console.log(JSON.stringify(rt.tasks.getTask(taskId), null, 2));
      } else usage();
      break;
    }
    case 'approval': {
      if (sub === 'list') {
        console.log(JSON.stringify(rt.approvals.list({ pendingOnly: rest.includes('--pending') }), null, 2));
      } else if (sub === 'show') {
        const [requestId] = pos;
        if (!requestId) usage();
        console.log(JSON.stringify(rt.approvals.show(requestId), null, 2));
      } else if (sub === 'approve') {
        const [requestId] = pos;
        if (!requestId) usage();
        const { taskId } = rt.approvals.approve(requestId, by);
        // R-1：approve 只写 decision（任务保持 Paused）；默认前台 spawn resume，--detach 可选（manual-resume 兜底）
        if (rest.includes('--detach')) {
          console.log(JSON.stringify({ ok: true, requestId, taskId, decision: 'approved', spawned: false, note: '--detach：任务停留 Paused，由 task run --resume 手动续跑' }, null, 2));
        } else {
          console.log(JSON.stringify({ ok: true, requestId, taskId, decision: 'approved', spawned: true, resumedBy: 'approve-spawn' }, null, 2));
          const cliEntry = path.resolve(process.argv[1] ?? 'dist/cli.js');
          const child = spawn(process.execPath, [cliEntry, 'task', 'run', '--resume', taskId, '--resumed-by', 'approve-spawn', '--by', by], { stdio: 'inherit' });
          const code: number = await new Promise((resolve) => {
            child.on('exit', (c) => resolve(c ?? 0));
            child.on('error', () => resolve(1));
          });
          if (code !== 0) {
            console.error(`resume 进程退出码 ${code}（spawn 失败不影响任务状态与 decision——task run --resume ${taskId} 手动续跑兜底）`);
            process.exitCode = code;
          }
        }
      } else if (sub === 'deny') {
        const [requestId] = pos;
        if (!requestId) usage();
        const { taskId } = rt.approvals.deny(requestId, by, flagValue(rest, '--reason') ?? undefined);
        console.log(JSON.stringify({ ok: true, requestId, taskId, decision: 'denied', taskStatus: 'cancelled', cancelReason: 'approval_denied' }, null, 2));
      } else usage();
      break;
    }
    case 'tool': {
      if (sub === 'register') {
        const file = flagValue(rest, '--file');
        if (!file || !existsSync(file)) usage();
        const def = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        rt.registry.registerTool(
          {
            toolId: String(def.toolId),
            name: String(def.name ?? def.toolId),
            kind: def.kind === 'external' ? 'external' : 'builtin',
            riskLevel: def.riskLevel as 'L0' | 'L1' | 'L2' | 'L3' | 'L4',
            implVersion: String(def.implVersion ?? '0.1.0'),
            paramSchema: typeof def.paramSchema === 'string' ? def.paramSchema : JSON.stringify(def.paramSchema ?? {}),
            controlledFieldsSchema: def.controlledFieldsSchema === undefined || def.controlledFieldsSchema === null
              ? null
              : (typeof def.controlledFieldsSchema === 'string' ? def.controlledFieldsSchema : JSON.stringify(def.controlledFieldsSchema)),
            status: def.status === 'retired' ? 'retired' : 'active',
            ...(def.source !== undefined ? { source: String(def.source) } : {}),
            ...(def.registeredBy !== undefined ? { registeredBy: String(def.registeredBy) } : {}),
            ...(def.description !== undefined ? { description: String(def.description) } : {}),
          },
          by,
        );
        console.log(JSON.stringify({ ok: true, toolId: def.toolId, op: rt.registry.getTool(String(def.toolId)) ? 'reregistered' : 'registered' }, null, 2));
      } else if (sub === 'list') {
        const kindFlag = flagValue(rest, '--kind');
        const riskFlag = flagValue(rest, '--risk');
        console.log(JSON.stringify(
          rt.registry.listTools({
            kind: kindFlag === 'builtin' || kindFlag === 'external' ? kindFlag : undefined,
            riskLevel: riskFlag && /^L[0-4]$/.test(riskFlag) ? (riskFlag as 'L0') : undefined,
          }).map(({ toolId, name, kind, riskLevel, status, source, registeredBy, registeredAt }) => ({ toolId, name, kind, riskLevel, status, source: source ?? null, registeredBy: registeredBy ?? null, registeredAt })),
          null, 2,
        ));
      } else if (sub === 'show') {
        const [toolId] = pos;
        if (!toolId) usage();
        const row = rt.registry.getTool(toolId);
        if (!row) {
          console.error(JSON.stringify({ ok: false, error: `工具不存在：${toolId}` }));
          process.exit(1);
        }
        console.log(JSON.stringify({ ...row, paramSchema: JSON.parse(row.paramSchema) }, null, 2));
      } else if (sub === 'retire') {
        const [toolId] = pos;
        if (!toolId) usage();
        rt.registry.retireTool(toolId, by);
        console.log(JSON.stringify({ ok: true, toolId, status: 'retired' }, null, 2));
      } else if (sub === 'mcp') {
        if (pos[0] !== 'connect') usage();
        const name = pos[1];
        if (!name) usage();
        const yes = rest.includes('--yes');
        const result = await connectMcpServer(
          { registry: rt.registry, servers: rt.mcpServers, who: by },
          name,
          { yes, confirm: yes ? undefined : confirmMcpLevels },
        );
        if (result.aborted) {
          console.error(JSON.stringify({ ok: false, error: '确认清单被中止——不登记（零副作用）' }));
          process.exit(1);
        }
        console.log(JSON.stringify({
          ok: true, serverName: result.serverName, serverInfo: result.serverInfo,
          spawnMs: result.spawnMs, listMs: result.listMs,
          registered: result.registrations.map((r) => ({ toolId: r.toolId, riskLevel: r.riskLevel })),
          specSnippet: JSON.parse(result.specSnippet),
        }, null, 2));
      } else usage();
      break;
    }
    case 'memory': {
      if (sub === 'list') {
        // 顺带执行惰性全量校正（§4.4-3-②，与审批超时惰性判定同一模式）
        const agentId = flagValue(rest, '--agent');
        console.log(JSON.stringify(rt.memories.list(agentId ?? undefined), null, 2));
      } else usage();
      break;
    }
    case 'evolution': {
      // §4.5-6（批次三，D-24）：policiesOf 消费 registry 单一实现（回溯全量倒序，已弃用版本声明仍统治）
      const policiesOf = (agentId: string) => rt.registry.evolutionPolicyOf(agentId);
      if (sub === 'list') {
        rt.evolutions.aggregateRepeatedFailures(policiesOf); // 惰性聚合（F-6）
        console.log(JSON.stringify(rt.evolutions.list(), null, 2));
      } else if (sub === 'show') {
        const [candidateId] = pos;
        if (!candidateId) usage();
        console.log(JSON.stringify(rt.evolutions.get(candidateId), null, 2));
      } else if (sub === 'confirm') {
        const [candidateId] = pos;
        if (!candidateId) usage();
        const row = rt.evolutions.confirm(candidateId, by, flagValue(rest, '--proposed-change') ?? undefined);
        console.log(JSON.stringify({ ok: true, candidateId: row.candidateId, status: row.status, note: '产物新版本由人工起草：register → review → release --no-pointer → canary set' }, null, 2));
      } else if (sub === 'dismiss') {
        const [candidateId] = pos;
        if (!candidateId) usage();
        const row = rt.evolutions.dismiss(candidateId, by);
        console.log(JSON.stringify({ ok: true, candidateId: row.candidateId, status: row.status }, null, 2));
      } else usage();
      break;
    }
    case 'evidence': {
      // 第五阶段批次一（§4.1，D-35）：Evidence Store 只读派生存取层——零写入；结构化错误不静默
      if (sub === 'show') {
        const [ref] = pos;
        if (!ref) usage();
        try {
          const result = rt.evidence.show(ref);
          if (!result.ok) {
            console.error(JSON.stringify({ ok: false, code: result.code, ref: result.ref, error: result.message }, null, 2));
            process.exit(1);
          }
          console.log(JSON.stringify(result, null, 2));
        } catch (err) {
          if (err instanceof EvidenceRefError) {
            console.error(JSON.stringify({ ok: false, code: err.code, ref: err.ref, error: err.message }, null, 2));
            process.exit(1);
          }
          throw err;
        }
      } else if (sub === 'task') {
        const [taskId] = pos;
        if (!taskId) usage();
        const result = rt.evidence.taskEvidence(taskId);
        if (!result.ok) {
          console.error(JSON.stringify({ ok: false, code: result.code, ref: result.ref, error: result.message }, null, 2));
          process.exit(1);
        }
        console.log(JSON.stringify(result, null, 2));
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
      } else if (sub === 't2p') {
        const [versionId] = pos;
        if (!versionId) usage();
        console.log(JSON.stringify(queryT2Prime(rt, versionId), null, 2));
      } else usage();
      break;
    }
    default:
      usage();
  }
}

/** MCP connect 确认清单（§4.2-1 manual 档）：逐工具评级确认（回车 = 缺省 L3；n = 中止）；返回 null = 中止 */
async function confirmMcpLevels(candidates: ToolCandidate[]): Promise<Record<string, 'L0' | 'L1' | 'L2' | 'L3'> | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim())));
  const levels: Record<string, 'L0' | 'L1' | 'L2' | 'L3'> = {};
  try {
    console.log(`\n=== MCP 确认清单（server=${candidates[0]?.toolId.split('__')[0] ?? '?'}；缺省勾选 L3；readOnlyHint 仅建议不自动降级）===`);
    for (const c of candidates) {
      console.log(`  ${c.toolId}——${c.description || c.name}${c.readOnlyHint ? ' [readOnlyHint→可考虑 L1/L2]' : ''}${Object.keys(c.paramRanges).length > 0 ? ` [受控字段候选 ${JSON.stringify(c.paramRanges)}]` : ''}`);
    }
    for (const c of candidates) {
      const answer = await ask(`工具 ${c.toolId} 评级（回车=L3 / L0-L3 / n 中止）: `);
      if (answer === 'n') return null;
      if (answer !== '' && !/^L[0-3]$/.test(answer)) {
        console.log('仅接受回车（缺省 L3）、L0-L3 或 n（中止）');
        return null;
      }
      levels[c.toolId] = answer === '' ? 'L3' : (answer as 'L0' | 'L1' | 'L2' | 'L3');
    }
    return levels;
  } finally {
    rl.close();
  }
}

/** 检视清单逐项交互确认（manual 档，A5 §1）；返回 null = 用户中止 */
async function confirmChecklist(items: readonly string[]): Promise<{ item: string; verdict: boolean; note?: string }[] | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim().toLowerCase())));
  const checklist: { item: string; verdict: boolean; note?: string }[] = [];
  try {
    for (const item of REVIEW_ITEMS) {
      void items;
      const answer = await ask(`检视项 [${item}] 是否通过？(y/n) `);
      if (answer !== 'y' && answer !== 'n') {
        console.log('仅接受 y/n（不通过即拒绝迁移）');
        return null;
      }
      checklist.push({ item, verdict: answer === 'y' });
    }
    return checklist;
  } finally {
    rl.close();
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
  } else if (err instanceof ApprovalError) {
    console.error(JSON.stringify({ ok: false, error: err.message, code: err.code, detail: err.detail ?? null }, null, 2));
  } else {
    console.error(JSON.stringify({ ok: false, error: (err as Error).message ?? String(err) }, null, 2));
  }
  process.exit(1);
});
