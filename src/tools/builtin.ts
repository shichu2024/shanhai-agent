import { existsSync, readdirSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ToolImpl } from '../modules/toolExecutor.js';
import { defaultRedactionPolicy, redactString, type RedactionPolicy } from '../modules/redaction.js';

// 内置工具（A2 附录 A：kind=builtin，进程内函数；implVersion 与代码 commit 关联）
// C1 真实业务只读任务载体：docs-list / docs-read（对本仓库 docs/ 做只读分析）。

// 批次三（§4.4）：新增 task-delegate 走 startup 的「不存在即登记」分支（无需 bump——存量绑定断言零扰动）；
// 委托原语实现面变更的 implVersion 由 Runtime 组合根的 Delegation 接线承载，不进 builtin impl 版本。
export const BUILTIN_TOOL_VERSION = '0.1.0';

export interface BuiltinToolDef {
  toolId: string;
  name: string;
  riskLevel: 'L0' | 'L1' | 'L2' | 'L3';
  implVersion: string;
  paramSchema: string;
  controlledFieldsSchema: string | null;
  description: string;
}

const docsListSchema = JSON.stringify({
  type: 'object',
  properties: {
    subdir: { type: 'string', minLength: 0, maxLength: 64, description: 'docs/ 下的子目录，空串为根' },
  },
  required: [],
  additionalProperties: false,
});

const docsReadSchema = JSON.stringify({
  type: 'object',
  properties: {
    file: { type: 'string', minLength: 1, maxLength: 128, description: '相对 docs/ 的文件路径' },
  },
  required: ['file'],
  additionalProperties: false,
});

const writeNoteSchema = JSON.stringify({
  type: 'object',
  properties: {
    note: { type: 'string', minLength: 1, maxLength: 2000 },
  },
  required: ['note'],
  additionalProperties: false,
});

// 第四阶段批次三（§4.4，D-30）：委托原语参数契约 { agentId, input, note? }——
// 可委托 agent 集合由 Spec 层 controlledFields.targetWhitelist 表达（A1 零新字段）。
const taskDelegateSchema = JSON.stringify({
  type: 'object',
  properties: {
    agentId: { type: 'string', minLength: 2, maxLength: 64, description: '被委托 Agent 的 agentId（须在 targetWhitelist 内）' },
    input: { type: 'object', description: '子任务输入（须符合子任务 inputContract）' },
    note: { type: 'string', minLength: 0, maxLength: 2000, description: '委托说明（审计留痕）' },
  },
  required: ['agentId', 'input'],
  additionalProperties: false,
});

export const BUILTIN_TOOL_DEFS: BuiltinToolDef[] = [
  {
    toolId: 'docs-list',
    name: '列出 docs 目录文件',
    riskLevel: 'L0',
    implVersion: BUILTIN_TOOL_VERSION,
    paramSchema: docsListSchema,
    controlledFieldsSchema: null,
    description: '只读：列出仓库 docs/ 目录（或其子目录）下的文件与子目录。',
  },
  {
    toolId: 'docs-read',
    name: '读取 docs 文件内容',
    riskLevel: 'L0',
    implVersion: BUILTIN_TOOL_VERSION,
    paramSchema: docsReadSchema,
    controlledFieldsSchema: null,
    description: '只读：读取仓库 docs/ 目录下指定文件的文本内容（上限 32KB）。',
  },
  {
    toolId: 'note-append',
    name: '追加工作笔记',
    riskLevel: 'L1',
    implVersion: BUILTIN_TOOL_VERSION,
    paramSchema: writeNoteSchema,
    controlledFieldsSchema: null,
    description: '低风险可逆副作用：向 data/notes.md 追加一行工作笔记（L1 强制审计）。',
  },
  {
    // §4.4 鲲鹏委托原语：登记缺省 L3（委托 = 代表父任务消耗另一 Agent 的全部预算与工具面）。
    // 它不是普通工具：四项类别属性（超时豁免/attempt=1 禁重试/childTaskId 幂等重入/子审批信号上浮）
    // 在 ToolExecutor 委托原语特殊类别路径显式建模（modules/toolExecutor.ts + runtime/delegation.ts）；
    // 无普通 impl 挂载（createBuiltinImpls 不含它）——resolveImpl Miss 由委托路径在前分派。
    toolId: 'task-delegate',
    name: '委托子任务',
    riskLevel: 'L3',
    implVersion: BUILTIN_TOOL_VERSION,
    paramSchema: taskDelegateSchema,
    controlledFieldsSchema: null,
    description: '委托原语（§4.4）：代表本任务将 input 委托给另一 Agent 阻塞式嵌套执行（L3 缺省人工审批；超时豁免/禁重试/幂等重入/信号上浮）。',
  },
];

function safeResolve(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function createBuiltinImpls(repoRoot: string, redaction: RedactionPolicy = defaultRedactionPolicy()): Map<string, ToolImpl> {
  const impls = new Map<string, ToolImpl>();
  const docsRoot = path.resolve(repoRoot, 'docs');

  impls.set('docs-list', (args) => {
    const subdir = typeof args.subdir === 'string' ? args.subdir : '';
    const dir = safeResolve(docsRoot, subdir);
    if (!dir || !existsSync(dir)) return { error: '目录不存在或越界' };
    return { entries: readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
  });

  impls.set('docs-read', (args) => {
    const file = typeof args.file === 'string' ? args.file : '';
    const resolved = safeResolve(docsRoot, file);
    if (!resolved || !existsSync(resolved)) return { error: '文件不存在或越界' };
    const content = readFileSync(resolved, 'utf8');
    return { path: file, size: content.length, content: content.length > 32768 ? content.slice(0, 32768) + '…[截断]' : content };
  });

  impls.set('note-append', (args) => {
    // 批次二（§4.2）：工具副作用输出过管道后再追加（data/ 属本地数据域——写入即脱敏）。
    // 同一 redaction 实例由组合根注入（缺省 = 默认规则集，管道不可削）。
    const note = redactString(typeof args.note === 'string' ? args.note : '', redaction);
    const notesDir = path.join(repoRoot, 'data');
    mkdirSync(notesDir, { recursive: true });
    appendFileSync(path.join(notesDir, 'notes.md'), `- ${new Date().toISOString()} ${note}\n`, 'utf8');
    return { appended: true };
  });

  return impls;
}
