import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ResumeService,
  buildResumeSpawnArgs,
  RESUME_LOG_MAX_AGE_DAYS,
  RESUME_LOG_MAX_READ_BYTES,
} from '../src/portal/resume.js';

// WP-6B 批次四（6-4/4）：P3 收口（裁决=修改类）。
// P3-1：resume 日志 7 天惰性清理（spawn 触发；读路径零副作用）+ readLog 读取上限（超限截断并标注）。
// P3-①：resume spawn 参数构造单一导出（execArgv 透传先例），CLI approve 前台 spawn 复用同一构造。

const DAY_MS = 24 * 60 * 60 * 1000;

function logsDirOf(dataDir: string): string {
  return path.join(dataDir, 'portal', 'logs');
}

function makeSvc(dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-b4-'))): { svc: ResumeService; dataDir: string } {
  return { svc: new ResumeService({ dataDir, repoRoot: process.cwd() }), dataDir };
}

// ---------- P3-1：7 天惰性清理 ----------

describe('WP6B4-1 resume 日志 7 天惰性清理（spawn 触发；readLog 零副作用）', () => {
  it('spawnResume 触发清理：>7 天旧日志删除，7 天内与最新保留', () => {
    const { svc, dataDir } = makeSvc();
    const dir = logsDirOf(dataDir);
    mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'resume-t-old-1.log');
    const edge = path.join(dir, 'resume-t-edge-2.log');
    const fresh = path.join(dir, 'resume-t-fresh-3.log');
    writeFileSync(old, 'old');
    writeFileSync(edge, 'edge');
    writeFileSync(fresh, 'fresh');
    const now = Date.now();
    utimesSync(old, new Date(now - (RESUME_LOG_MAX_AGE_DAYS + 1) * DAY_MS), new Date(now - (RESUME_LOG_MAX_AGE_DAYS + 1) * DAY_MS));
    utimesSync(edge, new Date(now - (RESUME_LOG_MAX_AGE_DAYS - 1) * DAY_MS), new Date(now - (RESUME_LOG_MAX_AGE_DAYS - 1) * DAY_MS));

    svc.spawnResume('t-new', 'portal'); // spawn 路径惰性清理（无定时器，D-42 零后台定时器纪律）

    expect(existsSync(old)).toBe(false); // 超龄删除
    expect(existsSync(edge)).toBe(true); // 7 天内保留（边界：6 天）
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith('resume-t-new-'))).toBe(true);
  });

  it('readLog 不触发清理（读路径零副作用）；空目录/不存在目录 spawn 正常', () => {
    const { svc, dataDir } = makeSvc();
    const dir = logsDirOf(dataDir);
    mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'resume-t-ro-1.log');
    writeFileSync(old, 'stale');
    const stale = Date.now() - (RESUME_LOG_MAX_AGE_DAYS + 2) * DAY_MS;
    utimesSync(old, new Date(stale), new Date(stale));

    expect(svc.readLog('t-ro')!.content).toBe('stale');
    expect(existsSync(old)).toBe(true); // 读取不删除

    const { svc: svc2 } = makeSvc(); // logs 目录不存在 → spawn 创建并正常
    svc2.spawnResume('t-nodir', 'portal');
    expect(svc2.readLog('t-nodir')).not.toBeNull();
  });
});

// ---------- P3-1：readLog 读取上限 ----------

describe('WP6B4-2 readLog 读取上限（超限截断并标注；尾部保留）', () => {
  it('超上限日志：只读末尾 RESUME_LOG_MAX_READ_BYTES 字节 + 标注前缀 + truncated 标记', () => {
    const { svc, dataDir } = makeSvc();
    const dir = logsDirOf(dataDir);
    mkdirSync(dir, { recursive: true });
    const tail = `TAIL-MARK${'x'.repeat(1024)}`;
    const head = `HEAD-START${'H'.repeat(RESUME_LOG_MAX_READ_BYTES * 2)}`; // 远超上限的头部 → 头部起点必然被截去
    writeFileSync(path.join(dir, 'resume-t-big-1.log'), head + tail);

    const log = svc.readLog('t-big')!;
    expect(log.truncated).toBe(true);
    expect(log.content.startsWith('[')).toBe(true); // 标注行打头
    expect(log.content).toContain('TAIL-MARK'); // 尾部保留
    expect(log.content).not.toContain('HEAD-START'); // 头部起点被截去
    expect(Buffer.byteLength(log.content, 'utf8')).toBeGreaterThan(RESUME_LOG_MAX_READ_BYTES); // 正文=上限字节+标注行
  });

  it('未超限日志：全文返回 + truncated=false（字节级边界：恰好等于上限不截断）', () => {
    const { svc, dataDir } = makeSvc();
    const dir = logsDirOf(dataDir);
    mkdirSync(dir, { recursive: true });
    const exact = 'E'.repeat(RESUME_LOG_MAX_READ_BYTES);
    writeFileSync(path.join(dir, 'resume-t-exact-1.log'), exact);
    const log = svc.readLog('t-exact')!;
    expect(log.truncated).toBe(false);
    expect(log.content).toBe(exact); // 全文、零标注
  });
});

// ---------- P3-①：spawn 参数单一构造（CLI approve 复用；execArgv 透传先例固化） ----------

describe('WP6B4-3 buildResumeSpawnArgs（spawn 参数单一导出，execArgv 透传先例）', () => {
  it('参数序 = [...execArgv, cliEntry, task run --resume ... --resumed-by ... --by ...]', () => {
    const args = buildResumeSpawnArgs('t-1', 'approve-spawn', 'ops', {
      cliEntry: 'D:/repo/dist/cli.js',
      execArgv: ['--require', 'preflight.cjs', '--import', 'loader.mjs'],
    });
    expect(args).toEqual([
      '--require', 'preflight.cjs', '--import', 'loader.mjs', // 装载旗标前置（开发态 tsx 形态前提）
      'D:/repo/dist/cli.js',
      'task', 'run', '--resume', 't-1', '--resumed-by', 'approve-spawn', '--by', 'ops',
    ]);
  });

  it('execArgv 缺省空数组（dist 形态行为不变）；cliEntry 缺省 defaultCliEntry()', () => {
    const args = buildResumeSpawnArgs('t-2', 'manual-resume', 'portal', { cliEntry: 'cli.js' });
    expect(args).toEqual(['cli.js', 'task', 'run', '--resume', 't-2', '--resumed-by', 'manual-resume', '--by', 'portal']);
    const defaulted = buildResumeSpawnArgs('t-3', 'manual-resume', 'p', {});
    expect(defaulted[0]).toBe(path.resolve(process.argv[1] ?? 'dist/cli.js'));
    expect(defaulted).toEqual([
      path.resolve(process.argv[1] ?? 'dist/cli.js'),
      'task', 'run', '--resume', 't-3', '--resumed-by', 'manual-resume', '--by', 'p',
    ]);
  });
});
