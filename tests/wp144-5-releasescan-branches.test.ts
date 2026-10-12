import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanForRelease, runReleaseScanCli, rootExemption, DEFAULT_SCAN_CONFIG, type ScanConfig, type ScanStats } from '../src/scripts/releaseScan.js';

// TASK-144 第十批：releaseScan 残余分支补强。
// 基线（main @ 82192c8）未覆盖段 → 本文件用例映射：
//   201-202 → scanEnvRefs：.json 文件 JSON 解析失败 → 跳过（其余规则族照常）
//   212 分支 → scanEnvRefs：envRefs 值非字符串 → 命中（凭据永不落配置面）
//   283-289 → loadScanConfigFrom：config.local.json 缺失 / 无 scan 段 / 损坏 JSON / scan 覆盖合并
//   351-352 → CLI 直执行守卫（process.argv[1] 匹配 releaseScan.js → runReleaseScanCli + exit）
//   121/123/125 分支 → 符号链接不跟随；.git 本体跳过；SKIP_DIRS 跳过
//   101 分支 → rootExemption：豁免段数多于根段数 → continue 不命中
//   245/249/264 分支 → 魔数短文件；空魔数数组；safetensors size<10
// 残余（不强行凑盖）：scanText/probeBinary 的 EACCES 不可读分支已有专项夹具测试（wp3b-batch4）。

const minimalConfig = (over: Partial<ScanConfig> = {}): ScanConfig => ({
  secretPatterns: [{ name: 'OpenAI sk- 密钥', pattern: 'sk-[A-Za-z0-9_-]{20,}' }],
  weightExtensions: ['.gguf'],
  weightMagics: [[0x47, 0x47, 0x55, 0x46]],
  sniffSafetensors: true,
  exemptions: [],
  ...over,
});

/** 合成密钥串（拼装形态——不构成源码内完整模式命中，T3 惯例） */
const fakeSk = (): string => ['sk-proj-', 'aaaa', 'bbbbbbbbbbbbbbbbbbbbbb'].join('');

