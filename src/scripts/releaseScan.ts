import { readdirSync, statSync, readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

// T3 发布安全扫描（A5 §4-3）：已知密钥格式正则 + 模型权重文件检查（扩展名/魔数）。
// 零命中方为通过；命中即拒绝发布（退出码 1）。与开源前置待办（定稿 §11-2）复用同一实现。

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'OpenAI sk- 密钥', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic sk-ant- 密钥', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS AKIA 访问键', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token (ghp_/gho_/ghu_/ghs_)', re: /gh[pous]_[A-Za-z0-9]{36,}/ },
  { name: 'Slack xox 令牌', re: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google AIza 密钥', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: '通用 Bearer 长令牌（可能的私钥/JWT）', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const WEIGHT_EXTENSIONS = new Set(['.gguf', '.safetensors', '.pth', '.pt', '.onnx', '.bin', '.ckpt', '.pb', '.tflite', '.h5']);
const WEIGHT_MAGICS: number[][] = [
  [0x47, 0x47, 0x55, 0x46], // GGUF "GGUF"
  [0x89, 0x48, 0x44, 0x46], // HDF5 (safetensors 常见容器族)
  [0x50, 0x4b, 0x03, 0x04].slice(0, 0), // zip 族过宽，不计
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'traces', 'experiment-runs', '.claude', '.dsh', '.multica']);
const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.json', '.md', '.txt', '.yml', '.yaml', '.example', '.gitignore', '.mjs', '.cjs', '.sql', '.sh', '.ps1', '.html', '.css']);

export interface ScanFinding {
  kind: 'secret' | 'model_weight';
  file: string;
  detail: string;
}

export function scanForRelease(root: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
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
      if (WEIGHT_EXTENSIONS.has(ext)) {
        findings.push({ kind: 'model_weight', file: rel, detail: `模型权重文件扩展名 ${ext}` });
        continue;
      }
      // A5 §4-3 魔数检查（TASK-40 F-4 接通）：无权重扩展名的文件按首 4 字节判定，防改名绕过
      if (hasWeightMagic(file)) {
        findings.push({ kind: 'model_weight', file: rel, detail: '模型权重文件魔数匹配' });
        continue;
      }
      // config.example 中的占位与文档中的示例说明不视为命中（占位值不含真实密钥材料）
      if (TEXT_EXTENSIONS.has(ext) || !ext) {
        const content = readFileSync(file, 'utf8');
        for (const { name, re } of SECRET_PATTERNS) {
          const m = re.exec(content);
          if (m) {
            findings.push({ kind: 'secret', file: rel, detail: `${name}：${m[0].slice(0, 8)}…（位置 ${m.index}）` });
          }
        }
      }
    }
  }
}

function hasWeightMagic(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return WEIGHT_MAGICS.some((magic) => magic.length > 0 && magic.every((b, i) => buf[i] === b));
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

// CLI 入口
if (process.argv[1] && /release[-_]?scan\.js$/i.test(process.argv[1])) {
  const root = process.argv[2] ?? process.cwd();
  const findings = scanForRelease(root);
  console.log(`T3 发布安全扫描：${root}`);
  console.log(formatFindings(findings));
  process.exit(findings.length === 0 ? 0 : 1);
}
