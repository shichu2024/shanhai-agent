import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResumeService } from '../src/portal/resume.js';

// 每日优化第十二批（TASK-151）：resume.ts 分支覆盖加固（基线分支 79.06%，未覆盖 78-79/208-209
// = cleanupOldLogs 与 readLog 扫描循环中的竞态/权限 catch「跳过该候选」）。
// 真实文件系统构造（不改 src/）：
//  - 78-79：logs 目录下预置一个形态匹配 resume-*.log 的【目录】且 mtime 超过 7 天保留期
//    —— statSync 成功、unlinkSync(目录) 在 Windows 抛 EPERM（POSIX 抛 EISDIR）→ catch 跳过，
//    resume 主流程不受阻；
//  - 208-209：预置一个【悬空 junction/symlink】（名字匹配 resume-<taskId>-<ns>.log，目标不存在）
//    —— readLog 扫描时 statSync 跟随链接抛 ENOENT → catch 跳过，仍返回真实日志文件。

const DAY_MS = 24 * 60 * 60 * 1000;

function freshDataDir(prefix: string): string {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('wp151 cleanupOldLogs 竞态分支：超龄目录候选删除失败 → 跳过不阻塞 resume（resume.ts:75-80）', () => {
  it('形态匹配但为目录的候选（unlink 失败）→ catch 跳过；spawn 主流程照常成功', () => {
    const dataDir = freshDataDir('shanhai-wp151-clean');
    const svc = new ResumeService({ dataDir, repoRoot: process.cwd(), cliEntry: path.resolve('tests/fixtures/resumeChild.mjs') });
    const logsDir = svc.logsDir();
    mkdirSync(logsDir, { recursive: true });
    const staleDir = path.join(logsDir, 'resume-stale-1.log'); // 形态匹配 + 目录（删除必失败）
    mkdirSync(staleDir);
    const old = new Date(Date.now() - (8 * DAY_MS)); // 超过 7 天保留期
    utimesSync(staleDir, old, old);
    const result = svc.spawnResume('t-ok1', 'portal');
    expect(result.pid).toBeGreaterThanOrEqual(0); // spawn 未被清理失败阻塞
    expect(path.basename(result.logFile)).toMatch(/^resume-t-ok1-\d+\.log$/);
    expect(existsSync(staleDir)).toBe(true); // 删除失败被跳过（尽力而为口径）
  });
});

describe('wp151 readLog 竞态分支：悬空链接候选 stat 失败 → 跳过仍返回真实日志（resume.ts:201-209）', () => {
  it.runIf(process.platform === 'win32' || process.platform === 'linux')(
    '悬空 junction/symlink 形态匹配 → statSync ENOENT catch 跳过；真实文件按 mtime 胜出',
    () => {
      const dataDir = freshDataDir('shanhai-wp151-read');
      const svc = new ResumeService({ dataDir, repoRoot: process.cwd() });
      const logsDir = svc.logsDir();
      mkdirSync(logsDir, { recursive: true });
      // 悬空链接（目标不存在）：win32 用 junction（免特权），POSIX 用普通 file 符号链接
      const dangling = path.join(logsDir, 'resume-t-race-1.log');
      const target = path.join(logsDir, 'no-such-target-dir');
      if (process.platform === 'win32') symlinkSync(target, dangling, 'junction');
      else symlinkSync(target, dangling, 'file');
      // 真实日志（mtime 更新 → 胜出）
      const real = path.join(logsDir, 'resume-t-race-2.log');
      writeFileSync(real, 'hello-race-log');
      const hit = svc.readLog('t-race');
      expect(hit).not.toBeNull();
      expect(path.basename(hit!.logFile)).toBe('resume-t-race-2.log');
      expect(hit!.content).toBe('hello-race-log');
      expect(hit!.truncated).toBe(false);
    },
  );
});
