import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { PORTAL_BUILD_OPTIONS } from '../scripts/build-portal-options.mjs';

// 第七阶段批次一（7-1/4）：产物新鲜度契约测试（设计 V0.3 §9.3 条件③，本批硬 DoD）——
// 测试进程内运行 esbuild 构建（write:false，不落盘），与入库产物逐字节比对，防源码与产物漂移。
// 构建选项与 scripts/build-portal.mjs 共享同一模块（scripts/build-portal-options.mjs），选项漂移即本测试失败。

describe('7-1 产物新鲜度契约（方案 A 条件③）', () => {
  it('进程内重构建与入库产物逐字节一致（app.js + style.css）', async () => {
    const result = await build({ ...PORTAL_BUILD_OPTIONS, write: false });
    const byName = new Map(result.outputFiles.map((f) => [path.basename(f.path), f]));
    expect(byName.size).toBe(2);
    for (const name of ['app.js', 'style.css']) {
      const out = byName.get(name);
      expect(out, `构建输出缺少 ${name}`).toBeDefined();
      const committed = readFileSync(path.resolve('src', 'portal', 'public', name));
      expect(
        Buffer.compare(Buffer.from(out!.contents), committed),
        `${name} 与源码构建产物不一致——请运行 npm run build:portal 并提交产物`,
      ).toBe(0);
    }
  });

  it('产物为单文件 IIFE（bundle 无外部 import/require）', async () => {
    const appJs = readFileSync(path.resolve('src', 'portal', 'public', 'app.js'), 'utf8');
    expect(appJs).toMatch(/^\s*("use strict";\s*)?\(/); // IIFE 包裹（"use strict" 前导）
    expect(appJs).not.toMatch(/^\s*import\s/m);
    expect(appJs).not.toMatch(/\brequire\(/);
  });

  it('镜像契约（TASK-96）：app.js 内含 fragment 消费同源逻辑（防漂移钉死）', () => {
    const appJs = readFileSync(path.resolve('src', 'portal', 'public', 'app.js'), 'utf8');
    expect(appJs).toContain('consumeTokenFragment');
    expect(appJs).toContain('/^#token=(.+)$/.exec(location.hash)');
    expect(appJs).toContain('history.replaceState(null, "", location.pathname + location.search)');
  });

  it('产物与源码零占位神兽（§12-8 硬 DoD：麒麟/朱雀/九尾狐/饕餮）', () => {
    for (const name of ['app.js', 'style.css']) {
      const text = readFileSync(path.resolve('src', 'portal', 'public', name), 'utf8');
      expect(text).not.toMatch(/麒麟|朱雀|九尾狐|饕餮/);
    }
  });
});
