import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  comparePos,
  copyTreeForNeutral,
  coverageSnapshotFromIstanbul,
  discoverDirectives,
  findIgnoreDirectives,
  formatAuditReport,
  lineStartsOf,
  neutralizeSource,
  posAt,
  reconcileAudit,
  removedEntries,
  runCoverageIgnoreAuditCli,
  spawnVitest,
  tokenize,
  totalOf,
  type AuditDeps,
  type CoverageSnapshot,
  type IgnoreDirective,
  type VitestRunRequest,
} from '../src/scripts/coverageIgnoreAudit.js';

// TASK-317：v8 ignore 登记面机械审计——纯函数负例（合成 coverage，禁止真实双跑）+ CLI exit 码三元组（注入 runner）。
// 夹具源码中的注解字面以拼接构造，避免本文件被任何按字面扫描的工具误计（tests/ 不在 include 面内）。
const NEXT = '/* v8 ignore next */';
const SRC = [
  'export function f(x: number): number {',
  '  // TASK-999: 测试类别 · 说明文字',
  `  ${NEXT}`,
  "  throw new Error('unreachable');",
  '  // TASK-999: 内联类别 · 说明',
  `  if (x) ${NEXT} return x;`,
  `  const s = \`a\${x}b${NEXT}c\`;`,
  `  const t = '${NEXT}';`,
  '  const r = /x\\/*y[/]"q/g;',
  '  return x;',
  '}',
].join('\n');

function tmpTree(): string {
  return mkdtempSync(path.join(tmpdir(), 't317-'));
}

/** 合成快照：每列为 `line:col` → hits */
function snapshot(files: Record<string, Partial<Record<'statements' | 'branches' | 'functions' | 'lines', Record<string, number>>>>): CoverageSnapshot {
  const out: CoverageSnapshot = { files: {} };
  for (const [file, cols] of Object.entries(files)) {
    out.files[file] = {
      statements: cols.statements ?? {},
      branches: cols.branches ?? {},
      functions: cols.functions ?? {},
      lines: cols.lines ?? {},
    };
  }
  return out;
}

const directiveOf = (text: string, line: number): IgnoreDirective => {
  const d = findIgnoreDirectives(text, 'src/a.ts').find((x) => x.at.line === line);
  if (!d) throw new Error(`夹具未发现 L${line} 注解`);
  return d;
};

describe('词法扫描：注释只在注释位被发现（字符串 / 模板 / 正则内的字面不算）', () => {
  it('两种形态（独立成行 + 内联）均发现；字符串与模板字面内的注解字面不计', () => {
    const d = findIgnoreDirectives(SRC, 'src/a.ts');
    expect(d.map((x) => [x.at.line, x.at.col, x.kind])).toEqual([
      [3, 2, 'next'],
      [6, 9, 'next'],
    ]);
    expect(d.every((x) => x.file === 'src/a.ts')).toBe(true);
  });

  it('说明行类别取 TASK-xxx: 前缀后的类别；无说明行为空串', () => {
    expect(directiveOf(SRC, 3).category).toBe('测试类别');
    expect(directiveOf(SRC, 6).category).toBe('内联类别');
    expect(findIgnoreDirectives(`${NEXT}\nfoo();`)[0]!.category).toBe('');
  });

  it('正则字面量内的 /* 与引号不打断扫描；模板表达式内的嵌套引号被整体跳过', () => {
    const comments = tokenize(SRC).filter((t) => t.kind === 'comment');
    expect(comments.map((c) => c.text)).toEqual(['// TASK-999: 测试类别 · 说明文字', NEXT, '// TASK-999: 内联类别 · 说明', NEXT]);
    const kinds = tokenize('const a = `x${ `y${"z"}` }w`; const b = 1;').map((t) => t.kind);
    expect(kinds).not.toContain('comment');
  });

  it('边界：未闭合块注释 / 未闭合字符串遇行尾止损 / 正则误判回退为单字符除号', () => {
    expect(tokenize('a; /* 未闭合').filter((t) => t.kind === 'comment')).toHaveLength(1);
    expect(tokenize("a = 'x\nb = 2 // c").filter((t) => t.kind === 'comment')).toHaveLength(1);
    expect(tokenize('return /[/]*/g;\nx').map((t) => t.kind)).toEqual(['word', 'regex', 'punct', 'word']);
    expect(tokenize('a / b\n/ c').map((t) => t.text)).toEqual(['a', '/', 'b', '/', 'c']);
    expect(tokenize('return /a\nb/;').slice(0, 3).map((t) => [t.kind, t.text])).toEqual([['word', 'return'], ['regex', '/'], ['word', 'a']]);
  });

  it('边界：各类字面量的转义与未闭合止损（EOF）均不吞掉后续注释', () => {
    const kinds = (s: string): string[] => tokenize(s).map((t) => t.kind);
    expect(kinds("x = 'a\\'b'; y = \"q\\\"r\"; // c")).toEqual(['word', 'punct', 'string', 'punct', 'word', 'punct', 'string', 'punct', 'comment']);
    expect(kinds("'abc")).toEqual(['string']);
    expect(kinds('`a\\`b${ "q" }c${ { k: 1 }.k }d` // e')).toEqual(['template', 'comment']);
    expect(kinds('`a${ `x${ 1 }y` }b')).toEqual(['template']);
    expect(kinds('`abc')).toEqual(['template']);
    expect(kinds('`a${ x')).toEqual(['template']);
    expect(kinds('return /a\\/*b/ // c')).toEqual(['word', 'regex', 'comment']);
    expect(kinds('return /ab')).toEqual(['word', 'regex']);
  });
});

