import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runReleaseScanCli, DEFAULT_SCAN_CONFIG } from '../src/scripts/releaseScan.js';

// T3 执行接线 fail-open 收口（§4.3，D-21）：exit 码三元组 CLI 级断言——
// 命中=1 / 干净=0 / 未扫描=2（含短路根与扫描根不存在）；--allow-exempted-root 显式放行；
// 豁免锚定扫描根（任意嵌套命中不再豁免）；扩展名扩面 11 项 + 未知扩展宽松解码探测（择项）。

const FIXTURES_ABS = path.join(process.cwd(), 'tests', 'fixtures', 'positive-controls');
/** 拆分构造密钥样例（源码零完整模式命中——T3 扫描惯例） */
const fakeSecret = (): string => ['sk-ant-api', '03-xxxxxxxxxx', 'xxxxxxxxxxxxxx'].join('');

function cli(argv: string[], cwd = process.cwd()): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReleaseScanCli(argv, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out, err };
}

function tmpTree(): string {
  return mkdtempSync(path.join(tmpdir(), 't3-cli-'));
}

describe('A-3 T3 CLI 级 exit 码三元组（命中=1 / 干净=0 / 未扫描=2）', () => {
  it('干净目录 → exit 0', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, 'ok.ts'), 'export const x = 1;\n');
    const r = cli([dir]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('零命中');
  });

  it('命中（密钥）→ exit 1', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, 'leak.js'), `const k = "${fakeSecret()}";\n`);
    const r = cli([dir]);
    expect(r.code).toBe(1);
  });

  it('扫描根路径不存在 → exit 2（应扫而未扫 ≠ 干净）+ stderr 显式警告', () => {
    const missing = path.join(tmpTree(), 'no-such-dir');
    const r = cli([missing]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('不存在');
  });

  it('扫描执行异常（根为文件，readdirSync 抛 ENOTDIR）→ exit 2，不落入 exit 1（命中）语义', () => {
    const dir = tmpTree();
    const fileAsRoot = path.join(dir, 'a-file.txt');
    writeFileSync(fileAsRoot, 'plain');
    const r = cli([fileAsRoot]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('异常');
  });

  it('未识别 flag → stderr 告警（拼错参数不得静默）', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, 'ok.ts'), 'export const x = 1;\n');
    const r = cli([dir, '--allow-exmpted-root']); // 拼错形态
    expect(r.err.join('\n')).toContain('未识别参数');
    expect(r.code).toBe(0); // 扫描本身照常完成
  });

  it('短路根：扫描根本身位于豁免路径内（夹具目录）→ exit 2 + stderr 警告，不再静默零发现', () => {
    const r = cli([FIXTURES_ABS]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('豁免');
    expect(r.err.join('\n')).toContain('未扫描');
  });

  it('--allow-exempted-root 显式放行：夹具自检真实场景——放行动作进输出日志，扫描照常执行（阳性对照命中 exit 1）', () => {
    const r = cli([FIXTURES_ABS, '--allow-exempted-root']);
    expect(r.code).toBe(1); // 四族阳性对照全部命中（夹具自检的预期结果）
    const out = r.out.join('\n');
    expect(out).toContain('--allow-exempted-root'); // 放行动作可审计（进输出日志）
    expect(out).toContain('positive-control.secret.txt');
    expect(out).toContain('positive-control.gguf');
    expect(out).toContain('renamed-weight.dat');
    expect(out).toContain('positive-control.safetensors');
  });

  it('根省缺 → 以 cwd 为扫描根（真实 npm run release-scan 形态）', () => {
    // 仓库根默认配置：零命中 → exit 0（等价 npm run release-scan 的 cwd 语义）
    const r = cli([], process.cwd());
    expect(r.code).toBe(0);
  });
});

