import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBuiltinImpls } from '../src/tools/builtin.js';

// TASK-148 第十一批：docs 工具错误面结构化（EISDIR/ENOTDIR 收口，TASK-144 反方备案 P3-2）。
// 现状（基线 b9b5af9）：docs-read 空串 file / file=目录 → readFileSync(目录) 抛裸 EISDIR；
// docs-list subdir=文件 → readdirSync(文件) 抛裸 ENOTDIR——均绕过结构化 { error } 返回形态。
// 本批：解析后校验 isFile()/isDirectory()，非预期类型 → 结构化 error 返回（不抛异常）。

function buildRepo(): { repoRoot: string; docsRoot: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'wp148-docs-'));
  const docsRoot = path.join(repoRoot, 'docs');
  mkdirSync(path.join(docsRoot, 'sub'), { recursive: true });
  writeFileSync(path.join(docsRoot, 'a.md'), 'hello docs', 'utf8');
  writeFileSync(path.join(docsRoot, 'sub', 'b.md'), 'nested', 'utf8');
  writeFileSync(path.join(repoRoot, 'escape.md'), 'ROOT SECRET', 'utf8'); // docs 外（越界目标）
  return { repoRoot, docsRoot };
}

describe('docs-read 错误面结构化（TASK-148）', () => {
  it('file 为空串 → 解析为 docs 根（目录）→ 结构化 error（不抛 EISDIR）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-read')!({ file: '' });
    expect(typeof (out as Record<string, unknown>).error).toBe('string');
  });

  it('file 非字符串（归一空串）→ 同空串路径 → 结构化 error（不抛 EISDIR）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-read')!({ file: 123 });
    expect(typeof (out as Record<string, unknown>).error).toBe('string');
  });

  it('file 指向目录（sub）→ 结构化 error（不抛 EISDIR）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-read')!({ file: 'sub' });
    expect(typeof (out as Record<string, unknown>).error).toBe('string');
  });

  it('回归：正常文件仍返回 {path,size,content}', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-read')!({ file: 'a.md' })).toEqual({
      path: 'a.md',
      size: 'hello docs'.length,
      content: 'hello docs',
    });
  });

  it('回归：缺失文件仍 {error:"文件不存在或越界"}', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-read')!({ file: 'zz.md' })).toEqual({ error: '文件不存在或越界' });
  });

  it('回归：越界路径（../escape.md）仍拒绝', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-read')!({ file: '../escape.md' })).toEqual({ error: '文件不存在或越界' });
  });
});

describe('docs-list 错误面结构化（TASK-148）', () => {
  it('subdir 指向文件（a.md）→ 结构化 error（不抛 ENOTDIR）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-list')!({ subdir: 'a.md' });
    expect(typeof (out as Record<string, unknown>).error).toBe('string');
  });

  it('subdir 指向子目录内文件（sub/b.md）→ 结构化 error（不抛 ENOTDIR）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const out = impls.get('docs-list')!({ subdir: 'sub/b.md' });
    expect(typeof (out as Record<string, unknown>).error).toBe('string');
  });

  it('回归：根目录与子目录列举正常（dir/file 类型标注）', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    const root = impls.get('docs-list')!({ subdir: '' }) as { entries: { name: string; type: string }[] };
    const byName = Object.fromEntries(root.entries.map((e) => [e.name, e.type]));
    expect(byName['a.md']).toBe('file');
    expect(byName['sub']).toBe('dir');
    const sub = impls.get('docs-list')!({ subdir: 'sub' }) as { entries: { name: string }[] };
    expect(sub.entries.map((e) => e.name)).toEqual(['b.md']);
  });

  it('回归：缺失子目录与越界仍 {error:"目录不存在或越界"}', () => {
    const { repoRoot } = buildRepo();
    const impls = createBuiltinImpls(repoRoot);
    expect(impls.get('docs-list')!({ subdir: 'nope' })).toEqual({ error: '目录不存在或越界' });
    expect(impls.get('docs-list')!({ subdir: '../' })).toEqual({ error: '目录不存在或越界' });
  });
});