describe('作用 span：next = 注解结束后首个语句；start/stop 就近配对', () => {
  it('next 的 span 起点 = 注解结束，终点 = 首个语句结束（深度 0 的分号）', () => {
    const d = directiveOf(SRC, 3);
    expect(d.paired).toBe(true);
    expect([d.spanStart, d.spanEnd]).toEqual([
      { line: 3, col: 22 },
      { line: 4, col: 33 },
    ]);
  });

  it('内联于箭头函数参数前：span 终点在深度转负的闭合括号之前', () => {
    const d = directiveOf(`const i = arr.findIndex(${NEXT} (c) => c.id === id);\nfoo();`, 1);
    expect(d.spanStart).toEqual({ line: 1, col: 44 });
    expect(d.spanEnd).toEqual({ line: 1, col: 63 });
  });

  it('start/stop 配对并入 start（stop 不单列）；落单 start / stop 均 paired=false 且无 span', () => {
    const paired = findIgnoreDirectives(`/* v8 ignore start */\nfoo();\n/* v8 ignore stop */\nbar();\n/* v8 ignore stop */\nbaz();\n/* v8 ignore start */\nqux();`);
    expect(paired.map((x) => [x.kind, x.paired, x.at.line])).toEqual([
      ['start', true, 1],
      ['stop', false, 5],
      ['start', false, 7],
    ]);
    expect([paired[0]!.spanStart, paired[0]!.spanEnd]).toEqual([
      { line: 1, col: 21 },
      { line: 3, col: 0 },
    ]);
    expect(paired[1]!.spanStart).toBeNull();
    expect(paired[1]!.spanEnd).toBeNull();
  });

  it('file 级注解被识别为 file（由 CLI 判无法审计）', () => {
    const d = findIgnoreDirectives(`${'/* v8 ignore file */'}\nfoo();`);
    expect(d.map((x) => x.kind)).toEqual(['file']);
    expect(d[0]!.paired).toBe(true);
  });

  it('next 后语句无分号且直到 EOF：span 延至文本末尾；说明行隔空行远于回看窗口 → 类别为空', () => {
    const d = directiveOf(`// TASK-1: 远处类别 · 说明\n${'\n'.repeat(10)}${NEXT}\nfoo()`, 12);
    expect(d.category).toBe('');
    expect(d.spanEnd).toEqual({ line: 13, col: 5 });
  });
});

describe('位置换算', () => {
  it('lineStartsOf / posAt / comparePos：1 基行、0 基列，与 coverage-final.json 口径一致', () => {
    const text = 'ab\ncd\r\nef';
    const starts = lineStartsOf(text);
    expect(starts).toEqual([0, 3, 7]);
    expect(posAt(starts, 0)).toEqual({ line: 1, col: 0 });
    expect(posAt(starts, 4)).toEqual({ line: 2, col: 1 });
    expect(posAt(starts, 8)).toEqual({ line: 3, col: 1 });
    expect(comparePos({ line: 2, col: 9 }, { line: 3, col: 0 })).toBeLessThan(0);
    expect(comparePos({ line: 2, col: 9 }, { line: 2, col: 9 })).toBe(0);
  });
});

