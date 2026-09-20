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
// 第三阶段批次一（D-21）扩面 +11 项 = 10 个简单扩展名（extname 可取）+ 1 个多段扩展名（.env.local，按文件名后缀匹配）：
// .pem/.key/.log/.env/.p12/.pfx/.crt/.ini/.cfg/.conf + .env.local
const TEXT_EXTENSIONS = new Set([
  '.ts', '.js', '.json', '.md', '.txt', '.yml', '.yaml', '.example', '.gitignore', '.mjs', '.cjs', '.sql', '.sh', '.ps1', '.html', '.css', '.jsonl',
  '.pem', '.key', '.log', '.env', '.p12', '.pfx', '.crt', '.ini', '.cfg', '.conf',
]);
// 多段扩展名（extname 只能取到最后一段 .local，按文件名后缀匹配）
const COMPOUND_TEXT_SUFFIXES = ['.env.local'];

export interface ScanFinding {
  kind: 'secret' | 'model_weight';
  file: string;
  detail: string;
}

/** 扫描统计（可审计残余面：二进制探测跳过数——A6 §8.1 已知未扫描残余的可观测化；
 * 批次四 P2-1：不可读（EACCES 等）单列计数——属「应扫而未扫」exit 2 语义，不与二进制残余混同） */
export interface ScanStats {
  binarySkipped: number;
  unreadableSkipped: number;
}

// 正反斜杠均归一（配置内手写正斜杠路径在 Windows 上不得静默失配）
const toFwd = (p: string): string => p.split(/[\\/]/).join('/');
const segmentsOf = (p: string): string[] => toFwd(p).split('/').filter((s) => s.length > 0);

/** 豁免锚定（第三阶段批次一，D-21）：豁免段序列必须是文件「相对扫描根路径」的前缀——
 * 豁免必须位于扫描根内、从扫描根起算；绝对路径任意嵌套位置命中不再豁免（fail-closed：
 * 在扫描树内深挖同名目录结构不再能借豁免隐藏命中）。 */
const exemptAnchored = (relSegments: string[], exemptionSegments: string[][]): boolean =>
  exemptionSegments.some(
    (segs) => segs.length > 0 && segs.length <= relSegments.length && segs.every((s, i) => relSegments[i] === s),
  );

/** 扫描根本身位于豁免路径内（如直接以夹具目录为根）——短路态判定（绝对路径段序列包含，任意嵌套从严）：
 * CLI 层据此输出 exit 2（未扫描 ≠ 干净），或经 --allow-exempted-root 显式放行。 */
export function rootExemption(root: string, config: ScanConfig = DEFAULT_SCAN_CONFIG): ScanExemption | null {
  const rootSegs = segmentsOf(path.resolve(root));
  for (const x of config.exemptions) {
    const segs = segmentsOf(x.path);
    if (segs.length === 0 || rootSegs.length < segs.length) continue;
    for (let i = 0; i + segs.length <= rootSegs.length; i++) {
      if (segs.every((s, j) => rootSegs[i + j] === s)) return x;
    }
  }
  return null;
}

export function scanForRelease(root: string, config: ScanConfig = DEFAULT_SCAN_CONFIG, stats?: ScanStats): ScanFinding[] {
  const compiled = config.secretPatterns.map((p) => ({ name: p.name, re: new RegExp(p.pattern) }));
  const weightExtensions = new Set(config.weightExtensions.map((e) => e.toLowerCase()));
  const rootAbs = path.resolve(root);
  const exemptionSegments = config.exemptions.map((x) => segmentsOf(x.path));
  const findings: ScanFinding[] = [];
  walk(root);
  return findings;

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // 符号链接（含目录 junction）不跟随、不扫描
      // 只跳过 .git 本体（内部对象库）——.github/.gitlab 等目录是 CI/流程配置的真实发布面，必须扫描
      if (entry.name === '.git' && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      const file = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      const rel = toFwd(path.relative(rootAbs, file));
      if (exemptAnchored(segmentsOf(rel), exemptionSegments)) continue; // 锚定豁免命中：跳过（豁免清单随配置可审计）

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
      const isTextByName = TEXT_EXTENSIONS.has(ext) || !ext || COMPOUND_TEXT_SUFFIXES.some((s) => entry.name.toLowerCase().endsWith(s));
      if (isTextByName) {
        scanText(file, rel, compiled, findings, stats);
        continue;
      }
      // 择项（D-21）：白名单外扩展名——二进制探测先行（反方执行注记：探测必须先于解码扫描，
      // 二进制内容不得进入 UTF-8 解码），探测放行的未知扩展文本按宽松解码扫描（fail-closed 收敛）；
      // 探测判为二进制 = 已知未扫描残余（A6 §8 v1.3 成文口径）；
      // 批次四 P2-1：不可读（EACCES 等）≠ 二进制——单列计数（应扫而未扫，exit 2 语义）。
      const probe = probeBinary(file);
      if (probe === 'unreadable') {
        if (stats) stats.unreadableSkipped += 1;
      } else if (probe === 'binary') {
        if (stats) stats.binarySkipped += 1; // 残余可观测：探测判二进制跳过的文件数进统计（CLI 汇总行输出）
      } else {
        scanText(file, rel, compiled, findings, stats);
      }
    }
  }
}

