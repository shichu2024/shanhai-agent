import { existsSync, readdirSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ToolImpl } from '../modules/toolExecutor.js';

// 内置工具（A2 附录 A：kind=builtin，进程内函数；implVersion 与代码 commit 关联）
// C1 真实业务只读任务载体：docs-list / docs-read（对本仓库 docs/ 做只读分析）。

export const BUILTIN_TOOL_VERSION = '0.1.0';

export interface BuiltinToolDef {
  toolId: string;
  name: string;
  riskLevel: 'L0' | 'L1' | 'L2';
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
];

function safeResolve(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function createBuiltinImpls(repoRoot: string): Map<string, ToolImpl> {
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
    const note = typeof args.note === 'string' ? args.note : '';
    const notesDir = path.join(repoRoot, 'data');
    mkdirSync(notesDir, { recursive: true });
    appendFileSync(path.join(notesDir, 'notes.md'), `- ${new Date().toISOString()} ${note}\n`, 'utf8');
    return { appended: true };
  });

  return impls;
}
