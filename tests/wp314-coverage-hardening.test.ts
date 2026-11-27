import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResumeService } from '../src/portal/resume.js';
import { openBrowser } from '../src/portal/browser.js';
import { startPortalServer, stopPortalServer, type PortalHandle } from '../src/portal/server.js';
import { scanForRelease, DEFAULT_SCAN_CONFIG } from '../src/scripts/releaseScan.js';
import { makeHarness, registerAndRelease, sampleSpec, validInput } from './helpers.js';

// 每日优化第六十五批（TASK-314 · 覆盖蓄量第四度）：纯测试加固，零 src 改动。
// 目标池 = TASK-283 归类为「TOCTOU / 真实子进程」的 4 条未覆盖语句（基线 beaaa1a 实测 4899/4929），
// 逐条以「fs / child_process 局部 mock + 真实 socket」确定性触达，不 sleep 赌时序、不真实拉起浏览器：
//  - resume.ts:70      mkdirSync 之后 existsSync(dir) 为假 → cleanupOldLogs 早返回（超龄日志不被清理）；
//  - releaseScan.ts:264 stat 尺寸 ≥10、随后实读不足 9 字节 → isSafetensors false（不抛、不误报）；
//  - browser.ts:48     不注入 spawnFn 的缺省实现（detached + stdio ignore + unref）——spawn 被 mock 替身接管；
//  - server.ts:273     响应头已发出后响应体序列化失败 → res.end() 收尾（空体、不悬挂、服务继续可用）。
// node:fs / node:child_process 以 importOriginal 部分 mock（透传实现）装载，仅目标用例在 try/finally 内
// 窄化到目标路径/目标调用，其余时间与真实模块行为逐位一致。

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), statSync: vi.fn(actual.statSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = 'test-token-0000000000000000000000000000';
const samePath = (a: string, b: fs.PathLike): boolean => path.resolve(String(b)) === path.resolve(a);

// ---------- resume.ts:70：mkdirSync 后目录「消失」的 TOCTOU 窗口 ----------

describe('wp314 resume：mkdirSync 之后 existsSync(dir) 为假 → cleanupOldLogs 早返回', () => {
  it('窗口内超龄日志不被清理、spawn 主流程照常；窗口关闭后再次 spawn 同一超龄日志被回收（对照）', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-wp314-resume-'));
    const svc = new ResumeService({ dataDir, repoRoot: process.cwd(), cliEntry: path.resolve('tests/fixtures/resumeChild.mjs') });
    const logsDir = svc.logsDir();
    mkdirSync(logsDir, { recursive: true });
    const stale = path.join(logsDir, 'resume-stale-314.log'); // 形态匹配 + 超龄（8 天 > 7 天保留期）
    writeFileSync(stale, 'stale-log');
    const old = new Date(Date.now() - 8 * DAY_MS);
    utimesSync(stale, old, old);

    const existsMock = vi.mocked(fs.existsSync);
    const passThrough = existsMock.getMockImplementation()!;
    // 仅把 logsDir 这一个路径判为「不存在」（mkdirSync 之后、existsSync 之前的竞态窗口）
    existsMock.mockImplementation((p) => (samePath(logsDir, p) ? false : passThrough(p)));
    try {
      const result = svc.spawnResume('t-314a', 'portal');
      expect(result.pid).toBeGreaterThanOrEqual(0); // 早返回不阻塞 spawn 主流程
      expect(path.basename(result.logFile)).toMatch(/^resume-t-314a-\d+\.log$/);
      expect(existsMock.mock.calls.some(([p]) => samePath(logsDir, p))).toBe(true); // 确实到达了 cleanupOldLogs 的 existsSync
      expect(passThrough(stale)).toBe(true); // 行 70 早返回：超龄日志原样保留（真实 fs 口径）
    } finally {
      existsMock.mockImplementation(passThrough);
    }

    // 对照：窗口关闭（existsSync 透传）后同一目录再次 spawn → 超龄日志被惰性回收，
    // 证明上一步的「保留」源于 existsSync 早返回，而非清理逻辑本身失效
    svc.spawnResume('t-314b', 'portal');
    expect(passThrough(stale)).toBe(false);
  });
});

// ---------- releaseScan.ts:264：stat 与 read 之间文件缩短 ----------