describe('⑤ 等长中和：file:line:col 不漂移', () => {
  it('长度相等、注解外字符逐位不变、行数不变、中和后再扫描为 0 条', () => {
    const directives = findIgnoreDirectives(SRC);
    const neutral = neutralizeSource(SRC, directives);
    expect(neutral.length).toBe(SRC.length);
    expect(neutral.split('\n').length).toBe(SRC.split('\n').length);
    expect(findIgnoreDirectives(neutral)).toEqual([]);
    directives.forEach((d, i) => {
      const blank = `/*${' '.repeat(d.end - d.start - 4)}*/`;
      expect(neutral.slice(d.start, d.end)).toBe(blank);
      expect(SRC.slice(d.end, directives[i + 1]?.start ?? SRC.length)).toBe(neutral.slice(d.end, directives[i + 1]?.start ?? SRC.length));
    });
    expect(neutral).toContain("  throw new Error('unreachable');");
    expect(neutral.split('v8 ignore next')).toHaveLength(3); // 仅余模板字面与字符串内的 2 处字面
  });

  it('中和后非注解 token 位置逐位不变', () => {
    const directives = findIgnoreDirectives(SRC);
    const before = tokenize(SRC).filter((t) => t.kind !== 'comment');
    const after = tokenize(neutralizeSource(SRC, directives)).filter((t) => t.kind !== 'comment');
    expect(after).toEqual(before);
  });
});

describe('coverage-final.json → 快照', () => {
  it('绝对路径归一为相对根的正斜杠路径；四列按起点键入表；branches 展开为 `line:col#i`', () => {
    const abs = path.join('C:\\repo-root', 'src', 'modules', 'a.ts');
    const snap = coverageSnapshotFromIstanbul(
      {
        [abs]: {
          statementMap: { s0: { start: { line: 1, column: 0 }, end: { line: 1, column: null } } },
          s: { s0: 3 },
          fnMap: { f0: { decl: { start: { line: 5, column: 2 }, end: { line: 9, column: null } } } },
          f: {},
          branchMap: { b0: { locations: [{ start: { line: 7, column: 4 } }, { start: { line: 7, column: 10 } }] } },
          b: { b0: [1] },
          lineMap: { l0: { start: { line: 1 } } },
          l: { l0: 2 },
        },
      },
      'C:\\repo-root',
    );
    expect(Object.keys(snap.files)).toEqual(['src/modules/a.ts']);
    expect(snap.files['src/modules/a.ts']).toEqual({
      statements: { '1:0': 3 },
      functions: { '5:2': 0 },
      branches: { '7:4#0': 1, '7:10#1': 0 },
      lines: { '1:0': 2 },
    });
    expect(totalOf(snap, 'statements')).toEqual({ total: 1, covered: 1 });
  });

  it('vitest v8 provider 实产物形态（无 lineMap/l；分支可无 locations；函数无 hits）→ 缺省列落空表而非抛错', () => {
    const snap = coverageSnapshotFromIstanbul(
      {
        [path.join('/r', 'a.ts')]: {
          statementMap: { s0: { start: { line: 3, column: 4 }, end: { line: 3, column: null } } },
          s: { s0: 1 },
          branchMap: { b0: { loc: { start: { line: 3, column: 4 } }, type: 'binary-expr' } },
          fnMap: { f0: { name: 'g', decl: { start: { line: 1, column: 0 } } } },
        },
      },
      '/r',
    );
    expect(snap.files['a.ts']).toEqual({ statements: { '3:4': 1 }, branches: {}, functions: { '1:0': 0 }, lines: {} });
  });
});