function scanText(file: string, rel: string, compiled: { name: string; re: RegExp }[], findings: ScanFinding[], stats?: ScanStats): void {
  let content: string;
  try {
    content = readFileSync(file, 'utf8'); // 宽松解码：非法序列替换为 U+FFFD，不中断扫描
  } catch {
    // 批次四 P2-1：读失败（EACCES 等）= 应扫而未扫——单列计数，扫描不中断（其余文件继续），CLI 终判 exit 2
    if (stats) stats.unreadableSkipped += 1;
    return;
  }
  for (const { name, re } of compiled) {
    const m = re.exec(content);
    if (m) {
      findings.push({ kind: 'secret', file: rel, detail: `${name}：${m[0].slice(0, 8)}…（位置 ${m.index}）` });
    }
  }
}

/** 二进制探测（批次四 P2-1 三态化）：首 8KB 含 NUL 字节即判二进制（文本文件不含 NUL；权重文件已被前置检查拦截）；
 * 读取失败（EACCES 等）= unreadable——与二进制严格区分，不混入残余计数。 */
function probeBinary(file: string): 'text' | 'binary' | 'unreadable' {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0) ? 'binary' : 'text';
  } catch {
    return 'unreadable';
  } finally {
    if (fd !== undefined) closeSync(fd);
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

// CLI 入口（第三阶段批次一，D-21）：函数化 + exit 码三元组——命中=1 / 干净=0 / 未扫描=2。
// 「未扫描 ≠ 干净」：短路根（扫描根本身位于豁免路径内）与扫描根不存在均为应扫而未扫，exit 2；
// --allow-exempted-root 显式放行短路根（如夹具自检），放行动作进输出日志。
export interface CliRunOptions {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function runReleaseScanCli(argv: string[], opts: CliRunOptions = {}): number {
  const out = opts.stdout ?? console.log;
  const err = opts.stderr ?? console.error;
  const cwd = opts.cwd ?? process.cwd();
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const allowExemptedRoot = flags.includes('--allow-exempted-root');
  for (const f of flags) {
    if (f !== '--allow-exempted-root') err(`T3 发布安全扫描：未识别参数 ${f}（已知：--allow-exempted-root）`); // 拼错 flag 不得静默
  }
  // 批次四 P3-2：第二及以后位置参数被忽略 → 告警（与未识别 flag 同款纪律，拼错命令面不得静默）
  if (positional.length > 1) {
    err(`T3 发布安全扫描：第二及以后位置参数被忽略（仅接受一个扫描根，收到 ${positional.length} 个）——检查命令拼写`);
  }
  const root = path.resolve(cwd, positional[0] ?? '.');
  const config = loadScanConfigFrom(cwd);

  if (!existsSync(root)) {
    err(`T3 发布安全扫描：扫描根不存在——未扫描（exit 2）：${root}`);
    return 2;
  }
  const rootExempt = rootExemption(root, config);
  if (rootExempt !== null) {
    if (!allowExemptedRoot) {
      err(`T3 发布安全扫描：扫描根位于豁免路径内（豁免 ${rootExempt.path}；判定=扫描根绝对路径包含该段序列，任意嵌套从严）——未扫描 ≠ 干净（exit 2）；如确需以此根扫描（如夹具自检），加 --allow-exempted-root 显式放行`);
      return 2;
    }
    out(`T3 发布安全扫描：--allow-exempted-root 已放行豁免根（${rootExempt.path}：${rootExempt.reason}）——继续扫描`);
  }
  // 扫描执行异常（不可读目录 / 非法正则配置 / root 为文件等）不得落入 exit 1（命中）语义——未扫描 ≠ 干净
  let findings: ScanFinding[];
  const stats: ScanStats = { binarySkipped: 0, unreadableSkipped: 0 };
  try {
    findings = scanForRelease(root, config, stats);
  } catch (e) {
    err(`T3 发布安全扫描：扫描执行异常——未扫描 ≠ 干净（exit 2）：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  out(`T3 发布安全扫描：${root}（清单 ${config.secretPatterns.length} 密钥正则 / ${config.weightExtensions.length} 扩展名 / ${config.weightMagics.length} 魔数 / safetensors 嗅探 ${config.sniffSafetensors ? 'on' : 'off'} / 豁免 ${config.exemptions.length} 项 / 二进制残余 ${stats.binarySkipped} 个文件 / 不可读 ${stats.unreadableSkipped} 个文件）`);
  out(formatFindings(findings));
  // 批次四 P2-1：不可读（EACCES 等）= 应扫而未扫 ≠ 干净——exit 2（单列计数可观测，扫描不中断但终判不放过）
  if (stats.unreadableSkipped > 0) {
    err(`T3 发布安全扫描：${stats.unreadableSkipped} 个文件不可读（EACCES 等）——应扫而未扫 ≠ 干净（exit 2）`);
    return 2;
  }
  return findings.length === 0 ? 0 : 1;
}

// CLI 入口
if (process.argv[1] && /release[-_]?scan\.js$/i.test(process.argv[1])) {
  process.exit(runReleaseScanCli(process.argv.slice(2)));
}
