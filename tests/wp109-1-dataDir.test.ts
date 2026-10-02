import { describe, expect, it } from 'vitest';
import { parsePortalArgs, resolvePortalDataDir } from '../src/portal/server.js';
import path from 'node:path';

// TASK-109（每日优化第一批·第一项）：门户 CLI --dataDir 契约测试。
// 备案缺陷：旗标被静默忽略（仅认 SHANHAI_DATA_DIR env，原 cli.ts:25）。
// 契约：旗标形态 / env 形态各自生效；冲突时旗标 > env > 缺省 <repo>/data。

describe('TASK-109 parsePortalArgs --dataDir（旗标解析）', () => {
  it('缺省：无旗标无 dataDir 键（既有行为不变）', () => {
    expect(parsePortalArgs([])).toEqual({});
  });

  it('旗标形态：--dataDir <dir> 解析为 dataDir', () => {
    expect(parsePortalArgs(['--dataDir', '/tmp/seed-a'])).toEqual({ dataDir: '/tmp/seed-a' });
  });

  it('与其他旗标组合解析互不干扰', () => {
    expect(parsePortalArgs(['--port', '7781', '--host', '0.0.0.0', '--dataDir', '/tmp/seed-b', '--no-open'])).toEqual({
      port: 7781,
      host: '0.0.0.0',
      dataDir: '/tmp/seed-b',
      open: false,
    });
  });

  it('非法值 fail-fast：--dataDir 缺值/空串拒绝（不静默）', () => {
    expect(() => parsePortalArgs(['--dataDir'])).toThrow(/--dataDir 不能为空/);
    expect(() => parsePortalArgs(['--dataDir', ''])).toThrow(/--dataDir 不能为空/);
  });
});

describe('TASK-109 resolvePortalDataDir（旗标 / env / 缺省与优先级）', () => {
  const repoRoot = process.cwd();
  const envOf = (v?: string) => (v === undefined ? {} : { SHANHAI_DATA_DIR: v });

  it('旗标形态：仅旗标 → 用旗标值', () => {
    expect(resolvePortalDataDir('/tmp/flag-dir', envOf('/tmp/env-dir'), repoRoot)).toBe('/tmp/flag-dir');
  });

  it('env 形态：仅 SHANHAI_DATA_DIR → 用 env 值', () => {
    expect(resolvePortalDataDir(undefined, envOf('/tmp/env-dir'), repoRoot)).toBe('/tmp/env-dir');
  });

  it('冲突优先级：旗标 > env（显式输入压倒环境缺省）', () => {
    expect(resolvePortalDataDir('/tmp/flag-wins', envOf('/tmp/env-loses'), repoRoot)).toBe('/tmp/flag-wins');
  });

  it('缺省：两者皆无 → <repo>/data', () => {
    expect(resolvePortalDataDir(undefined, envOf(undefined), repoRoot)).toBe(path.join(repoRoot, 'data'));
  });

  it('env 空串视为未设置（与 SHANHAI_PORTAL_PORT 口径一致）', () => {
    expect(resolvePortalDataDir(undefined, envOf(''), repoRoot)).toBe(path.join(repoRoot, 'data'));
  });
});