describe('对账不变式 I1–I4（合成数据）', () => {
  const dir = directiveOf(SRC, 3); // L3 注解，span 覆盖 L4 throw 语句
  const normal = snapshot({ 'src/a.ts': { statements: { '1:0': 1, '10:0': 1 } } });
  const neutralOk = snapshot({ 'src/a.ts': { statements: { '1:0': 1, '4:2': 0, '10:0': 1 }, lines: { '4:2': 0 }, branches: { '6:9#0': 1 } } });

  it('④ 正常数据 → 通过：1 注解 / 1 语句，covered 两口径相等，披露列计入输出', () => {
    const r = reconcileAudit({ normal, neutral: neutralOk, directives: [dir] });
    expect(r.violations).toEqual([]);
    expect(r.summary).toEqual({
      directives: 1,
      removed: 1,
      normal: { total: 2, covered: 2 },
      neutral: { total: 3, covered: 2 },
    });
    expect(r.rows[0]!.removed.map((x) => x.key)).toEqual(['4:2']);
    expect(r.disclosure).toEqual({
      branches: { present: true, removed: 1, withHits: 1 },
      functions: { present: false, removed: 0, withHits: 0 }, // 快照无 functions 列 → present=false
      lines: { present: true, removed: 1, withHits: 0 },
    });
    expect(removedEntries(normal, neutralOk, 'statements').map((x) => [x.file, x.key, x.hits])).toEqual([['src/a.ts', '4:2', 0]]);
  });

  it('① 被移出语句 hits>0 → I1 违例（定位到语句起点；同时触发 I2）', () => {
    const neutral = snapshot({ 'src/a.ts': { statements: { '1:0': 1, '4:2': 7, '10:0': 1 } } });
    const r = reconcileAudit({ normal, neutral, directives: [dir] });
    expect(r.violations).toEqual([
      { invariant: 'I1', message: 'src/a.ts:4:2 中和口径 hits=7（注解落在可达语句上）' },
      { invariant: 'I2', message: '两口径 covered 不等：正常 2 / 中和 3' }, // hits>0 必然抬高中和口径 covered
    ]);
    expect(r.rows[0]!.maxHits).toBe(7);
  });

  it('② 孤儿注解（span 内无被移出语句）→ I3 违例', () => {
    const r = reconcileAudit({ normal, neutral: neutralOk, directives: [directiveOf(SRC, 6)] });
    expect(r.violations.map((v) => v.invariant)).toEqual(['I3', 'I4']);
    expect(r.violations[0]!.message).toContain('src/a.ts:6:9 孤儿注解');
  });

  it('③ 两口径 covered 不等 → I2 违例', () => {
    const neutral = snapshot({ 'src/a.ts': { statements: { '1:0': 1, '4:2': 0, '10:0': 0 } } });
    const r = reconcileAudit({ normal, neutral, directives: [dir] });
    expect(r.violations).toEqual([{ invariant: 'I2', message: '两口径 covered 不等：正常 2 / 中和 1' }]);
  });

  it('removed 为空 → I1；落单 start/stop → I3；注解文件不在中和口径报告内 → I3；起点越出 span → I4', () => {
    expect(reconcileAudit({ normal, neutral: normal, directives: [dir] }).violations.map((v) => v.invariant)).toEqual(['I1', 'I3']);
    const lone = findIgnoreDirectives('/* v8 ignore stop */\nfoo();', 'src/a.ts')[0]!;
    expect(reconcileAudit({ normal, neutral: neutralOk, directives: [lone] }).violations[0]!.message).toBe('src/a.ts:1:0 stop 注解未配对');
    const elsewhere = snapshot({ 'src/a.ts': { statements: { '1:0': 1, '10:0': 1 } }, 'src/b.ts': { statements: { '4:2': 0 } } });
    const r = reconcileAudit({ normal, neutral: elsewhere, directives: [{ ...dir, file: 'src/zzz.ts' }] });
    expect(r.violations.map((v) => v.invariant)).toEqual(['I3', 'I4']);
    expect(r.violations[0]!.message).toContain('不在中和口径覆盖率报告内');
    const shifted = snapshot({ 'src/a.ts': { statements: { '1:0': 1, '8:2': 0, '10:0': 1 } } });
    const r4 = reconcileAudit({ normal, neutral: shifted, directives: [dir] });
    expect(r4.violations.map((v) => v.invariant)).toEqual(['I3', 'I4']);
    expect(r4.violations[1]!.message).toBe('src/a.ts:8:2 被移出语句起点不在任何注解作用 span 内');
  });
});

