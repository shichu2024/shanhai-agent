import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePortalArgs, printablePortalUrl } from '../src/portal/server.js';
import { readPortalToken } from '../src/portal/auth.js';

// TASK-113（每日优化第三批）：门户 Token 再取 UX——`shanhai portal --print-url`
// 按需输出 http://<host>:<port>/#token=<token> 后直接退出。契约：
// ① 旗标解析（布尔旗标，可与 --port/--host/--dataDir 组合）；
// ② host/port 口径与 runPortal/startPortalServer 一致（旗标 > config > env 端口 > 缺省 127.0.0.1:7780）；
// ③ Token 只读解析（config > env > token 文件），绝不生成、绝不落盘（与 resolvePortalToken 的关键差异）；
// ④ 无 Token（从未首启）明确报错并指引先运行 `shanhai portal`；
// ⑤ 缺省路径（不带 --print-url）绝不打印带 Token 的 URL（防终端日志意外留 Token）。

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'wp113-'));
}

const TOK = 'a'.repeat(64); // 形同 randomBytes(32).hex 的假口令（非真实凭据）

function seedTokenFile(dataDir: string, token = TOK): string {
  const file = path.join(dataDir, 'portal', 'token');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, token);
  return file;
}

describe('TASK-113 parsePortalArgs（--print-url 布尔旗标）', () => {
  it('--print-url → printUrl:true；缺省不设（缺省路径不触发 URL 打印）', () => {
    expect(parsePortalArgs(['--print-url'])).toEqual({ printUrl: true });
    expect(parsePortalArgs([])).toEqual({});
    expect(parsePortalArgs(['--no-open'])).toEqual({ open: false });
  });

  it('可与 --port/--host/--dataDir 组合', () => {
    expect(
      parsePortalArgs(['--port', '7790', '--host', 'localhost', '--dataDir', 'D:\\tmp\\d', '--print-url']),
    ).toEqual({ port: 7790, host: 'localhost', dataDir: 'D:\\tmp\\d', printUrl: true });
  });

  it('与值旗标守卫共存：吞旗标形态仍 fail-fast', () => {
    expect(() => parsePortalArgs(['--print-url', '--host', '--no-open'])).toThrow(/--host/);
  });
});

describe('TASK-113 readPortalToken（只读解析：零副作用）', () => {
  it('解析序：config > env > token 文件（与 resolvePortalToken 同序）', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir, 'f'.repeat(64));
    expect(readPortalToken(dataDir, 'c'.repeat(64))!.token).toBe('c'.repeat(64));
    expect(readPortalToken(dataDir, 'c'.repeat(64))!.tokenFile).toBeNull();
    expect(readPortalToken(dataDir, undefined, 'e'.repeat(64))!.token).toBe('e'.repeat(64));
    expect(readPortalToken(dataDir)!.token).toBe('f'.repeat(64));
    expect(readPortalToken(dataDir)!.tokenFile).toBe(path.join(dataDir, 'portal', 'token'));
  });

  it('token 文件空白形态（存在但空）→ null；空串 config/env 视为未设置', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir, '   ');
    expect(readPortalToken(dataDir)).toBeNull();
    expect(readPortalToken(dataDir, '')).toBeNull();
    expect(readPortalToken(dataDir, undefined, '')).toBeNull();
  });

  it('无任何 Token → null 且零副作用：不建目录、不落文件（与 resolvePortalToken 的关键差异）', () => {
    const dataDir = tempDataDir();
    expect(readPortalToken(dataDir)).toBeNull();
    expect(existsSync(path.join(dataDir, 'portal'))).toBe(false); // 不生成 token 文件
  });

  it('token 文件首尾空白被 trim', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir, `  ${TOK}\n`);
    expect(readPortalToken(dataDir)!.token).toBe(TOK);
  });
});

describe('TASK-113 printablePortalUrl（URL 构造：口径与 runPortal 一致）', () => {
  it('token 文件形态 + 全缺省：http://127.0.0.1:7780/#token=<token>', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir);
    const url = printablePortalUrl(parsePortalArgs(['--print-url']), { dataDir });
    expect(url).toBe(`http://127.0.0.1:7780/#token=${TOK}`);
  });

  it('旗标 > config：--host/--port 覆盖 config.portal.host/port', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir);
    const url = printablePortalUrl(parsePortalArgs(['--print-url', '--host', '0.0.0.0', '--port', '7790']), {
      dataDir,
      configHost: '192.168.1.10',
      configPort: 7800,
    });
    expect(url).toBe(`http://0.0.0.0:7790/#token=${TOK}`);
  });

  it('config > env 端口 > 缺省：无旗标时 config 生效；config 缺失时 env SHANHAI_PORTAL_PORT 生效', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir);
    expect(printablePortalUrl(parsePortalArgs(['--print-url']), { dataDir, configPort: 7800, env: { SHANHAI_PORTAL_PORT: '7790' } }))
      .toBe(`http://127.0.0.1:7800/#token=${TOK}`);
    expect(printablePortalUrl(parsePortalArgs(['--print-url']), { dataDir, env: { SHANHAI_PORTAL_PORT: '7790' } }))
      .toBe(`http://127.0.0.1:7790/#token=${TOK}`);
  });

  it('config.portal.host 生效；IPv6 字面量主机加方括号；Token 经 encodeURIComponent（复用 buildPortalUrl）', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir, 't k%n'); // 含 URI 保留字符的口令
    expect(printablePortalUrl(parsePortalArgs(['--print-url']), { dataDir, configHost: '::1' }))
      .toBe(`http://[::1]:7780/#token=${encodeURIComponent('t k%n')}`);
  });

  it('Token 解析序可叠加旗标 host/port：env SHANHAI_PORTAL_TOKEN 优先于 token 文件', () => {
    const dataDir = tempDataDir();
    seedTokenFile(dataDir);
    expect(
      printablePortalUrl(parsePortalArgs(['--print-url']), { dataDir, env: { SHANHAI_PORTAL_TOKEN: 'e'.repeat(64) } }),
    ).toBe(`http://127.0.0.1:7780/#token=${'e'.repeat(64)}`);
  });
});

describe('TASK-113 无 Token 报错（从未首启形态）', () => {
  it('空数据目录 → fail-fast 并指引先运行 shanhai portal 首启；零副作用（不生成 Token 文件）', () => {
    const dataDir = tempDataDir();
    expect(() => printablePortalUrl(parsePortalArgs(['--print-url']), { dataDir })).toThrow(/shanhai portal/);
    expect(() => printablePortalUrl(parsePortalArgs(['--print-url']), { dataDir })).toThrow(/--print-url|Token/);
    expect(existsSync(path.join(dataDir, 'portal', 'token'))).toBe(false);
  });
});

describe('TASK-113 缺省路径不打印 Token（防终端日志意外留 Token）', () => {
  it('源契约钉死：cli.ts 中 printablePortalUrl 仅在 if (flags.printUrl) 守卫内调用（防漂移）', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const callIdx = src.indexOf('printablePortalUrl(');
    expect(callIdx).toBeGreaterThan(-1);
    const before = src.slice(0, callIdx);
    const guardIdx = before.lastIndexOf('flags.printUrl');
    expect(guardIdx).toBeGreaterThan(-1);
    // 守卫在调用之前且同属 runPortal 函数体（守卫与调用之间无新函数边界）
    expect(before.indexOf('async function runPortal')).toBeGreaterThan(-1);
    expect(before.lastIndexOf('function ')).toBeLessThan(guardIdx);
  });
});
