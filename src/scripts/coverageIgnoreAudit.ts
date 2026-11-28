import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// v8 ignore 登记面机械审计（TASK-317 每日优化第六十八批）：
// 仓库内以「v8 ignore next」注解移出覆盖率分母的语句，此前只靠人工对账 coverage-final.json 核对
// 「被移出语句确实 hits=0」。本脚本把对账固化为可重复执行的中和复跑：
//   1. 发现：扫描 src/**/*.ts 内全部 v8 ignore 注解（独立成行与内联两种形态）；
//   2. 双跑：正常口径（仓库现状）与中和口径（注解等长置空后于仓库根内临时副本复跑）各跑一次 vitest；
//   3. 对账：I1 removed 非空且每条 hits=0 / I2 两口径 covered 相等 / I3 无孤儿注解 / I4 removed 起点落在注解 span 内。
// 算法黑盒化：不依赖 ast-v8-to-istanbul 或 vitest 覆盖率内部 API，只消费 coverage-final.json 与 JSON reporter 两个公开产物。
// exit 码三元组：通过=0 / 违例=1 / 无法审计=2（含中和树构造失败、vitest 未产出 coverage、用例数不一致等）。
// 自身不进 npm test（避免全量双跑拖慢常规门）：npm run build 后执行 npm run coverage-ignore-audit。

// ─── 词法扫描（注释 / 字符串 / 模板 / 正则；仅供注释发现与语句 span 求取，非完整解析器） ───

export type TokenKind = 'comment' | 'word' | 'string' | 'template' | 'regex' | 'punct';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
}

const WORD_CHAR = /[A-Za-z_$0-9\u0080-\uffff]/;
// 其后出现的 `/` 必为正则字面量起点的关键字（其余 word 后为除法）
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'case', 'yield', 'await', 'throw']);

function skipString(text: string, start: number): number {
  const quote = text[start];
  let j = start + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === '\n') return j; // 未闭合字符串：遇行尾止损（本身就是语法错误，交由 vitest 报错）
    j++;
  }
  return text.length;
}

function skipTemplateExpr(text: string, start: number): number {
  let depth = 1;
  let j = start;
  while (j < text.length) {
    const c = text[j];
    if (c === "'" || c === '"') {
      j = skipString(text, j);
      continue;
    }
    if (c === '`') {
      j = skipTemplate(text, j);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return text.length;
}

function skipTemplate(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') return j + 1;
    if (c === '$' && text[j + 1] === '{') {
      j = skipTemplateExpr(text, j + 2);
      continue;
    }
    j++;
  }
  return text.length;
}

function skipRegex(text: string, start: number): number {
  let inClass = false;
  let j = start + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n') return start + 1; // 误判为除法：回退为单字符 `/`
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j]!)) j++;
      return j;
    }
    j++;
  }
  return text.length;
}

/** 轻量词法扫描：跳过空白，产出注释、word、字符串、模板、正则与单字符标点 token（按出现顺序） */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let regexAllowed = true;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number): void => {
    tokens.push({ kind, start, end, text: text.slice(start, end) });
  };
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n') j++;
      push('comment', i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      push('comment', i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = skipString(text, i);
      push('string', i, end);
      i = end;
      regexAllowed = false;
      continue;
    }
    if (c === '`') {
      const end = skipTemplate(text, i);
      push('template', i, end);
      i = end;
      regexAllowed = false;
      continue;
    }
    if (c === '/' && regexAllowed) {
      const end = skipRegex(text, i);
      push('regex', i, end);
      i = end;
      regexAllowed = false;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (WORD_CHAR.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(text[j]!)) j++;
      push('word', i, j);
      regexAllowed = REGEX_KEYWORDS.has(text.slice(i, j));
      i = j;
      continue;
    }
    push('punct', i, i + 1);
    regexAllowed = !(c === ')' || c === ']');
    i++;
  }
  return tokens;
}

// ─── 位置换算 ───

