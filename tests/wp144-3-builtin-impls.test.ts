import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuiltinImpls } from '../src/tools/builtin.js';
import { fakeSecret } from './helpers.js';

// TASK-144 第十批：builtin 工具真实行为路径补强。
// 基线（main @ 82192c8）未覆盖段 → 本文件用例映射：
//   124-128      → docs-read impl 全路径（存在/缺失/越界/非字符串 file/32KB 截断）
//   108 分支     → safeResolve 边界（rel='' → 根自身 → 越界拒绝）
//   117 分支     → docs-list：subdir 非字符串 → 根目录
//   119-120 分支 → docs-list：目录缺失 → 错误；正常列举（dir/file 类型）
//   134 分支     → note-append：note 非字符串 → 空串（过脱敏管道后追加）

function buildRepo(): { repoRoot: string; docsRoot: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'wp144-builtin-'));
  const docsRoot = path.join(repoRoot, 'docs');
  mkdirSync(path.join(docsRoot, 'sub'), { recursive: true });
  writeFileSync(path.join(docsRoot, 'a.md'), 'hello docs', 'utf8');
  writeFileSync(path.join(docsRoot, 'sub', 'b.md'), 'nested', 'utf8');
  writeFileSync(path.join(docsRoot, 'big.txt'), 'x'.repeat(33000), 'utf8');
  writeFileSync(path.join(repoRoot, 'escape.md'), 'ROOT SECRET', 'utf8'); // docs 外（越界目标）
  return { repoRoot, docsRoot };
}

describe('docs-read（124-128）', () => {
  it('存在文件 → {path,size,content}', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-read')!({ file: 'a.md' }) as Record<string, unknown>;
    expect(out).toEqual({ path: 'a.md', size: 'hello docs'.length, content: 'hello docs' });
  });

  it('子目录相对路径 → 内容读取（正斜杠与平台分隔符均由 path.resolve 归一）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-read')!({ file: 'sub/b.md' }) as Record<string, unknown>;
    expect(out.content).toBe('nested');
  });

  it('缺失文件 → {error:"文件不存在或越界"}', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-read')!({ file: 'zz.md' })).toEqual({ error: '文件不存在或越界' });
  });

  it('越界路径（../escape.md）→ 拒绝（不读 docs 外内容）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-read')!({ file: '../escape.md' })).toEqual({ error: '文件不存在或越界' });
  });

  it('file 为空串 → 解析为 docs 根自身（目录）→ 目录读取报错（108 边界分支现状钉死；见交付记录）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(() => impls.get('docs-read')!({ file: '' })).toThrow(/EISDIR/);
  });

  it('file 非字符串 → 空串同路径（124 分支）→ 目录读取报错', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(() => impls.get('docs-read')!({ file: 123 })).toThrow(/EISDIR/);
  });

  it('>32KB 文件 → 32KB 截断 + 截断标记（128 分支）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-read')!({ file: 'big.txt' }) as { size: number; content: string };
    expect(out.size).toBe(33000); // 原始长度
    expect(out.content.length).toBe(32768 + '…[截断]'.length);
    expect(out.content.endsWith('…[截断]')).toBe(true);
  });
});

describe('docs-list（117 / 119-120 分支）', () => {
  it('根目录 → dir/file 类型标注齐全', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-list')!({ subdir: '' }) as { entries: { name: string; type: string }[] };
    const byName = Object.fromEntries(out.entries.map((e) => [e.name, e.type]));
    expect(byName['a.md']).toBe('file');
    expect(byName['sub']).toBe('dir');
    expect(byName['big.txt']).toBe('file');
  });

  it('子目录 → 仅子目录内容', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-list')!({ subdir: 'sub' }) as { entries: { name: string }[] };
    expect(out.entries.map((e) => e.name)).toEqual(['b.md']);
  });

  it('缺失子目录 → {error:"目录不存在或越界"}（119 分支）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-list')!({ subdir: 'nope' })).toEqual({ error: '目录不存在或越界' });
  });

  it('subdir 非字符串 → 根目录列举（117 分支）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-list')!({ subdir: 42 }) as { entries: { name: string }[] };
    expect(out.entries.some((e) => e.name === 'a.md')).toBe(true);
  });

  it('subdir 越界（../）→ 拒绝', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-list')!({ subdir: '../' })).toEqual({ error: '目录不存在或越界' });
  });
});

describe('note-append（134 分支 + 脱敏管道）', () => {
  it('追加笔记 → data/notes.md 落盘（时间戳行格式）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('note-append')!({ note: '第一条笔记' });
    expect(out).toEqual({ appended: true });
    const line = readFileSync(path.join(repoRoot, 'data', 'notes.md'), 'utf8');
    expect(line).toMatch(/^- \d{4}-\d{2}-\d{2}T.* 第一条笔记\n$/);
  });

  it('含密钥样例的笔记 → 写入前过脱敏管道（密钥不落盘）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const secret = fakeSecret();
    impls.get('note-append')!({ note: `看到密钥 ${secret} 了` });
    const content = readFileSync(path.join(repoRoot, 'data', 'notes.md'), 'utf8');
    expect(content).not.toContain(secret); // 密钥样例被替换
    expect(content).toContain('[REDACTED:'); // 脱敏标记形态
  });

  it('note 非字符串 → 空笔记仍追加（134 分支）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('note-append')!({ note: null })).toEqual({ appended: true });
    expect(existsSync(path.join(repoRoot, 'data', 'notes.md'))).toBe(true);
  });
});