describe('豁免锚定扫描根（D-21：任意嵌套命中不再豁免）', () => {
  it('豁免位于扫描根内、从扫描根起算 → 生效（仓库根形态：tests/fixtures/positive-controls 前缀命中）', () => {
    // 以 tests/ 为根构造等价形态：exemption 段序列 = 扫描根相对路径前缀
    const dir = tmpTree();
    mkdirSync(path.join(dir, 'tests', 'fixtures', 'positive-controls'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'fixtures', 'positive-controls', 'leak.txt'), `k=${fakeSecret()}\n`);
    writeFileSync(path.join(dir, 'clean.ts'), 'export const x = 1;\n');
    const r = cli([dir]);
    expect(r.code).toBe(0); // 锚定豁免生效：夹具形态路径被豁免
  });

  it('嵌套命中不生效：段序列出现在扫描根相对路径中段（非前缀）→ 不豁免、命中报告', () => {
    const dir = tmpTree();
    mkdirSync(path.join(dir, 'src', 'tests', 'fixtures', 'positive-controls'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'tests', 'fixtures', 'positive-controls', 'leak.txt'), `k=${fakeSecret()}\n`);
    const r = cli([dir]);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toContain('src/tests/fixtures/positive-controls/leak.txt'); // 嵌套豁免不生效（fail-closed）
  });
});

describe('扩展名扩面（D-21：TEXT_EXTENSIONS + 11 项）+ 未知扩展宽松解码探测（择项）', () => {
  const NEW_EXTS = ['.pem', '.key', '.log', '.env', '.p12', '.pfx', '.crt', '.ini', '.cfg', '.conf'];

  it('扩面 10 个简单扩展名逐项对照：同内容密钥文件全部命中', () => {
    for (const ext of NEW_EXTS) {
      const dir = tmpTree();
      writeFileSync(path.join(dir, `cred${ext}`), `token=${fakeSecret()}\n`);
      const r = cli([dir]);
      expect(r.code, `扩展名 ${ext} 应命中`).toBe(1);
    }
  });

  it('多段扩展名 .env.local：按文件名后缀匹配命中（extname 取不到）', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, '.env.local'), `KEY=${fakeSecret()}\n`);
    const r = cli([dir]);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toContain('.env.local');
  });

  it('白名单外文本扩展（未知扩展名）：二进制探测放行 → 宽松解码扫描命中（择项实现）', () => {
    const dir = tmpTree();
    writeFileSync(path.join(dir, 'notes.unknownext'), `k=${fakeSecret()}\n`);
    const r = cli([dir]);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toContain('notes.unknownext');
  });

  it('二进制文件（含 NUL 字节）不进入解码扫描：探测先于解码（反方执行注记）——已知未扫描残余', () => {
    const dir = tmpTree();
    // 二进制内容：NUL 字节 + 恰好含密钥字面（若误解码将误命中——断言探测先行排除）
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from(`k=${fakeSecret()}\n`), Buffer.from([0x00, 0x01, 0x02, 0x03])]));
    const r = cli([dir]);
    // .bin 在权重扩展名清单内 → 命中为 model_weight（非 secret 解码命中）
    expect(r.out.join('\n')).not.toContain('[secret]');
    expect(r.code).toBe(1); // 权重扩展名族命中
    // 换无权重扩展的二进制：探测跳过、零解码命中 → 干净 + 残余计数可观测（汇总行）
    const dir2 = tmpTree();
    writeFileSync(path.join(dir2, 'blob.unknownext'), Buffer.concat([Buffer.from('text-part\0'), Buffer.from([0x00, 0xff, 0xfe, 0x03])]));
    const r2 = cli([dir2]);
    expect(r2.code).toBe(0);
    expect(r2.out.join('\n')).toContain('二进制残余 1 个文件'); // 残余面可审计（MEDIUM-1）
  });
});

describe('A6 §8 v1.3 修订注记随批提交（口径冻结成文面机械断言）', () => {
  it('A6 §8 含 v1.3 注记：辖区冻结 / 本地数据域（含 experiment-runs） / 防线一道 / 三破例面 / 未扫描残余口径', () => {
    const a6 = readFileSync(path.join(process.cwd(), 'docs', 'spec', 'A6-事件模型.md'), 'utf8');
    expect(a6).toContain('v1.3 修订注记');
    expect(a6).toContain('辖区');
    expect(a6).toContain('experiment-runs');
    expect(a6).toContain('本地数据域');
    expect(a6).toContain('一道');
    expect(a6).toContain('备份');
    expect(a6).toContain('导出');
    expect(a6).toContain('SHANHAI_DATA_DIR');
    expect(a6).toContain('未扫描残余');
  });

  it('默认豁免清单仍含可审计理由（P2-4 回归不回退）', () => {
    expect(DEFAULT_SCAN_CONFIG.exemptions[0].reason).toBeTruthy();
  });
});