export interface Pos {
  /** 1 基行号（与 coverage-final.json 一致） */
  line: number;
  /** 0 基列号（与 coverage-final.json 一致） */
  col: number;
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

export function posAt(lineStarts: number[], offset: number): Pos {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - lineStarts[lo]! };
}

export function comparePos(a: Pos, b: Pos): number {
  return a.line - b.line || a.col - b.col;
}

const formatPos = (file: string, p: Pos): string => `${file}:${p.line}:${p.col}`;

// ─── 注解发现 ───

export type IgnoreKind = 'next' | 'start' | 'stop' | 'file';

export interface IgnoreDirective {
  file: string;
  kind: IgnoreKind;
  /** 注解注释的起止偏移（相对源码文本） */
  start: number;
  end: number;
  /** 注释起点位置 */
  at: Pos;
  /** 说明行 TASK-xxx: 前缀后的类别；无说明行为空串 */
  category: string;
  /** next 恒为 true；start/stop 已配对为 true，落单为 false */
  paired: boolean;
  /** 作用 span（next：注解结束后首个语句；start：start 结束至 stop 起点）；落单时为 null */
  spanStart: Pos | null;
  spanEnd: Pos | null;
}

// 以转义片段拼装：本文件源码中不得出现可被自身扫描命中的注解字面
const DIRECTIVE_RE = new RegExp('^/\\*\\s*v8\\s+ignore\\s+(next|start|stop|file)\\s*\\*/$');
const CATEGORY_RE = /TASK-\d+:\s*([^·\r\n]*?)(?:\s*·|\s*$)/;

/** 注解结束后首个语句的结束偏移（深度 0 的 `;`，或深度将转负的闭合括号之前；无分号时延至下一个 `;`） */
function statementSpanEnd(text: string, tokens: Token[], from: number): number {
  let depth = 0;
  for (const t of tokens) {
    if (t.kind !== 'punct' || t.end <= from) continue;
    const c = t.text;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return t.start;
      depth--;
    } else if (c === ';' && depth === 0) return t.end;
  }
  return text.length;
}

/** 说明行类别：向上回看邻近注释（相邻注释行距 ≤ 8 行——内联形态的说明行可隔 if 链臂数行代码）中最近的 `TASK-xxx: <类别> · …` 行 */
const INLINE_LOOKBACK_LINES = 8;
function categoryOf(comments: Token[], index: number, lineOf: (offset: number) => number): string {
  for (let i = index - 1; i >= 0; i--) {
    if (lineOf(comments[i]!.end) < lineOf(comments[i + 1]!.start) - INLINE_LOOKBACK_LINES) break; // 说明行不在邻近范围
    const m = CATEGORY_RE.exec(comments[i]!.text);
    if (m) return m[1]!.trim();
  }
  return '';
}

/** 扫描单个源码文本内的全部 v8 ignore 注解（纯函数）；已配对的 stop 并入对应 start，不单列 */
export function findIgnoreDirectives(text: string, file = ''): IgnoreDirective[] {
  const tokens = tokenize(text);
  const lineStarts = lineStartsOf(text);
  const comments = tokens.filter((t) => t.kind === 'comment');
  const found: Array<{ tok: Token; kind: IgnoreKind }> = [];
  comments.forEach((tok) => {
    const m = DIRECTIVE_RE.exec(tok.text);
    if (m) found.push({ tok, kind: m[1] as IgnoreKind });
  });
  // start/stop 配对（就近配对）
  const stops = new Map<Token, Token>();
  const pairedStops = new Set<Token>();
  for (let i = 0; i < found.length; i++) {
    if (found[i]!.kind !== 'start') continue;
    const stop = found.slice(i + 1).find((x) => x.kind === 'stop' && !pairedStops.has(x.tok));
    if (stop) {
      stops.set(found[i]!.tok, stop.tok);
      pairedStops.add(stop.tok);
    }
  }
  const at = (offset: number): Pos => posAt(lineStarts, offset);
  const lineOf = (offset: number): number => at(offset).line;
  return found
    .filter((d) => !(d.kind === 'stop' && pairedStops.has(d.tok)))
    .map((d): IgnoreDirective => {
      const stop = stops.get(d.tok) ?? null;
      const isNext = d.kind === 'next';
      return {
        file,
        kind: d.kind,
        start: d.tok.start,
        end: d.tok.end,
        at: at(d.tok.start),
        category: categoryOf(comments, comments.indexOf(d.tok), lineOf),
        paired: d.kind !== 'start' && d.kind !== 'stop' ? true : stop !== null,
        spanStart: isNext || stop ? at(d.tok.end) : null,
        spanEnd: isNext ? at(statementSpanEnd(text, tokens, d.tok.end)) : stop ? at(stop.start) : null,
      };
    });
}

