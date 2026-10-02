import { describe, expect, it } from 'vitest';
import { parsePortalArgs } from '../src/portal/server.js';

// TASK-110（每日优化第二批·第二项）：parsePortalArgs 值旗标守卫（TASK-109 反方备案 P3-1）。
// 备案缺陷：`--dataDir --no-open` 形态把 `--no-open` 吞为值且不报错（--host 同理；
// --port 仅靠数字校验间接拦截但报错误导）。契约：值旗标（--port/--host/--dataDir）取值
// 不得以 `--` 开头——fail-fast 不静默。

describe('TASK-110 parsePortalArgs 值旗标守卫（取值不得以 -- 开头）', () => {
  it('--dataDir --no-open 形态：fail-fast 拒绝（不吞旗标为值）', () => {
    expect(() => parsePortalArgs(['--dataDir', '--no-open'])).toThrow(/--dataDir/);
    expect(() => parsePortalArgs(['--dataDir', '--no-open'])).toThrow(/--no-open/);
  });

  it('--host 吞旗标形态：fail-fast 拒绝', () => {
    expect(() => parsePortalArgs(['--host', '--no-open'])).toThrow(/--host/);
    // ['--host','--port'] 先命中 --port 缺值守卫（解析顺序），同为 fail-fast——不静默吞值
    expect(() => parsePortalArgs(['--host', '--port'])).toThrow(/不能为空/);
  });

  it('--port 吞旗标形态：fail-fast 拒绝（非数字报错误导修正）', () => {
    expect(() => parsePortalArgs(['--port', '--no-open'])).toThrow(/--port/);
  });

  it('既有非法值口径回归不变：缺值/空串拒绝', () => {
    expect(() => parsePortalArgs(['--dataDir'])).toThrow(/--dataDir 不能为空/);
    expect(() => parsePortalArgs(['--dataDir', ''])).toThrow(/--dataDir 不能为空/);
    expect(() => parsePortalArgs(['--host'])).toThrow(/--host 不能为空/);
    expect(() => parsePortalArgs(['--port', 'abc'])).toThrow(/1-65535/);
    expect(() => parsePortalArgs(['--port', '70000'])).toThrow(/1-65535/);
  });

  it('合法组合解析回归不变', () => {
    expect(parsePortalArgs(['--port', '7781', '--host', '0.0.0.0', '--dataDir', '/tmp/seed-b', '--no-open'])).toEqual({
      port: 7781,
      host: '0.0.0.0',
      dataDir: '/tmp/seed-b',
      open: false,
    });
    // 相对/Windows 路径含冒号与反斜杠不受守卫影响（仅拦 -- 前缀）
    expect(parsePortalArgs(['--dataDir', 'D:\\code\\tmp-data'])).toEqual({ dataDir: 'D:\\code\\tmp-data' });
  });
});
