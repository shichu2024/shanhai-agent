import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoUnknownCommandFlags } from '../src/cliFlags.js';

// TASK-127（每日优化第六批）：CLI 顶层命令族未知旗标 fail-fast（TASK-116 同族延伸）。
// 备案缺陷：main() 走 flagValue/rest.includes 逐个挑已知旗标，未知旗标静默忽略——
// `shanhai task run <id> --resum`（手误少一字母）语义改变（本意 resume 却全新重跑）。
// 契约：按命令族白名单（值旗标+布尔旗标分列，--by 全命令通用），未知 `--` token
// fail-fast（含旗标名+该命令支持清单），先于 Runtime 构造 → 零副作用。

describe('TASK-127 未知旗标 fail-fast（跨命令族）', () => {
  it.each([
    ['task', 'run', ['t-1', '--resum'], '--resume'],
    ['task', 'run', ['t-1', '--resumed-by', 'manual-resume', '--strateg'], '--strategy'],
    ['agent', 'release', ['a-1', 'v-1', '--no-pointr'], '--no-pointer'],
    ['agent', 'register', ['spec.json', '--from-candidat'], '--from-candidate'],
    ['approval', 'deny', ['r-1', '--reaso'], '--reason'],
    ['approval', 'approve', ['r-1', '--detached'], '--detach'],
    ['tool', 'mcp', ['connect', 'srv', '--yess'], '--yes'],
    ['tool', 'list', ['--kinds'], '--kind'],
    ['memory', 'list', ['--agents'], '--agent'],
    ['evolution', 'confirm', ['c-1', '--proposed-chang'], '--proposed-change'],
    ['capability', 'trend', ['a-1', '--buckett'], '--bucket'],
    ['capability', 'add', ['a-1', '--kind', 'capability', '--statements'], '--statement'],
    ['query', 't1', ['t-1', '--verbose'], '--by'],
    ['agent', 'insight', ['a-1', '--jsonx'], '--json'],
  ])('shanhai %s %s … 未知旗标 fail-fast，错误含旗标名与最近已知旗标', (cmd, sub, rest, hint) => {
    expect(() => assertNoUnknownCommandFlags(cmd, sub, rest)).toThrow(/未知旗标/);
    const err = (() => {
      try {
        assertNoUnknownCommandFlags(cmd, sub, rest);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain(rest.find((t) => t.startsWith('--') && !['--kind', '--resumed-by'].includes(t)) ?? '');
    expect(err!.message).toContain(hint);
  });

  it('核心场景逐字断言：task run --resum → 错误含旗标名与该命令完整支持清单', () => {
    let msg = '';
    try {
      assertNoUnknownCommandFlags('task', 'run', ['t-1', '--resum']);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('--resum');
    expect(msg).toContain('shanhai task run');
    for (const f of ['--by', '--strategy', '--resume', '--resumed-by']) expect(msg).toContain(f);
  });

  it('未知旗标混在合法旗标中：仍 fail-fast', () => {
    expect(() => assertNoUnknownCommandFlags('task', 'cancel', ['t-1', '--by', 'ops', '--forc'])).toThrow(/--forc/);
    expect(() => assertNoUnknownCommandFlags('capability', 'list', ['--agent', 'a-1', '--bogus'])).toThrow(/--bogus/);
  });

  it('裸 -- token：按未知旗标拒绝（与 portal 守卫口径一致）', () => {
    expect(() => assertNoUnknownCommandFlags('task', 'get', ['t-1', '--'])).toThrow(/未知旗标/);
  });
});

describe('TASK-127 已知旗标放行 + 值位消费模拟', () => {
  it('task run 全旗标组合（approve-spawn 构造面）放行', () => {
    expect(() => assertNoUnknownCommandFlags('task', 'run', ['t-1', '--resume', '--resumed-by', 'approve-spawn', '--by', 'ops'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('task', 'run', ['t-1', '--strategy', 'native'])).not.toThrow();
  });

  it('各命令族已知旗标全组合放行（语义回归）', () => {
    expect(() => assertNoUnknownCommandFlags('agent', 'register', ['spec.json', '--by', 'ops', '--from-candidate', 'c-1'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('agent', 'release', ['a-1', 'v-1', '--no-pointer', '--by', 'ops'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('agent', 'canary', ['set', 'a-1', 'v-1', '--weight', '50'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('agent', 'canary', ['clear', 'a-1'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('agent', 'insight', ['a-1', '--since', '2026-01-01', '--json'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('task', 'create', ['a-1', 'in.json', '--by', 'ops', '--draft'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('task', 'create', ['a-1', 'in.json', '--reviewed'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('approval', 'list', ['--pending'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('approval', 'deny', ['r-1', '--by', 'ops', '--reason', '不通过'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('tool', 'register', ['--file', 'def.json', '--by', 'ops'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('tool', 'list', ['--kind', 'external', '--risk', 'L3'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('tool', 'mcp', ['connect', 'weather', '--yes', '--by', 'ops'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('memory', 'list', ['--agent', 'a-1'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('evolution', 'confirm', ['c-1', '--proposed-change', '升级工具'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('capability', 'list', ['--agent', 'a-1', '--kind', 'capability', '--status', 'active'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('capability', 'add', ['a-1', '--kind', 'capability', '--statement', '文本', '--statement-file', 'f.txt', '--evidence', 'task:t-1', '--by', 'ops'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('capability', 'trend', ['a-1', '--since', '2026-01-01', '--until', '2026-02-01', '--bucket', 'week'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('query', 't2p', ['v-1'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('evidence', 'show', ['task:t-1'])).not.toThrow();
  });

  it('值位消费正确：被值旗标吞掉的 token 不算旗标名（对齐 TASK-116 消费模拟模式）', () => {
    // --by 的取值位是 --bogus 形态：guard 不报未知旗标（顶层命令 flagValue 原样取值，语义不变）
    expect(() => assertNoUnknownCommandFlags('task', 'get', ['t-1', '--by', '--bogus'])).not.toThrow();
    // --reason 取值位含 -- 前缀文本同理
    expect(() => assertNoUnknownCommandFlags('approval', 'deny', ['r-1', '--reason', '--strong-veto'])).not.toThrow();
    // 值旗标收尾缺值：不误报（既有 flagValue → null 缺省路径，行为不变）
    expect(() => assertNoUnknownCommandFlags('task', 'run', ['t-1', '--strategy'])).not.toThrow();
  });

  it('位置参数不守卫（顶层命令有位置参数面，与 portal 不同）', () => {
    expect(() => assertNoUnknownCommandFlags('task', 'get', ['t-1'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('agent', 'show', ['a-1', 'v-1'])).not.toThrow();
  });

  it('未收录命令键不守卫（未知命令/子命令仍由既有 usage() 分支处理）', () => {
    expect(() => assertNoUnknownCommandFlags('bogus', 'x', ['--whatever'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('agent', 'bogus', ['--whatever'])).not.toThrow();
    expect(() => assertNoUnknownCommandFlags('agent', 'canary', ['promote'])).not.toThrow();
  });
});

describe('TASK-127 cli.ts 接线源契约', () => {
  const src = readFileSync(path.resolve(__dirname, '..', 'src', 'cli.ts'), 'utf8');

  it('守卫先于 Runtime.fromConfig 调用（未知旗标零副作用：不建库不写状态）', () => {
    const guardIdx = src.indexOf('assertNoUnknownCommandFlags(');
    const rtIdx = src.indexOf('Runtime.fromConfig(dataDir');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rtIdx).toBeGreaterThan(guardIdx);
  });

  it('portal 子路径不受影响（守卫在 portal 分支之后）', () => {
    const portalIdx = src.indexOf("if (cmd === 'portal')");
    const guardIdx = src.indexOf('assertNoUnknownCommandFlags(');
    expect(portalIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(portalIdx);
  });

  it('白名单表覆盖全部顶层命令键（与 usage() 命令族对照）', async () => {
    const { CLI_COMMAND_FLAGS } = await import('../src/cliFlags.js');
    const keys = Object.keys(CLI_COMMAND_FLAGS);
    for (const key of [
      'agent register', 'agent release', 'agent review', 'agent deprecate', 'agent rollback',
      'agent canary set', 'agent canary clear', 'agent promote', 'agent report', 'agent list',
      'agent show', 'agent card', 'agent insight',
      'task create', 'task run', 'task cancel', 'task get',
      'approval list', 'approval show', 'approval approve', 'approval deny',
      'tool register', 'tool list', 'tool show', 'tool retire', 'tool mcp connect',
      'memory list',
      'evolution list', 'evolution show', 'evolution confirm', 'evolution dismiss',
      'evidence show', 'evidence task',
      'capability list', 'capability add', 'capability confirm', 'capability retire', 'capability trend',
      'query t1', 'query t2', 'query t2p',
    ]) {
      expect(keys).toContain(key);
    }
  });
});