// ─── 中和 ───

/** 把每条注解替换为等长空注释（file:line:col 不漂移）；纯函数 */
export function neutralizeSource(text: string, directives: IgnoreDirective[]): string {
  const chars = text.split('');
  for (const d of directives) {
    for (let i = d.start + 2; i < d.end - 2; i++) chars[i] = ' ';
  }
  return chars.join('');
}

// ─── 覆盖率快照 ───

/** 列数据：键 = 起点 `line:col`（branches 另附 `#序号`），值 = hits */
export type ColumnData = Record<string, number>;

export interface FileCoverage {
  statements: ColumnData;
  branches: ColumnData;
  functions: ColumnData;
  lines: ColumnData;
}

export interface CoverageSnapshot {
  /** 键 = 相对根的正斜杠路径 */
  files: Record<string, FileCoverage>;
}

interface IstanbulPos {
  line: number;
  column?: number;
}

interface IstanbulRange {
  start: IstanbulPos;
  end: IstanbulPos;
}

/** istanbul 文件级覆盖（vitest v8 provider 实产物无 lineMap/l 列，故各列均可缺省） */
interface IstanbulFileCoverage {
  statementMap?: Record<string, IstanbulRange>;
  s?: Record<string, number>;
  fnMap?: Record<string, { decl: IstanbulRange }>;
  f?: Record<string, number>;
  branchMap?: Record<string, { locations?: IstanbulRange[] }>;
  b?: Record<string, number[]>;
  lineMap?: Record<string, Pick<IstanbulRange, 'start'>>;
  l?: Record<string, number>;
}

const toPosKey = (p: IstanbulPos): string => `${p.line}:${p.column ?? 0}`;

function mapColumn<T>(map: Record<string, T> | undefined, keysOf: (entry: T) => string[], hits: Record<string, number | number[]> | undefined): ColumnData {
  const out: ColumnData = {};
  for (const [id, entry] of Object.entries(map ?? {})) {
    const counts = hits?.[id];
    keysOf(entry).forEach((key, i) => {
      out[key] = Array.isArray(counts) ? counts[i] ?? 0 : counts ?? 0;
    });
  }
  return out;
}

const toRel = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** 从 coverage-final.json（istanbul 格式）构造快照；纯函数 */
export function coverageSnapshotFromIstanbul(json: unknown, root: string): CoverageSnapshot {
  const files: Record<string, FileCoverage> = {};
  for (const [abs, raw] of Object.entries(json as Record<string, IstanbulFileCoverage>)) {
    files[toRel(root, abs)] = {
      statements: mapColumn(raw.statementMap, (r) => [toPosKey(r.start)], raw.s),
      branches: mapColumn(raw.branchMap, (b) => (b.locations ?? []).map((l, i) => `${toPosKey(l.start)}#${i}`), raw.b),
      functions: mapColumn(raw.fnMap, (f) => [toPosKey(f.decl.start)], raw.f),
      lines: mapColumn(raw.lineMap, (l) => [toPosKey(l.start)], raw.l),
    };
  }
  return { files };
}

