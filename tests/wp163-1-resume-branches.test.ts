import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResumeService } from '../src/portal/resume.js';

// 每日优化第十六批（TASK-163）：src/portal/resume.ts 分支覆盖加固（基线分支 84.09%，
// 未覆盖 73/174/200/211 段）。真实文件系统构造（零 src 改动）：
//  - 73：logs 目录存在非 resume-*.log 形态条目 → cleanupOldLogs 扫描 continue 跳过（不动他人文件）；
//  - 174：spawn 可执行不存在 → child.pid 为 undefined → 登记 pid 回退 -1（spawn 失败不抛、日志留空可查）；
//  - 200/211：dataDir 为相对路径时 readLog 的目录前缀防御归一化校验（path.resolve 后不再以
//    相对前缀开头）→ 候选全部跳过 → 无匹配返回 null——按当前行为钉死（防御性归一化口径）。

function freshDataDir(prefix: string): string {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('wp163 cleanupOldLogs：非匹配形态条目 → 正则 continue 跳过（resume.ts:72-74）', () => {
  it('logs 目录混入无关文件 → 清理不动它，spawn 主流程照常', () => {
    const dataDir = freshDataDir('shanhai-wp163-skip');
    const svc = new ResumeService({ dataDir, repoRoot: process.cwd(), cliEntry: path.resolve('tests/fixtures/resumeChild.mjs') });
    const logsDir = svc.logsDir();
    mkdirSync(logsDir, { recursive: true });
    const foreign = path.join(logsDir, 'wp163-notes.txt'); // 非 resume-*.log 形态
    writeFileSync(foreign, 'keep-me');
    const result = svc.spawnResume('t-skip1', 'portal');
    expect(result.pid).toBeGreaterThanOrEqual(0);
    expect(existsSync(foreign)).toBe(true); // 正则不匹配 → continue（清理只针对 resume-*.log）
  });
});

describe('wp163 spawnResume：可执行不存在 → pid 回退 -1（resume.ts:174-175）', () => {
  it('execPath 指向不存在的可执行 → spawn 异步报 error，登记 pid=-1 且不抛', () => {
    const dataDir = freshDataDir('shanhai-wp163-pid');
    const svc = new ResumeService({
      dataDir,
      repoRoot: process.cwd(),
      execPath: path.join(dataDir, 'no-such-executable.exe'), // 必不存在
      execArgv: [],
    });
    const result = svc.spawnResume('t-pid1', 'portal');
    expect(result.pid).toBe(-1); // child.pid undefined → ?? -1
    expect(path.basename(result.logFile)).toMatch(/^resume-t-pid1-\d+\.log$/);
    expect(existsSync(result.logFile)).toBe(true); // 日志文件已开句柄落盘（留空可查口径）
    // statusOf 登记面同步可查（同一次 spawn 的记录）
    const status = svc.statusOf('t-pid1');
    expect(status).not.toBeNull();
    expect(status!.pid).toBe(-1);
  });
});

describe('wp163 statusOf：非法 taskId → 直接 null 不抛（resume.ts:216-218）', () => {
  it('含非法字符的 taskId（白名单外）→ statusOf 返回 null（区别于 spawn/readLog 的 400 抛错）', () => {
    const dataDir = freshDataDir('shanhai-wp163-st');
    const svc = new ResumeService({ dataDir, repoRoot: process.cwd(), cliEntry: path.resolve('tests/fixtures/resumeChild.mjs') });
    svc.spawnResume('t-st1', 'portal');
    expect(svc.statusOf('t-st1')).not.toBeNull(); // 已登记任务正常可查
    expect(svc.statusOf('../evil/path')).toBeNull(); // 非法形态 → null（查询面不抛、不泄漏登记内容）
  });
});

describe('wp163 readLog：相对 dataDir 的目录前缀防御 → 候选全部跳过返回 null（resume.ts:200/211）', () => {
  it('相对路径 dataDir → path.resolve 归一化后不再匹配相对前缀 → 无候选胜出', () => {
    // 相对形态 dataDir（相对当前工作目录解析——与绝对形态同一 spawn 主流程）
    const relDataDir = `wp163-rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const svc = new ResumeService({
      dataDir: relDataDir,
      repoRoot: process.cwd(),
      cliEntry: path.resolve('tests/fixtures/resumeChild.mjs'),
      execArgv: [],
    });
    try {
      const result = svc.spawnResume('t-rel1', 'portal'); // 真实落盘一个日志文件
      expect(existsSync(result.logFile)).toBe(true);
      // readLog：resolved=path.resolve(绝对) 不以相对 dir+sep 开头 → 前缀校验 continue → best 保持 null
      const hit = svc.readLog('t-rel1');
      expect(hit).toBeNull();
    } finally {
      rmSync(relDataDir, { recursive: true, force: true }); // 清理工作目录下的相对目录
    }
  });
});