describe('报表', () => {
  const dir = directiveOf(SRC, 3);
  const normal = snapshot({ 'src/a.ts': { statements: { '1:0': 1 } } });
  const neutral = snapshot({ 'src/a.ts': { statements: { '1:0': 1, '4:2': 0 }, lines: { '4:2': 0 } } });
  const header = { repoRoot: 'R', files: 1, tests: { normal: '3/3（文件 1）', neutral: '3/3（文件 1）' } };

  it('PASS：表格行含定位 / 类别 / 移出数 / hits，末行摘要；产物缺列以 n/a 披露', () => {
    const text = formatAuditReport(reconcileAudit({ normal, neutral, directives: [dir] }), header);
    expect(text).toContain('| src/a.ts:3:2 (next) | 测试类别 | 1 | 0 | L4:2 |');
    expect(text).toContain('正常口径：statements 1/1（total/covered）；用例 3/3（文件 1）');
    expect(text).toContain('披露（不计入 exit 码）：branches n/a（产物无该列） / functions n/a（产物无该列） / lines 移出 1（hits>0：0）');
    expect(text.endsWith('PASS：I1–I4 全部成立（1 注解 / 1 语句；两口径 covered 1 = 1）')).toBe(true);
  });

  it('FAIL：违例逐条列出；无说明行以占位显示；零移出行留空', () => {
    const r = reconcileAudit({ normal, neutral: normal, directives: [{ ...dir, category: '' }] });
    const text = formatAuditReport(r, header);
    expect(text).toContain('| src/a.ts:3:2 (next) | （无 TASK 说明行） | 0 | 0 |  |');
    expect(text).toContain('- [I1] removed 为空');
    expect(text).toContain('- [I3] src/a.ts:3:2 孤儿注解');
    expect(text).toContain('FAIL：2 条违例（1 注解 / 0 语句');
  });
});

// ─── CLI：注入 runner，合成 coverage 产物 ───

interface FakePlan {
  removedHits?: number;
  normalTests?: number;
  neutralTests?: number;
  omitCoverage?: boolean;
  status?: number;
  failed?: number;
  badJson?: boolean;
}

function buildRoot(): string {
  const root = tmpTree();
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'a.ts'), `${SRC}\n`);
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'stub.txt'), 'skip-me');
  return root;
}

function istanbulFile(statements: Record<string, number>): Record<string, unknown> {
  const statementMap: Record<string, unknown> = {};
  for (const [key, hits] of Object.entries(statements)) {
    const [line, column] = key.split(':').map(Number);
    statementMap[key] = { start: { line, column }, end: { line, column: null } };
  }
  return { statementMap, s: statements, fnMap: {}, f: {}, branchMap: {}, b: {}, lineMap: {}, l: {} };
}

/** 合成双跑：正常口径无 L4 语句，中和口径多出 L4:2（hits 由 plan 决定）；两口径均含 L1 / L11 语句 */
function fakeRunner(plan: FakePlan = {}, probe?: { onNeutral?: (req: VitestRunRequest) => void }): AuditDeps['runVitest'] {
  return (req) => {
    if (plan.status !== undefined && req.phase === 'normal') return { status: plan.status, stdout: 'x'.repeat(2000), stderr: 'boom' };
    if (plan.omitCoverage && req.phase === 'neutral') return { status: 0, stdout: '', stderr: 'no coverage' };
    mkdirSync(req.reportsDir, { recursive: true });
    const statements = req.phase === 'normal' ? { '1:0': 1, '11:0': 1 } : { '1:0': 1, '4:2': plan.removedHits ?? 0, '6:30': 0, '11:0': 1 };
    const tests = req.phase === 'normal' ? (plan.normalTests ?? 3) : (plan.neutralTests ?? 3);
    const failed = plan.failed ?? 0;
    writeFileSync(path.join(req.reportsDir, 'coverage-final.json'), plan.badJson ? '{not json' : JSON.stringify({ [path.join(req.cwd, 'src', 'a.ts')]: istanbulFile(statements) }));
    writeFileSync(req.outputFile, JSON.stringify({ numTotalTests: tests, numPassedTests: tests - failed, numFailedTests: failed, testResults: [{}] }));
    probe?.onNeutral?.(req);
    return { status: 0, stdout: '', stderr: '' };
  };
}