export function totalOf(snapshot: CoverageSnapshot, column: keyof FileCoverage): { total: number; covered: number } {
  let total = 0;
  let covered = 0;
  for (const file of Object.values(snapshot.files)) {
    for (const hits of Object.values(file[column])) {
      total++;
      if (hits > 0) covered++;
    }
  }
  return { total, covered };
}

export interface RemovedEntry {
  file: string;
  key: string;
  hits: number;
}

/** 中和口径有、正常口径无的条目（按文件 + 起点键） */
export function removedEntries(normal: CoverageSnapshot, neutral: CoverageSnapshot, column: keyof FileCoverage): RemovedEntry[] {
  const removed: RemovedEntry[] = [];
  for (const [file, data] of Object.entries(neutral.files)) {
    const baseline = normal.files[file]?.[column] ?? {};
    for (const [key, hits] of Object.entries(data[column])) {
      if (!(key in baseline)) removed.push({ file, key, hits });
    }
  }
  return removed;
}

// ─── 对账 ───

export interface AuditInput {
  normal: CoverageSnapshot;
  neutral: CoverageSnapshot;
  directives: IgnoreDirective[];
}

export interface Violation {
  invariant: 'I1' | 'I2' | 'I3' | 'I4';
  message: string;
}

export interface AuditRow {
  directive: IgnoreDirective;
  removed: RemovedEntry[];
  /** span 内被移出语句在中和口径下的最大 hits */
  maxHits: number;
}

export interface ColumnDisclosure {
  /** 中和口径下该列条目总数为 0 时表示产物无该列（如 vitest v8 provider 实产物无 lineMap） */
  present: boolean;
  removed: number;
  withHits: number;
}

export interface AuditResult {
  violations: Violation[];
  rows: AuditRow[];
  summary: {
    directives: number;
    removed: number;
    normal: { total: number; covered: number };
    neutral: { total: number; covered: number };
  };
  disclosure: Record<'branches' | 'functions' | 'lines', ColumnDisclosure>;
}

const posOfKey = (key: string): Pos => {
  const [line, col] = key.split('#')[0]!.split(':');
  return { line: Number(line), col: Number(col) };
};

const withinSpan = (pos: Pos, d: IgnoreDirective): boolean =>
  d.spanStart !== null && d.spanEnd !== null && comparePos(pos, d.spanStart) >= 0 && comparePos(pos, d.spanEnd) < 0;

/** I1–I4 对账（纯函数）：任一不成立即列入 violations */
export function reconcileAudit(input: AuditInput): AuditResult {
  const { normal, neutral, directives } = input;
  const removed = removedEntries(normal, neutral, 'statements');
  const violations: Violation[] = [];
  if (removed.length === 0) {
    violations.push({ invariant: 'I1', message: 'removed 为空：注解未移出任何语句' });
  }
  for (const r of removed) {
    if (r.hits > 0) violations.push({ invariant: 'I1', message: `${formatPos(r.file, posOfKey(r.key))} 中和口径 hits=${r.hits}（注解落在可达语句上）` });
  }
  const normalCovered = totalOf(normal, 'statements');
  const neutralCovered = totalOf(neutral, 'statements');
  if (normalCovered.covered !== neutralCovered.covered) {
    violations.push({ invariant: 'I2', message: `两口径 covered 不等：正常 ${normalCovered.covered} / 中和 ${neutralCovered.covered}` });
  }
  const rows = directives.map((d) => {
    const inSpan = removed.filter((r) => r.file === d.file && withinSpan(posOfKey(r.key), d));
    return { directive: d, removed: inSpan, maxHits: Math.max(0, ...inSpan.map((r) => r.hits)) };
  });
  for (const { directive: d, removed: inSpan } of rows) {
    const where = formatPos(d.file, d.at);
    if (!d.paired) violations.push({ invariant: 'I3', message: `${where} ${d.kind} 注解未配对` });
    else if (!(d.file in neutral.files)) violations.push({ invariant: 'I3', message: `${where} 注解所在文件不在中和口径覆盖率报告内（include 面外或未被加载）` });
    else if (inSpan.length === 0) violations.push({ invariant: 'I3', message: `${where} 孤儿注解：作用 span 内无被移出语句（位置失效）` });
  }
  for (const r of removed) {
    const pos = posOfKey(r.key);
    if (!directives.some((d) => d.file === r.file && withinSpan(pos, d))) {
      violations.push({ invariant: 'I4', message: `${formatPos(r.file, pos)} 被移出语句起点不在任何注解作用 span 内` });
    }
  }
  const disclose = (column: 'branches' | 'functions' | 'lines'): ColumnDisclosure => {
    const entries = removedEntries(normal, neutral, column);
    return { present: totalOf(neutral, column).total > 0, removed: entries.length, withHits: entries.filter((e) => e.hits > 0).length };
  };
  return {
    violations,
    rows,
    summary: {
      directives: directives.length,
      removed: removed.length,
      normal: normalCovered,
      neutral: neutralCovered,
    },
    disclosure: { branches: disclose('branches'), functions: disclose('functions'), lines: disclose('lines') },
  };
}

