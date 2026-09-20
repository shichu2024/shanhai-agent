import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runReleaseScanCli } from '../src/scripts/releaseScan.js';

// 批次四（收官批）T3 侧 TDD 红阶段用例：P2-1 不可读（EACCES）与二进制探测区分 +
// P3-2 第二位置参数告警 + §8.1 注记 7 文面修订（决策官 01a0bdb0 裁定）。
// 不可读构造：mock node:fs 的 readFileSync/openSync 对标记文件抛 EACCES（Windows 无 chmod，跨平台等价）。

const unreadable = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const eacces = (p: string): never => {
    const e = new Error(`EACCES: permission denied, open '${p}'`) as NodeJS.ErrnoException;
    e.code = 'EACCES';
    throw e;
  };
  const hit = (p: unknown): boolean => {
    const s = String(p);
    return [...unreadable].some((name) => s.endsWith(name));
  };
  return {
    ...actual,
    readFileSync: ((p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (hit(p)) eacces(String(p));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(p, ...rest);
    }) as typeof actual.readFileSync,
    openSync: ((p: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
      if (hit(p)) eacces(String(p));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.openSync as any)(p, ...rest);
    }) as typeof actual.openSync,
  };
});

/** 拆分构造密钥样例（源码零完整模式命中——T3 扫描惯例） */
const fakeSecret = (): string => ['sk-ant-api', '03-yyyyyyyyyy', 'yyyyyyyyyyyyyy'].join('');

function cli(argv: string[], cwd = process.cwd()): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReleaseScanCli(argv, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out, err };
}

function tmpTree(): string {
  return mkdtempSync(path.join(tmpdir(), 't3-b4-'));
}

beforeEach(() => unreadable.clear());
afterEach(() => unreadable.clear());

describe('P2-1 不可读（EACCES）与二进制探测区分（不可读单列计数 + 应扫而未扫 → exit 2）', () => {
  it('未知扩展不可读 → 不再计入二进制残余：单列计数 + exit 2 + stderr 显式警告', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, `eacces.${['d', 'a', 't', 'x'].join('')}`), `const k = "${fakeSecret()}";\n`); // 白名单外扩展
    unreadable.add(`eacces.${['d', 'a', 't', 'x'].join('')}`);
    const r = cli([dir]);
    expect(r.code).toBe(2); // 应扫而未扫 ≠ 干净（现 fail-open：exit 0）
    expect(r.err.join('\n')).toContain('不可读');
    expect(r.out.join('\n')).toContain('不可读 1 个文件'); // 单列计数（不与二进制残余混同）
  });

  it('已知文本扩展不可读 → exit 2 且措辞区分（不可读，非笼统「执行异常」）；扫描不中断，其余文件仍入汇总', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, 'eacces.txt'), `const k = "${fakeSecret()}";\n`);
    writeFileSync(path.join(dir, 'ok.ts'), 'export const x = 1;\n');
    unreadable.add('eacces.txt');
    const r = cli([dir]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('不可读'); // 现报「扫描执行异常」——语义分裂点
    expect(r.out.join('\n')).toContain('零命中'); // 其余文件扫描完成（不再中断）
    expect(r.out.join('\n')).toContain('不可读 1 个文件');
  });

  it('二进制残余与不可读分列：各计各数，不可读主导 exit 2（残余仍可观测）', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, 'blob.datx'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03])); // 未知扩展 .datx 含 NUL——真二进制（非权重扩展）
    writeFileSync(path.join(dir, 'eacces2.txt'), 'plain');
    unreadable.add('eacces2.txt');
    const r = cli([dir]);
    expect(r.out.join('\n')).toContain('二进制残余 1 个文件');
    expect(r.out.join('\n')).toContain('不可读 1 个文件');
    expect(r.code).toBe(2);
  });

  it('A6 §8.1 注记 7 文面修订：残余=二进制探测判为二进制者；不可读属「应扫而未扫」（exit 2）单列计数', () => {
    const a6 = readFileSync(path.join(process.cwd(), 'docs', 'spec', 'A6-事件模型.md'), 'utf8');
    expect(a6).toContain('不可读');
    expect(a6).toMatch(/不可读[^\n]*单列计数|单列计数[^\n]*不可读/);
    expect(a6).toMatch(/不可读[^\n]*应扫而未扫|应扫而未扫[^\n]*不可读/);
  });
});

describe('P3-2 第二位置参数静默忽略 → 补未识别告警（与未识别 flag 同款纪律）', () => {
  it('第二个位置参数被忽略时 stderr 告警（拼错命令面不得静默）', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, 'ok.ts'), 'export const x = 1;\n');
    const r = cli([dir, 'extra-arg']);
    expect(r.err.join('\n')).toContain('位置参数');
    expect(r.code).toBe(0); // 告警不改变既有判定（根仍可扫）
  });
});
