import { readdirSync, readFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';

// T3 发布安全扫描（A5 §4-3）：已知密钥格式正则 + 模型权重文件检查（扩展名/魔数/结构嗅探）。
// 零命中方为通过；命中即拒绝发布（退出码 1）。与开源前置待办（定稿 §11-2）复用同一实现。
// 批次四（§4.10）机制化：扫描清单配置化（入配置、可审计）+ safetensors 真实样本结构嗅探
// + 测试夹具目录豁免规则（豁免入配置、可审计——P2-4 修复：夹具不误报）。

export interface ScanExemption {
  /** 相对扫描根的路径前缀（目录或文件）；命中即跳过 */
  path: string;
  /** 豁免理由（可审计——无理由的豁免不允许） */
  reason: string;
}

export interface ScanConfig {
  /** 密钥格式清单（正则源文本——配置形态可审计；复用载体：redaction 默认规则集同源） */
  secretPatterns: { name: string; pattern: string }[];
  /** 权重文件扩展名清单 */
  weightExtensions: string[];
  /** 权重魔数清单（首 4 字节） */
  weightMagics: number[][];
  /** safetensors 结构嗅探（8B LE headerLen + JSON 首字节 + 长度一致性——真实样本形态） */
  sniffSafetensors: boolean;
  /** 豁免清单（入配置、可审计；P2-4：测试夹具阳性对照不误报） */
  exemptions: ScanExemption[];
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  secretPatterns: [
    { name: 'OpenAI sk- 密钥', pattern: 'sk-[A-Za-z0-9_-]{20,}' },
    { name: 'Anthropic sk-ant- 密钥', pattern: 'sk-ant-[A-Za-z0-9_-]{20,}' },
    { name: 'AWS AKIA 访问键', pattern: 'AKIA[0-9A-Z]{16}' },
    { name: 'GitHub token (ghp_/gho_/ghu_/ghs_)', pattern: 'gh[pous]_[A-Za-z0-9]{36,}' },
    { name: 'Slack xox 令牌', pattern: 'xox[abprs]-[A-Za-z0-9-]{10,}' },
    { name: 'Google AIza 密钥', pattern: 'AIza[0-9A-Za-z_-]{35}' },
    { name: '通用 Bearer 长令牌（可能的私钥/JWT）', pattern: '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' },
  ],
  weightExtensions: ['.gguf', '.safetensors', '.pth', '.pt', '.onnx', '.bin', '.ckpt', '.pb', '.tflite', '.h5'],
  weightMagics: [
    [0x47, 0x47, 0x55, 0x46], // GGUF "GGUF"
    [0x89, 0x48, 0x44, 0x46], // HDF5
  ],
  sniffSafetensors: true,
  exemptions: [
    {
      path: path.join('tests', 'fixtures', 'positive-controls'),
      reason: 'T3 阳性对照夹具（批次四 DoD-②：每族一个阳性对照样本；豁免入配置、可审计——P2-4）',
    },
  ],
};

/** 向后兼容导出：redaction 默认规则集与既有测试消费同一清单（配置 → RegExp 形态） */
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = DEFAULT_SCAN_CONFIG.secretPatterns.map((p) => ({
  name: p.name,
  re: new RegExp(p.pattern),
}));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'traces', 'experiment-runs', '.claude', '.dsh', '.multica', 'coverage']);
const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.json', '.md', '.txt', '.yml', '.yaml', '.example', '.gitignore', '.mjs', '.cjs', '.sql', '.sh', '.ps1', '.html', '.css', '.jsonl']);

export interface ScanFinding {
  kind: 'secret' | 'model_weight';
  file: string;
  detail: string;
}