function cli(root: string, runVitest: AuditDeps['runVitest'], argv: string[] = [], copyTree?: AuditDeps['copyTree']): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCoverageIgnoreAuditCli(argv, { cwd: root, stdout: (s) => out.push(s), stderr: (s) => err.push(s), deps: { runVitest, copyTree } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('⑥ CLI exit 码三元组（通过=0 / 违例=1 / 无法审计=2）', () => {
  it('正常 → exit 0 + PASS；中和树用后不存在；中和文件等长且注解已置空', () => {
    const root = buildRoot();
    const original = readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');
    let neutralText = '';
    const r = cli(root, fakeRunner({}, { onNeutral: (req) => (neutralText = readFileSync(path.join(req.cwd, 'src', 'a.ts'), 'utf8')) }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('发现注解 2 条（1 文件）');
    expect(r.out).toContain('| src/a.ts:3:2 (next) | 测试类别 | 1 | 0 | L4:2 |');
    expect(r.out.includes('FAIL')).toBe(false);
    expect(r.out).toContain('PASS：I1–I4 全部成立（2 注解 / 2 语句');
    expect(neutralText.length).toBe(original.length);
    expect(neutralText.split('v8 ignore next')).toHaveLength(3); // 2 条注解已置空；仅余模板字面 / 字符串内字面
    expect(existsSync(path.join(root, 'coverage', 'ignore-audit', 'neutral-tree'))).toBe(false);
    expect(existsSync(path.join(root, 'coverage', 'ignore-audit', 'normal', 'coverage-final.json'))).toBe(true);
  });

  it('① 被移出语句 hits>0 → exit 1，违例定位到语句', () => {
    const r = cli(buildRoot(), fakeRunner({ removedHits: 5 }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('[I1] src/a.ts:4:2 中和口径 hits=5');
    expect(r.out).toContain('FAIL：2 条违例'); // I1 + I2（hits>0 必然抬高中和口径 covered）
  });

  it('vitest 未产出 coverage → exit 2；vitest 非零退出 → exit 2（附输出尾）；用例未全绿 → exit 2', () => {
    const noCov = cli(buildRoot(), fakeRunner({ omitCoverage: true }));
    expect(noCov.code).toBe(2);
    expect(noCov.err).toContain('中和 口径 vitest 未产出 coverage-final.json');
    const failing = cli(buildRoot(), fakeRunner({ status: 1 }));
    expect(failing.code).toBe(2);
    expect(failing.err).toContain('正常 口径 vitest 退出码 1');
    expect(failing.err).toContain('…xxxx');
    const red = cli(buildRoot(), fakeRunner({ failed: 1 }));
    expect(red.code).toBe(2);
    expect(red.err).toContain('正常 口径用例未全绿（2/3，失败 1）');
  });

  it('coverage 产物非法 JSON → exit 2（解析失败不落入违例语义）', () => {
    const r = cli(buildRoot(), fakeRunner({ badJson: true }));
    expect(r.code).toBe(2);
    expect(r.err).toContain('正常 口径 coverage 产物解析失败——无法审计（exit 2）');
  });

  it('两口径用例数不一致 → exit 2（对账前提不成立）', () => {
    const r = cli(buildRoot(), fakeRunner({ neutralTests: 2 }));
    expect(r.code).toBe(2);
    expect(r.err).toContain('两口径用例数不一致（正常 3/3（文件 1） / 中和 2/2（文件 1））');
  });

  it('未注入 runner（真实 spawn 路径）：vitest 入口缺失 → 非零退出码如实透传为 exit 2', () => {
    const root = buildRoot();
    const err: string[] = [];
    const code = runCoverageIgnoreAuditCli([], { cwd: root, stdout: () => undefined, stderr: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('正常 口径 vitest 退出码 1');
  });

  it('中和树构造失败 → exit 2，且临时目录同样被清理', () => {
    const root = buildRoot();
    const r = cli(
      root,
      fakeRunner(),
      [],
      () => {
        throw new Error('EACCES');
      },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('中和树构造失败——无法审计（exit 2）');
    expect(r.err).toContain('EACCES');
    expect(existsSync(path.join(root, 'coverage', 'ignore-audit', 'neutral-tree'))).toBe(false);
  });

  it('file 级注解 → exit 2（不进双跑）；src 不存在 → exit 2；未识别参数告警不改变结果', () => {
    const root = buildRoot();
    writeFileSync(path.join(root, 'src', 'b.ts'), '/* v8 ignore file */\nfoo();\n');
    const r = cli(root, fakeRunner(), ['--bogus']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('整文件级 ignore 注解');
    expect(r.err).toContain('未识别参数 --bogus');
    const missing = cli(path.join(root, 'no-such-root'), fakeRunner());
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('注解发现失败');
    expect(missing.err).toContain('src 目录不存在');
  });
});

describe('中和树复制与真实 spawn 边界', () => {
  it('copyTreeForNeutral：递归复制，跳过 node_modules / coverage 等条目', () => {
    const from = tmpTree();
    const to = path.join(tmpTree(), 'out');
    mkdirSync(to);
    mkdirSync(path.join(from, 'node_modules', 'x'), { recursive: true });
    mkdirSync(path.join(from, 'coverage'), { recursive: true });
    mkdirSync(path.join(from, 'src', 'deep'), { recursive: true });
    writeFileSync(path.join(from, 'node_modules', 'x', 'm.js'), 'm');
    writeFileSync(path.join(from, 'coverage', 'c.json'), '{}');
    writeFileSync(path.join(from, 'src', 'deep', 'a.ts'), 'a');
    copyTreeForNeutral(from, to);
    expect(readdirSync(to).sort()).toEqual(['src']);
    expect(readFileSync(path.join(to, 'src', 'deep', 'a.ts'), 'utf8')).toBe('a');
  });

  it('spawnVitest：以 node 执行 vitest 入口，入口缺失时如实返回非零状态与 stderr', () => {
    const dir = tmpTree();
    const r = spawnVitest(path.join(dir, 'no-such-vitest.mjs'), { phase: 'neutral', cwd: dir, reportsDir: path.join(dir, 'cov'), outputFile: path.join(dir, 'cov', 'v.json') });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Cannot find module');
    expect(r.stdout).toBe('');
  });

  it('discoverDirectives：发现 src 内注解文件；含注解文件非无损 UTF-8 → 抛错；无注解文件不进列表', () => {
    const root = buildRoot();
    writeFileSync(path.join(root, 'src', 'clean.ts'), 'export const x = 1;\n');
    const found = discoverDirectives(root);
    expect(found.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(found[0]!.directives).toHaveLength(2);
    writeFileSync(path.join(root, 'src', 'bad.ts'), Buffer.concat([Buffer.from([0xff]), Buffer.from(`${NEXT}\nfoo();\n`)]));
    expect(() => discoverDirectives(root)).toThrow('src/bad.ts 含非 UTF-8 字节序列');
    rmSync(path.join(root, 'src', 'bad.ts'));
    mkdirSync(path.join(root, 'src', 'sub'));
    writeFileSync(path.join(root, 'src', 'sub', 'c.ts'), `${NEXT}\nbar();\n`);
    expect(discoverDirectives(root).map((f) => f.file)).toEqual(['src/a.ts', 'src/sub/c.ts']);
  });
});

describe('CLI 直执行守卫', () => {
  it('以 coverageIgnoreAudit.js 为主模块动态导入 → 守卫触发 runCoverageIgnoreAuditCli + process.exit（根不存在 → exit 2）', async () => {
    const origArgv = process.argv;
    const exitCalls: number[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);
    process.argv = ['node', path.join(tmpTree(), 'dist', 'coverageIgnoreAudit.js'), path.join(tmpTree(), 'no-root')];
    try {
      vi.resetModules();
      await import('../src/scripts/coverageIgnoreAudit.js');
      expect.fail('守卫未触发 process.exit');
    } catch (e) {
      expect(String((e as Error).message)).toBe('EXIT:2');
    } finally {
      process.argv = origArgv;
      exitSpy.mockRestore();
      vi.resetModules();
    }
    expect(exitCalls).toEqual([2]);
  });
});