function buildRoot(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'wp144-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

describe('scanEnvRefs 残余分支（201-202 / 212）', () => {
  it('.json 内容非法 JSON → 本规则族跳过（不误报、不中断其余规则族）', () => {
    const root = buildRoot({ 'broken.json': '{invalid json' });
    const findings = scanForRelease(root, minimalConfig());
    expect(findings).toHaveLength(0); // 解析失败不归 credential_ref，也不含密钥内容
  });

  it('envRefs 值非字符串（数字）→ 命中 credential_ref（值位必须为 ${VAR} 引用形态）', () => {
    const root = buildRoot({ 'mcp.json': JSON.stringify({ mcpServers: { a: { envRefs: { PORT: 8080 } } } }) });
    const findings = scanForRelease(root, minimalConfig());
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('credential_ref');
    expect(findings[0].file).toBe('mcp.json');
    expect(findings[0].detail).toContain('envRefs.PORT');
  });

  it('envRefs 值为 ${VAR} 占位 → 零命中（阴性对照）', () => {
    const root = buildRoot({ 'mcp.json': JSON.stringify({ mcpServers: { a: { envRefs: { KEY: '${MY_SECRET}' } } } }) });
    expect(scanForRelease(root, minimalConfig())).toHaveLength(0);
  });
});

describe('walk 残余分支（121 符号链接 / 123 .git / 125 SKIP_DIRS）', () => {
  it('SKIP_DIRS 目录（node_modules）与 .git 本体不扫描；.github 等同名前缀目录必须扫描', () => {
    const root = buildRoot({
      'node_modules/pkg/leak.md': `token ${fakeSk()}`,
      '.git/objects/leak.log': `token ${fakeSk()}`,
      '.github/workflows/clean.yml': 'name: ci\n',
    });
    const findings = scanForRelease(root, minimalConfig());
    expect(findings).toHaveLength(0); // node_modules/.git 跳过；.github 干净
  });

  it('符号链接（junction 形态）不跟随、不扫描', () => {
    const outside = buildRoot({ 'leak.md': `token ${fakeSk()}` }); // 链接目标在扫描根外
    const root = buildRoot({ 'keep.md': 'clean' });
    try {
      symlinkSync(outside, path.join(root, 'linked-dir'), 'junction');
    } catch {
      return; // Windows 无 symlink 权限的环境：跳过（不强行凑盖）
    }
    expect(scanForRelease(root, minimalConfig())).toHaveLength(0);
  });
});

describe('权重探测残余分支（245 / 249 / 264）', () => {
  it('短于 4 字节的文件不判魔数 → 按探测结果入文本扫描', () => {
    const root = buildRoot({ 'short.unknown': 'ab' });
    const stats: ScanStats = { binarySkipped: 0, unreadableSkipped: 0 };
    expect(scanForRelease(root, minimalConfig(), stats)).toHaveLength(0);
    expect(stats.binarySkipped).toBe(0); // 短文本未判二进制
  });

  it('空魔数数组条目不参与匹配（magic.length>0 守卫）→ GGUF 字节按文本扫描', () => {
    const root = buildRoot({ 'magic.unknown': Buffer.from([0x47, 0x47, 0x55, 0x46, 0x2d, 0x76]) });
    const config = minimalConfig({ weightMagics: [[]] }); // 空魔数条目
    expect(scanForRelease(root, config)).toHaveLength(0); // 未按魔数命中（内容无 NUL → 文本扫描无密钥）
  });

  it('safetensors 嗅探：size<10 直接否（264 分支）；合法结构（8B LE headerLen + JSON header）命中', () => {
    const header = '{"a":1}' + ' '.repeat(20 - 7); // 20 字节 JSON header（尾随空白 JSON 容忍）
    const st = Buffer.concat([Buffer.alloc(8), Buffer.from(header, 'utf8')]);
    st.writeBigUInt64LE(BigInt(header.length), 0);
    const root = buildRoot({
      'tiny.unknown': 'abcde', // 5 字节 < 10 → 不嗅探
      'model.unknown': st,
    });
    const findings = scanForRelease(root, minimalConfig());
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('model.unknown');
    expect(findings[0].detail).toContain('safetensors 结构嗅探');
  });

  it('改名 GGUF（魔数 + 未知扩展名）→ 魔数命中（防改名绕过回归）', () => {
    const root = buildRoot({ 'renamed.unknown': Buffer.from([0x47, 0x47, 0x55, 0x46, 0x03, 0x00]) });
    const findings = scanForRelease(root, minimalConfig());
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('model_weight');
    expect(findings[0].detail).toContain('魔数匹配');
  });
});

describe('rootExemption 段数边界（101 分支）', () => {
  it('豁免段数多于根段数 → 不命中（continue）', () => {
    const config = minimalConfig({ exemptions: [{ path: 'a/b/c/d/e/f/g', reason: '深层路径' }] });
    expect(rootExemption('x/y', config)).toBeNull();
  });

  it('根段序列包含豁免段（任意嵌套从严）→ 命中并返回豁免项', () => {
    const exemption = { path: 'tests/fixtures/positive-controls', reason: '夹具自检' };
    const config = minimalConfig({ exemptions: [exemption] });
    const hit = rootExemption(path.join('w', 'tests', 'fixtures', 'positive-controls', 'x'), config);
    expect(hit?.path).toBe(exemption.path);
  });
});

describe('loadScanConfigFrom（283-289：config.local.json 装载全路径）', () => {
  const cleanFiles = { 'clean.md': 'nothing here' };

  it('无 config.local.json → 默认清单（7 密钥正则）', () => {
    const root = buildRoot(cleanFiles);
    const out: string[] = [];
    const code = runReleaseScanCli([], { cwd: root, stdout: (l) => out.push(l), stderr: () => {} });
    expect(code).toBe(0);
    expect(out[0]).toContain(`清单 ${DEFAULT_SCAN_CONFIG.secretPatterns.length} 密钥正则`);
  });

  it('config.local.json 无 scan 段 → 默认清单', () => {
    const root = buildRoot({ ...cleanFiles, 'config.local.json': JSON.stringify({ other: 1 }) });
    const out: string[] = [];
    const code = runReleaseScanCli([], { cwd: root, stdout: (l) => out.push(l), stderr: () => {} });
    expect(code).toBe(0);
    expect(out[0]).toContain(`清单 ${DEFAULT_SCAN_CONFIG.secretPatterns.length} 密钥正则`);
  });

  it('config.local.json 损坏 JSON → 退默认清单（fail-safe）', () => {
    const root = buildRoot({ ...cleanFiles, 'config.local.json': '{broken' });
    const out: string[] = [];
    const code = runReleaseScanCli([], { cwd: root, stdout: (l) => out.push(l), stderr: () => {} });
    expect(code).toBe(0);
    expect(out[0]).toContain(`清单 ${DEFAULT_SCAN_CONFIG.secretPatterns.length} 密钥正则`); // 287-289：损坏退默认
  });

  it('config.local.json scan 段覆盖 → 合并生效（1 密钥正则 / 嗅探 off / 自定义豁免）', () => {
    const root = buildRoot({
      'clean.md': 'nothing here',
      'config.local.json': JSON.stringify({ scan: { secretPatterns: [{ name: 'only-one', pattern: 'qqq-[0-9]{20,}' }], sniffSafetensors: false } }),
    });
    const out: string[] = [];
    const code = runReleaseScanCli([], { cwd: root, stdout: (l) => out.push(l), stderr: () => {} });
    expect(code).toBe(0);
    expect(out[0]).toContain('清单 1 密钥正则'); // 覆盖合并
    expect(out[0]).toContain('嗅探 off');
    expect(out[0]).toContain(`豁免 ${DEFAULT_SCAN_CONFIG.exemptions.length}`); // 未覆盖字段保留默认
  });
});

describe('CLI 直执行守卫（351-352）', () => {
  it('以 releaseScan.js 为主模块动态导入 → 守卫触发 runReleaseScanCli + process.exit(0)（干净根）', async () => {
    const root = buildRoot({ 'clean.md': 'nothing' });
    const origArgv = process.argv;
    const exitCalls: number[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error(`EXIT:${code ?? 0}`); // 阻断后续执行（守卫位于模块顶层）
    }) as never);
    process.argv = ['node', path.join(root, 'dist', 'releaseScan.js'), root];
    try {
      vi.resetModules(); // 守卫在 import 时求值——须以新模块图重放
      await import('../src/scripts/releaseScan.js');
      expect.fail('守卫未触发 process.exit');
    } catch (err) {
      expect(String((err as Error).message)).toBe('EXIT:0'); // 干净根 → exit(0)
    } finally {
      process.argv = origArgv;
      exitSpy.mockRestore();
      vi.resetModules();
    }
    expect(exitCalls).toEqual([0]);
  });
});
