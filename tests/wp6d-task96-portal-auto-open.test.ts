import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  browserMarkerFile,
  buildPortalUrl,
  tokenFromFragment,
  shouldAutoOpenBrowser,
  markBrowserOpened,
  openBrowser,
} from '../src/portal/browser.js';
import { parsePortalArgs } from '../src/portal/server.js';

// TASK-96：门户首启自动拉起默认浏览器并携带 Token URL（免手动粘贴）。
// 契约钉死（对齐批次四 walkthrough 口径）：
//   ① Token 只经 URL fragment 带外注入（D-44 边界不变——不发往服务端、不进日志）；
//   ② 拉起条件 = 新生成 Token 恒拉，或 Token 文件在且 marker 缺失才拉（重复启动不反复拉）；
//   ③ 显式 config/env Token（tokenFile=null）不拉——配置方自持口令，护测试/冒烟/CI 形态；
//   ④ --no-open 逃生口；前端 consumeTokenFragment 与 tokenFromFragment 同源镜像。

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'task96-portal-'));
}

describe('TASK-96 buildPortalUrl（Token 置于 fragment）', () => {
  it('回环形态：Token 在 fragment 中，路径为根', () => {
    expect(buildPortalUrl('127.0.0.1', 7780, 'a'.repeat(64))).toBe(`http://127.0.0.1:7780/#token=${'a'.repeat(64)}`);
  });

  it('localhost / 自定义 host 原样透传', () => {
    expect(buildPortalUrl('localhost', 17891, 'tok')).toBe('http://localhost:17891/#token=tok');
  });

  it('IPv6 字面量主机加方括号；Token 值经 encodeURIComponent', () => {
    expect(buildPortalUrl('::1', 7780, 'tok')).toBe('http://[::1]:7780/#token=tok');
    expect(buildPortalUrl('127.0.0.1', 7780, 'a b&c')).toBe('http://127.0.0.1:7780/#token=a%20b%26c');
  });

  it('URL 的 path?query 部分不含 Token（fragment 之前无秘密）', () => {
    const url = new URL(buildPortalUrl('127.0.0.1', 7780, 'secret-tok'));
    expect(`${url.pathname}${url.search}`).toBe('/');
    expect(url.hash).toBe('#token=secret-tok');
  });
});

describe('TASK-96 tokenFromFragment（与 app.js consumeTokenFragment 同源镜像）', () => {
  it('#token=<value> → value；其余形态 null', () => {
    expect(tokenFromFragment('#token=abc')).toBe('abc');
    expect(tokenFromFragment('#token=')).toBeNull();
    expect(tokenFromFragment('#/tasks')).toBeNull();
    expect(tokenFromFragment('')).toBeNull();
    expect(tokenFromFragment('#/tasks?token=x')).toBeNull();
  });

  it('镜像契约：public/app.js 内含同源消费逻辑（防漂移钉死）', () => {
    const appJs = readFileSync(path.resolve(process.cwd(), 'src', 'portal', 'public', 'app.js'), 'utf8');
    expect(appJs).toContain('consumeTokenFragment');
    expect(appJs).toContain('/^#token=(.+)$/.exec(location.hash)');
    // 第七阶段 7-1 起产物经 esbuild 打包：引号被打印器归一为双引号（语义不变，随批迁移引号形态）
    expect(appJs).toContain('history.replaceState(null, "", location.pathname + location.search)');
  });
});

describe('TASK-96 shouldAutoOpenBrowser（拉起决策 + marker 幂等）', () => {
  it('新生成 Token 恒拉起（即使 marker 已在——新口令需送达）', () => {
    const dataDir = tempDataDir();
    mkdirSync(path.join(dataDir, 'portal'), { recursive: true });
    markBrowserOpened(dataDir);
    expect(shouldAutoOpenBrowser({ tokenGenerated: true, tokenFile: path.join(dataDir, 'portal', 'token'), dataDir })).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('Token 文件在 + marker 缺失 → 拉；markBrowserOpened 后 → 不再拉（重复启动不反复拉）', () => {
    const dataDir = tempDataDir();
    const tokenFile = path.join(dataDir, 'portal', 'token');
    expect(shouldAutoOpenBrowser({ tokenGenerated: false, tokenFile, dataDir })).toBe(true);
    const marker = markBrowserOpened(dataDir);
    expect(marker).toBe(browserMarkerFile(dataDir));
    expect(readFileSync(marker, 'utf8')).not.toContain('token'); // marker 内容不含 Token（时间戳）
    expect(shouldAutoOpenBrowser({ tokenGenerated: false, tokenFile, dataDir })).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('显式 config/env Token（tokenFile=null）不拉——护测试/冒烟/CI 形态', () => {
    const dataDir = tempDataDir();
    expect(shouldAutoOpenBrowser({ tokenGenerated: false, tokenFile: null, dataDir })).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('TASK-96 openBrowser（跨平台拉起，注入 spawn 断言命令形态）', () => {
  it('win32 → cmd /c start "" <url>（start 首参为窗口标题占位）', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const opened = openBrowser('http://127.0.0.1:7780/#token=t', {
      platform: 'win32',
      spawnFn: (command, args) => {
        calls.push({ command, args });
      },
    });
    expect(opened).toBe(true);
    expect(calls).toEqual([{ command: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:7780/#token=t'] }]);
  });

  it('darwin → open <url>；linux → xdg-open <url>', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    openBrowser('u1', { platform: 'darwin', spawnFn: (command, args) => calls.push({ command, args }) });
    openBrowser('u2', { platform: 'linux', spawnFn: (command, args) => calls.push({ command, args }) });
    expect(calls).toEqual([
      { command: 'open', args: ['u1'] },
      { command: 'xdg-open', args: ['u2'] },
    ]);
  });

  it('spawn 抛出 → 返回 false（尽力而为，由 CLI 提示 --no-open）', () => {
    expect(openBrowser('u', { platform: 'linux', spawnFn: () => { throw new Error('ENOENT'); } })).toBe(false);
  });
});

describe('TASK-96 parsePortalArgs（--no-open 逃生口）', () => {
  it('缺省不设 open（自动拉起开启）；--no-open → open:false；可与 --port/--host 组合', () => {
    expect(parsePortalArgs([])).toEqual({});
    expect(parsePortalArgs(['--no-open'])).toEqual({ open: false });
    expect(parsePortalArgs(['--port', '7781', '--no-open'])).toEqual({ port: 7781, open: false });
    expect(parsePortalArgs(['--host', '0.0.0.0', '--port', '8080', '--no-open'])).toEqual({ host: '0.0.0.0', port: 8080, open: false });
  });
});
