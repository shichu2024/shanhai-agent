// C1 端到端（单进程）：注册→校验→执行（真实模型 glm-4.6）→Trace 落盘→终态与归因
// 说明：CLI 两进程 create→run 路径存在启动恢复扫描自杀缺陷（验收发现 F-1），
// 本脚本在单进程内完成 create→run，验证核心生命周期；注册/发布仍走 CLI 已验证。
import { readFileSync, mkdirSync } from 'node:fs';
import { Runtime } from '../../dist/runtime.js';
import { queryT1 } from '../../dist/evidence.js';

const dataDir = 'D:/code/shanhai-agent/data/acceptance-task40/c1b';
mkdirSync(dataDir, { recursive: true });
const spec = JSON.parse(readFileSync('D:/code/shanhai-agent/data/acceptance-task40/spec-c1.json', 'utf8'));

const rt = Runtime.fromConfig(dataDir, process.cwd());
rt.startup('wp-c-c1');
const deps = {
  getTool: (id) => { const t = rt.registry.getTool(id); return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null; },
  modelWhitelist: rt.gateway.modelWhitelist,
};
const versionId = rt.registry.registerSpec(spec, 'wp-c-acceptor', deps);
rt.registry.release('docs-analyst', versionId, 'wp-c-acceptor');
console.log(JSON.stringify({ step: 'register+release', versionId }));

const input = JSON.parse(readFileSync('D:/code/shanhai-agent/data/acceptance-task40/input-c1.json', 'utf8'));
const taskId = rt.tasks.createTask('docs-analyst', input, 'wp-c-acceptor');
console.log(JSON.stringify({ step: 'createTask', taskId }));

const row = await rt.tasks.runTask(taskId);
console.log(JSON.stringify({ step: 'runTask', status: row.status, terminalFailureClass: row.terminalFailureClass, modelCallCount: row.modelCallCount, tokensUsed: row.tokensUsed, attemptCount: row.attemptCount }, null, 2));

const events = rt.trace.readEvents(taskId);
console.log(JSON.stringify({ step: 'trace', eventCount: events.length, eventTypes: events.map((e) => e.eventType) }));
const succeeded = events.find((e) => e.eventType === 'task_succeeded');
if (succeeded) console.log(JSON.stringify({ step: 'output', output: succeeded.output }, null, 2));

const t1 = queryT1(rt, taskId);
console.log(JSON.stringify({ step: 't1', agentVersionId: t1.agentVersionId, specContentHash: t1.specContentHash, hasTaskStarted: t1.hasTaskStarted, bindingSnapshot: t1.bindingSnapshot }, null, 2));
rt.close();
