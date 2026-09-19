// 增补 A：被强杀的子进程。脚本序列：
//   第 1 次模型调用 → tool_use undeclared-evil（拒 1，policy_denied 落盘）
//   第 2 次模型调用 → tool_use docs-list（成功，计数清零）
//   第 3 次模型调用 → delay 60000（父进程在此窗口 SIGKILL）
import { mkdirSync, writeFileSync } from 'node:fs';
import { Runtime } from '../../dist/runtime.js';
import { MockProvider } from '../../dist/providers/mock.js';

const dataDir = process.argv[2];
mkdirSync(dataDir, { recursive: true });

const spec = {
  specVersion: '1',
  identity: { agentId: 'crash-agent', name: 'crash-agent', description: 'kill -9 用例', author: 'wp-c-acceptor' },
  mission: { responsibilities: ['测试用'], nonResponsibilities: ['任何真实操作'] },
  inputContract: { type: 'object', properties: { topic: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['topic'], additionalProperties: false },
  outputContract: {
    type: 'object',
    properties: { summary: { type: 'string', minLength: 1, maxLength: 500 }, filesCovered: { type: 'integer', minimum: 0, maximum: 1000 }, verdict: { type: 'string', enum: ['ok', 'needs-review'] } },
    required: ['summary', 'filesCovered', 'verdict'], additionalProperties: false,
  },
  modelPolicy: { allowedModels: ['mock-model'], maxModelCalls: 50, maxTokens: 100000 },
  toolPolicy: { tools: [{ toolId: 'docs-list', riskLevel: 'L0' }] },
};

const rt = new Runtime({
  dataDir, repoRoot: process.cwd(),
  provider: new MockProvider([
    { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'undeclared-evil', args: {} }] },
    { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'docs-list', args: { subdir: '' } }] },
    { kind: 'delay', ms: 60000 },
    { kind: 'text', text: JSON.stringify({ summary: '不应到达', filesCovered: 0, verdict: 'ok' }) },
  ]),
  whitelist: new Set(['mock-model']),
});
rt.startup('crash-child');
const deps = {
  getTool: (id) => { const t = rt.registry.getTool(id); return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null; },
  modelWhitelist: rt.gateway.modelWhitelist,
};
const versionId = rt.registry.registerSpec(spec, 'wp-c-acceptor', deps);
rt.registry.release('crash-agent', versionId, 'wp-c-acceptor');
const taskId = rt.tasks.createTask('crash-agent', { topic: 'kill -9 演练' }, 'wp-c-acceptor');
writeFileSync(dataDir + '/crash-meta.json', JSON.stringify({ taskId, versionId }));
console.log('CHILD READY', taskId);
const row = await rt.tasks.runTask(taskId); // 永不在被杀前完成
console.log('UNEXPECTED', row.status);