export function scanForRelease(root: string, config: ScanConfig = DEFAULT_SCAN_CONFIG): ScanFinding[] {
  const compiled = config.secretPatterns.map((p) => ({ name: p.name, re: new RegExp(p.pattern) }));
  const weightExtensions = new Set(config.weightExtensions.map((e) => e.toLowerCase()));
  // 豁免匹配（P2-4）：以「绝对路径包含豁免路径段序列」判定——对任意扫描根（仓库根 / 子树 / 夹具目录本身）口径统一。
  // 配置内豁免路径为仓库相对形态（tests/fixtures/positive-controls），展开为段序列后与文件绝对路径段匹配。
  const toFwd = (p: string): string => p.split(path.sep).join('/');
  const segmentsOf = (p: string): string[] => toFwd(p).split('/').filter((s) => s.length > 0);
  const rootAbs = path.resolve(root);
  const exemptSegments = config.exemptions.map((x) => ({ x, segs: segmentsOf(x.path) }));
  const pathContains = (container: string[], part: string[]): boolean => {
    if (part.length === 0 || container.length < part.length) return false;
    for (let i = 0; i + part.length <= container.length; i++) {
      if (part.every((s, j) => container[i + j] === s)) return true;
    }
    return false;
  };
  const exempt = (absSegments: string[]): ScanExemption | null =>
    exemptSegments.find(({ x, segs }) => pathContains(absSegments, segs))?.x ?? null;
  const rootSegs = segmentsOf(rootAbs);
  const findings: ScanFinding[] = [];
  // 扫描根本身位于豁免路径内（如直接以夹具目录为根）→ 整体跳过
  if (exempt(rootSegs) !== null) {
    return findings;
  }
  walk(root);
  return findings;

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // 符号链接（含目录 junction）不跟随、不扫描
      if (entry.name.startsWith('.git') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      const file = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      const rel = path.relative(root, file);
      const ex = exempt(segmentsOf(file));
      if (ex) continue; // 豁免命中：跳过（豁免清单本身随配置可审计）

      if (weightExtensions.has(ext)) {
        findings.push({ kind: 'model_weight', file: rel, detail: `模型权重文件扩展名 ${ext}` });
        continue;
      }
      // A5 §4-3 魔数检查（TASK-40 F-4）：无权重扩展名的文件按首 4 字节判定，防改名绕过
      if (hasWeightMagic(file, config.weightMagics)) {
        findings.push({ kind: 'model_weight', file: rel, detail: '模型权重文件魔数匹配' });
        continue;
      }
      // 批次四 DoD-③：safetensors 真实样本结构嗅探——8B LE headerLen + JSON 首字节 + 长度一致
      if (config.sniffSafetensors && isSafetensors(file)) {
        findings.push({ kind: 'model_weight', file: rel, detail: 'safetensors 结构嗅探命中（headerLen + JSON header）' });
        continue;
      }
      // config.example 中的占位与文档中的示例说明不视为命中（占位值不含真实密钥材料）
      if (TEXT_EXTENSIONS.has(ext) || !ext) {
        const content = readFileSync(file, 'utf8');
        for (const { name, re } of compiled) {
          const m = re.exec(content);
          if (m) {
            findings.push({ kind: 'secret', file: rel, detail: `${name}：${m[0].slice(0, 8)}…（位置 ${m.index}）` });
          }
        }
      }
    }
  }
}

function hasWeightMagic(file: string, magics: number[][]): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return magics.some((magic) => magic.length > 0 && magic.every((b, i) => buf[i] === b));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** safetensors 结构嗅探：文件 = 8 字节 LE u64 headerLen + header JSON + 数据区。
 * 判定：headerLen ∈ [2, 10MB]、第 9 字节为 '{'、8 + headerLen ≤ 文件大小。 */
function isSafetensors(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    if (size < 10) return false;
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(9);
    const bytesRead = readSync(fd, buf, 0, 9, 0);
    if (bytesRead < 9) return false;
    const headerLen = Number(buf.readBigUInt64LE(0));
    return headerLen >= 2 && headerLen <= 10 * 1024 * 1024 && buf[8] === 0x7b /* '{' */ && 8 + headerLen <= size;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function formatFindings(findings: ScanFinding[]): string {
  if (findings.length === 0) return '零命中：通过（T3 发布安全断言）';
  return findings.map((f) => `- [${f.kind}] ${f.file}: ${f.detail}`).join('\n');
}

/** CLI 侧可选配置装载（config.local.json 的 scan 段；无配置/无段 = 默认清单） */
function loadScanConfigFrom(repoRoot: string): ScanConfig {
  const file = path.join(repoRoot, 'config.local.json');
  if (!existsSync(file)) return DEFAULT_SCAN_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { scan?: Partial<ScanConfig> };
    if (!raw.scan) return DEFAULT_SCAN_CONFIG;
    return { ...DEFAULT_SCAN_CONFIG, ...raw.scan };
  } catch {
    return DEFAULT_SCAN_CONFIG; // 配置损坏退默认（fail-safe：默认清单照扫）
  }
}

// CLI 入口
if (process.argv[1] && /release[-_]?scan\.js$/i.test(process.argv[1])) {
  const root = process.argv[2] ?? process.cwd();
  const config = loadScanConfigFrom(process.cwd());
  const findings = scanForRelease(root, config);
  console.log(`T3 发布安全扫描：${root}（清单 ${config.secretPatterns.length} 密钥正则 / ${config.weightExtensions.length} 扩展名 / ${config.weightMagics.length} 魔数 / safetensors 嗅探 ${config.sniffSafetensors ? 'on' : 'off'} / 豁免 ${config.exemptions.length} 项）`);
  console.log(formatFindings(findings));
  process.exit(findings.length === 0 ? 0 : 1);
}