// ─── 报表 ───

export interface ReportHeader {
  repoRoot: string;
  files: number;
  tests: { normal: string; neutral: string };
}

export function formatAuditReport(result: AuditResult, header: ReportHeader): string {
  const { summary: s } = result;
  const lines = [
    `v8 ignore 审计：仓库根 ${header.repoRoot}；发现注解 ${s.directives} 条（${header.files} 文件）`,
    `正常口径：statements ${s.normal.total}/${s.normal.covered}（total/covered）；用例 ${header.tests.normal}`,
    `中和口径：statements ${s.neutral.total}/${s.neutral.covered}（total/covered）；用例 ${header.tests.neutral}`,
    '',
    '| 注解定位 | 类别 | 移出语句数 | 中和口径 hits | 移出语句 |',
    '|---|---|---|---|---|',
  ];
  for (const { directive: d, removed, maxHits } of result.rows) {
    const where = removed.map((r) => `L${r.key.split('#')[0]}`).join(' ');
    lines.push(`| ${formatPos(d.file, d.at)} (${d.kind}) | ${d.category || '（无 TASK 说明行）'} | ${removed.length} | ${maxHits} | ${where} |`);
  }
  const dis = result.disclosure;
  const cell = (c: ColumnDisclosure): string => (c.present ? `移出 ${c.removed}（hits>0：${c.withHits}）` : 'n/a（产物无该列）');
  lines.push('');
  lines.push(`披露（不计入 exit 码）：branches ${cell(dis.branches)} / functions ${cell(dis.functions)} / lines ${cell(dis.lines)}`);
  if (result.violations.length > 0) {
    lines.push('违例：');
    for (const v of result.violations) lines.push(`- [${v.invariant}] ${v.message}`);
  }
  lines.push(
    result.violations.length === 0
      ? `PASS：I1–I4 全部成立（${s.directives} 注解 / ${s.removed} 语句；两口径 covered ${s.normal.covered} = ${s.neutral.covered}）`
      : `FAIL：${result.violations.length} 条违例（${s.directives} 注解 / ${s.removed} 语句；两口径 total·covered 正常 ${s.normal.total}·${s.normal.covered} / 中和 ${s.neutral.total}·${s.neutral.covered}）`,
  );
  return lines.join('\n');
}

// ─── 中和树 ───

// 不复制的条目：依赖/构建/产物/本地状态目录（靠向上解析命中仓库 node_modules；禁 junction/符号链接，遇链接条目跳过）
const SKIP_ENTRIES = new Set(['node_modules', '.git', 'dist', 'coverage', 'data', 'traces', 'experiment-runs', '.dsh', '.multica', '.claude']);