describe('wp314 releaseScan：safetensors 嗅探 stat/read 窗口（尺寸 ≥10、实读不足 9 字节）', () => {
  it('isSafetensors 返回 false：不抛、不误报 model_weight，嗅探链继续走二进制探测 + 文本扫描', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'shanhai-wp314-scan-'));
    const target = path.join(root, 'weights-snippet.dat'); // 非权重扩展名、无魔数 → 进入 safetensors 嗅探
    writeFileSync(target, Buffer.from([0x00, 0x01, 0x02])); // 实际仅 3 字节

    const statMock = vi.mocked(fs.statSync);
    const passThrough = statMock.getMockImplementation()!;
    // 仅目标文件的 stat 尺寸伪报为 64（模拟 stat 之后、read 之前文件被截短）
    statMock.mockImplementation(((p: fs.PathLike) => {
      const st = passThrough(p);
      return samePath(target, p) ? { ...st, size: 64 } : st;
    }) as unknown as typeof fs.statSync);
    try {
      const findings = scanForRelease(root, DEFAULT_SCAN_CONFIG);
      expect(findings).toEqual([]); // 行 264 false：无「safetensors 结构嗅探命中」；3 字节无 NUL → 文本扫描零命中
      expect(statMock.mock.calls.some(([p]) => samePath(target, p))).toBe(true); // 确实到达了 isSafetensors 的 stat
    } finally {
      statMock.mockImplementation(passThrough);
    }
  });
});

// ---------- browser.ts:48：缺省 spawnFn 实现 ----------

describe('wp314 browser：不注入 spawnFn 的缺省拉起实现', () => {
  it('缺省实现以 detached + stdio ignore 调用 spawn 并 unref；spawn 由 mock 替身接管，不真实拉起浏览器', () => {
    const spawnMock = vi.mocked(childProcess.spawn);
    const passThrough = spawnMock.getMockImplementation()!;
    const fakeChild = { unref: vi.fn() };
    const calls: unknown[][] = [];
    spawnMock.mockImplementation(((...args: unknown[]) => {
      calls.push(args);
      return fakeChild;
    }) as unknown as typeof childProcess.spawn);
    try {
      const url = 'http://127.0.0.1:7780/#token=t314';
      expect(openBrowser(url, { platform: 'win32' })).toBe(true);
      expect(openBrowser(url, { platform: 'linux' })).toBe(true);
    } finally {
      spawnMock.mockImplementation(passThrough);
    }
    expect(calls).toEqual([
      ['cmd', ['/c', 'start', '', 'http://127.0.0.1:7780/#token=t314'], { detached: true, stdio: 'ignore' }],
      ['xdg-open', ['http://127.0.0.1:7780/#token=t314'], { detached: true, stdio: 'ignore' }],
    ]);
    expect(fakeChild.unref).toHaveBeenCalledTimes(2); // 门户不收养浏览器进程
  });
});

// ---------- server.ts:273：响应头已发出后 handleRequest 抛错 ----------

function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

describe('wp314 portal server：响应头已发出后响应体序列化失败', () => {
  it('headersSent 后 handleRequest 抛错 → res.end() 收尾：空体 200、连接不悬挂、无未处理拒绝、服务继续可用', { timeout: 20_000 }, async () => {
    const h = makeHarness([]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'events-deep-314' }));
    const taskId = h.rt.tasks.createTask('events-deep-314', validInput, 't');
    // 夹具：向该任务的 trace JSONL 追加一条 payload 深层嵌套的事件（JSON.parse 可迭代解析；JSON.stringify 递归溢出）。
    // GET /api/tasks/:id/events = readEvents 原样返回解析后的信封 → 响应体携带该值 → sendJson 在 writeHead 之后序列化失败。
    const DEPTH = 20_000;
    const deep = '['.repeat(DEPTH) + ']'.repeat(DEPTH);
    const envelope = JSON.stringify({
      eventId: 'wp314-deep', taskId, agentId: 'events-deep-314', agentVersionId: 'v', specContentHash: 'h',
      eventType: 'wp314.deep', timestamp: '2026-11-28T00:00:00.000Z', payload: '__WP314_DEEP__',
    }).replace('"__WP314_DEEP__"', deep);
    appendFileSync(h.rt.trace.traceFile(taskId), envelope + '\n', 'utf8');

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    const handle: PortalHandle = await startPortalServer(h.rt, {
      dataDir: mkdtempSync(path.join(tmpdir(), 'shanhai-wp314-srv-')),
      repoRoot: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
    try {
      const failed = await get(handle.port, `/api/tasks/${taskId}/events`);
      expect(failed.status).toBe(200); // 头已随 writeHead 发出（状态码已定）
      expect(failed.body).toBe(''); // 行 273 res.end()：空体收尾，连接正常结束而非悬挂
      // 服务仍可用：同一任务的其余读面照常应答
      const after = await get(handle.port, `/api/tasks/${taskId}`);
      expect(after.status).toBe(200);
      expect((JSON.parse(after.body) as { taskId: string }).taskId).toBe(taskId);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await stopPortalServer(handle);
    }
  });
});
