// C3-②③（确定性 mock Provider）+ T1/T2 证据数据生成
// C3-②：maxModelCalls=1 + 第二次调用 → 确定性截停 Failed:Runtime(BudgetExceeded)
// C3-③：连续 ≥2 次被拒工具 → Failed:Policy(PolicyBlocked)，归因不漂移（无 BudgetExceeded 记录）
// 附加：无效输入任务创建 → RejectedRequest（T2 kind=task_creation 切片）
import { mkdirSync } from 'node:fs';
import { Runtime } from '../../dist/runtime.js';
import { MockProvider } from '../../dist/providers/mock.js';
import { queryT1, queryT2 } from '../../dist/evidence.js';

const dataDir = 'D:/code/shanhai-agent/data/acceptance-task40/c3mock';
mkdirSync(dataDir, { recursive: true });

const spec = (agentId, modelPolicy) => ({
  specVersion: '1',
  identity: { agentId, name: agentId, description: 'C3 用例 ' + agentId, author: 'wp-c-acceptor' },
  mission: { responsibilities: ['测试用'], nonResponsibilities: ['任何真实操作'] },
  inputContract: { type: 'object', properties: { topic: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['topic'], additionalProperties: false },
  outputContract: {
    type: 'object',
    properties: { summary: { type: 'string', minLength: 1, maxLength: 500 }, filesCovered: { type: 'integer', minimum: 0, maximum: 1000 }, verdict: { type: 'string', enum: ['ok', 'needs-review'] } },
    required: ['summary', 'filesCovered', 'verdict'], additionalProperties: false,
  },
  modelPolicy: { allowedModels: ['mock-model'], ...modelPolicy },
  toolPolicy: { tools: [{ toolId: 'docs-list', riskLevel: 'L0' }] },
});
const validJson = JSON.stringify({ summary: '覆盖 3 份规格文档。', filesCovered: 3, verdict: 'ok' });
const deps = (rt) => ({
  getTool: (id) => { const t = rt.registry.getTool(id); return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null; },
  modelWhitelist: rt.gateway.modelWhitelist,
});
const out = {};

// ---- C3-② 预算确定性截停 ----
{
  const rt = new Runtime({ dataDir, repoRoot: process.cwd(), provider: new MockProvider([
    { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'docs-list', args: { subdir: '' } }] },
    { kind: 'text', text: validJson },
  ]), whitelist: new Set(['mock-model']) });
  rt.startup('wp-c-c3');
  const vid = rt.registry.registerSpec(spec('c3-budget', { maxModelCalls: 1, maxTokens: 100000 }), 'wp-c-acceptor', deps(rt));
  rt.registry.release('c3-budget', vid, 'wp-c-acceptor');
  const taskId = rt.tasks.createTask('c3-budget', { topic: '预算截停' }, 'wp-c-acceptor');
  const row = await rt.tasks.runTask(taskId);
  const failures = rt.failures.forTask(taskId);
  out.c3_2 = { versionId: vid, taskId, status: row.status, terminalFailureClass: row.terminalFailureClass, modelCallCount: row.modelCallCount,
    failureRecords: failures.map((f) => ({ failureClass: f.failureClass, subClass: f.subClass })) };
  // T1 证据（Failed 任务）：单一查询返回生效 Spec 版本 + Prompt/工具版本关联
  const t1 = queryT1(rt, taskId);
  out.t1_onFailed = { taskId, agentVersionId: t1.agentVersionId, specContentHash: t1.specContentHash, hasTaskStarted: t1.hasTaskStarted,
    bindingSnapshot: t1.bindingSnapshot, specIdentity: t1.specSnapshot.identity };
  rt.close();
}

// ---- C3-③ 连续拦截 → PolicyBlocked，归因不漂移 ----
{
  const rt = new Runtime({ dataDir, repoRoot: process.cwd(), provider: new MockProvider([
    { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'undeclared-evil', args: {} }] },
    { kind: 'tool_use', calls: [{ id: 'd2', toolId: 'another-evil', args: {} }] },
  ]), whitelist: new Set(['mock-model']) });
  rt.startup('wp-c-c3');
  const vid = rt.registry.registerSpec(spec('c3-policy', { maxModelCalls: 50, maxTokens: 100000 }), 'wp-c-acceptor', deps(rt));
  rt.registry.release('c3-policy', vid, 'wp-c-acceptor');
  const taskId = rt.tasks.createTask('c3-policy', { topic: '连续拦截' }, 'wp-c-acceptor');
  const row = await rt.tasks.runTask(taskId);
  const failures = rt.failures.forTask(taskId);
  out.c3_3 = { versionId: vid, taskId, status: row.status, terminalFailureClass: row.terminalFailureClass, consecutiveDenialCount: row.consecutiveDenialCount,
    failureRecords: failures.map((f) => ({ failureClass: f.failureClass, subClass: f.subClass })),
    attributionNoDrift: !failures.some((f) => f.subClass === 'BudgetExceeded') };

  // RejectedRequest 种子：无效输入（缺 topic）→ 落库前拒绝，进 T2 的 task_creation 切片
  try { rt.tasks.createTask('c3-policy', { wrong: 1 }, 'wp-c-acceptor'); } catch (e) { out.rejectedInput = { rejected: true, message: e.message }; }

  // T2 证据：单一查询返回该版本运行期全部越权尝试与拦截点
  const t2 = queryT2(rt, vid);
  out.t2 = { agentVersionId: t2.agentVersionId,
    policyDeniedEvents: t2.policyDeniedEvents,
    rejectedRequests: t2.rejectedRequests.map((r) => ({ kind: r.kind, target: r.target, rejectReason: (r.rejectReason ?? '').slice(0, 80) })),
    unresolvableTaskCreations: t2.unresolvableTaskCreations };
  rt.close();
}
console.log(JSON.stringify(out, null, 2));