export function copyTreeForNeutral(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name) || entry.isSymbolicLink()) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyTreeForNeutral(src, dest);
    } else {
      copyFileSync(src, dest);
    }
  }
}

export interface DiscoveredFile {
  file: string;
  text: string;
  directives: IgnoreDirective[];
}

function listSourceFiles(dir: string, prefix: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listSourceFiles(path.join(dir, entry.name), rel, out);
    else if (entry.name.endsWith('.ts') && !entry.isSymbolicLink()) out.push(rel); // 符号链接条目不跟随
  }
  return out;
}

/** 扫描 src 下全部 .ts 文件（递归）的注解；含注解文件须为可无损往返解码的 UTF-8（否则抛错 → 无法审计） */
export function discoverDirectives(repoRoot: string): DiscoveredFile[] {
  const srcRoot = path.join(repoRoot, 'src');
  if (!existsSync(srcRoot)) throw new Error(`src 目录不存在：${srcRoot}`);
  return listSourceFiles(srcRoot, '', [])
    .map((file) => {
      const bytes = readFileSync(path.join(srcRoot, file));
      const text = bytes.toString('utf8');
      const directives = findIgnoreDirectives(text, `src/${file}`);
      if (directives.length > 0 && !Buffer.from(text, 'utf8').equals(bytes)) {
        throw new Error(`src/${file} 含非 UTF-8 字节序列，等长中和无法保证字节无损`);
      }
      return { file: `src/${file}`, text, directives };
    })
    .filter((d) => d.directives.length > 0);
}

// ─── vitest 双跑 ───

export interface VitestRunRequest {
  phase: 'normal' | 'neutral';
  cwd: string;
  reportsDir: string;
  outputFile: string;
}

export interface VitestRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface AuditDeps {
  runVitest: (req: VitestRunRequest) => VitestRunResult;
  copyTree: (from: string, to: string) => void;
}

interface VitestJson {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: unknown[];
}

/** 真实 vitest 复跑：仅用 CLI 公开参数（JSON reporter + json 覆盖率；全局 statements 门置 0——门禁是 npm test 的职责，审计只比对裸数据） */
export function spawnVitest(vitestBin: string, req: VitestRunRequest): VitestRunResult {
  const args = [
    vitestBin,
    'run',
    '--coverage.enabled=true',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${req.reportsDir}`,
    '--coverage.thresholds.statements=0',
    '--reporter=json',
    `--outputFile=${req.outputFile}`,
  ];
  const r = spawnSync(process.execPath, args, { cwd: req.cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

const tailOf = (s: string): string => (s.length > 1500 ? `…${s.slice(-1500)}` : s);

// ─── CLI ───

export interface CliRunOptions {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** 可注入：单测以合成 coverage 替代真实双跑 / 模拟中和树构造失败 */
  deps?: Partial<AuditDeps>;
}

interface RunOutcome {
  snapshot: CoverageSnapshot;
  tests: string;
}

export function runCoverageIgnoreAuditCli(argv: string[], opts: CliRunOptions = {}): number {
  const out = opts.stdout ?? console.log;
  const err = opts.stderr ?? console.error;
  const repoRoot = path.resolve(opts.cwd ?? process.cwd(), argv.filter((a) => !a.startsWith('--'))[0] ?? '.');
  for (const f of argv.filter((a) => a.startsWith('--'))) err(`v8 ignore 审计：未识别参数 ${f}（本脚本不接受 flag）`);
  const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const deps: AuditDeps = {
    runVitest: opts.deps?.runVitest ?? ((req) => spawnVitest(vitestBin, req)),
    copyTree: opts.deps?.copyTree ?? copyTreeForNeutral,
  };
  const auditRoot = path.join(repoRoot, 'coverage', 'ignore-audit');
  const tree = path.join(auditRoot, 'neutral-tree');
  const neutralReports = path.join(auditRoot, 'neutral');
  const normalReports = path.join(auditRoot, 'normal');
  const cannot = (why: string, detail = ''): number => {
    err(`v8 ignore 审计：${why}——无法审计（exit 2）${detail ? `\n${detail}` : ''}`);
    return 2;
  };
  const runPhase = (phase: 'normal' | 'neutral'): RunOutcome | number => {
    const isNormal = phase === 'normal';
    const label = isNormal ? '正常' : '中和';
    const reportsDir = isNormal ? normalReports : neutralReports;
    const cwd = isNormal ? repoRoot : tree;
    const outputFile = path.join(reportsDir, 'vitest.json');
    const r = deps.runVitest({ phase, cwd, reportsDir, outputFile });
    if (r.status !== 0) return cannot(`${label} 口径 vitest 退出码 ${r.status}`, tailOf(`${r.stderr}\n${r.stdout}`.trim()));
    const coverageFile = path.join(reportsDir, 'coverage-final.json');
    if (!existsSync(coverageFile) || !existsSync(outputFile)) return cannot(`${label} 口径 vitest 未产出 coverage-final.json / vitest.json`, tailOf(r.stderr.trim()));
    const report = readJson(outputFile) as VitestJson;
    const failed = report.numFailedTests ?? 0;
    const total = report.numTotalTests ?? 0;
    const passed = report.numPassedTests ?? 0;
    if (failed > 0 || total === 0 || passed !== total) return cannot(`${label} 口径用例未全绿（${passed}/${total}，失败 ${failed}）`, tailOf(r.stderr.trim()));
    try {
      return { snapshot: coverageSnapshotFromIstanbul(readJson(coverageFile), cwd), tests: `${passed}/${total}（文件 ${report.testResults?.length ?? 0}）` };
    } catch (e) {
      // 产物形态异常（非法 JSON 等）不得落入 exit 1（违例）语义——未对账 ≠ 通过
      return cannot(`${label} 口径 coverage 产物解析失败`, e instanceof Error ? e.message : String(e));
    }
  };

  let discovered: DiscoveredFile[];
  try {
    discovered = discoverDirectives(repoRoot);
  } catch (e) {
    return cannot('注解发现失败', e instanceof Error ? e.message : String(e));
  }
  const directives = discovered.flatMap((d) => d.directives);
  if (directives.some((d) => d.kind === 'file')) return cannot('存在整文件级 ignore 注解，登记面无法按语句对账');
  out(`v8 ignore 审计：仓库根 ${repoRoot}；发现注解 ${directives.length} 条（${discovered.length} 文件）`);

  const normal = runPhase('normal');
  if (typeof normal === 'number') return normal;

  let neutral: RunOutcome | number = 2;
  try {
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    deps.copyTree(repoRoot, tree);
    for (const d of discovered) {
      writeFileSync(path.join(tree, d.file), neutralizeSource(d.text, d.directives));
    }
    out(`中和树：${tree}（已等长置空 ${directives.length} 条注解）`);
    neutral = runPhase('neutral');
  } catch (e) {
    neutral = cannot('中和树构造失败', e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(tree, { recursive: true, force: true }); // 成功 / 失败路径同样清理
  }
  if (typeof neutral === 'number') return neutral;

  if (normal.tests !== neutral.tests) {
    return cannot(`两口径用例数不一致（正常 ${normal.tests} / 中和 ${neutral.tests}），对账前提不成立`);
  }
  const result = reconcileAudit({ normal: normal.snapshot, neutral: neutral.snapshot, directives });
  out('');
  out(formatAuditReport(result, { repoRoot, files: discovered.length, tests: { normal: normal.tests, neutral: neutral.tests } }));
  return result.violations.length === 0 ? 0 : 1;
}

// CLI 入口
if (process.argv[1] && /coverage[-_]?ignore[-_]?audit\.js$/i.test(process.argv[1])) {
  process.exit(runCoverageIgnoreAuditCli(process.argv.slice(2)));
}
