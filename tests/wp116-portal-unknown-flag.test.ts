import { describe, expect, it } from 'vitest';
import { parsePortalArgs } from '../src/portal/server.js';

// TASK-116（每日优化第四批）：门户 CLI 未知旗标 fail-fast（合并 TASK-110 P3-1 / TASK-113 P3-1）。
// 备案缺陷：parsePortalArgs 仅识别 --port/--host/--dataDir/--no-open/--print-url 五个旗标，
// 未知旗标静默忽略——`shanhai portal --print-ur`（手误）会真启动常驻服务挂住终端。
// 契约：未知旗标 fail-fast（含旗标名+支持清单）；多余位置参数同理拒绝（portal 无位置参数面）。

describe('TASK-116 parsePortalArgs 未知旗标 fail-fast', () => {
  it('未知旗标（--print-ur 手误形态）：fail-fast，错误含旗标名与支持清单', () => {
    expect(() => parsePortalArgs(['--print-ur'])).toThrow(/--print-ur/);
    expect(() => parsePortalArgs(['--print-ur'])).toThrow(/--print-url/);
  });

  it('任意未知旗标（--bogus）：fail-fast 且列出全部支持旗标', () => {
    for (const flag of ['--port', '--host', '--dataDir', '--no-open', '--print-url']) {
      expect(() => parsePortalArgs(['--bogus'])).toThrow(new RegExp(flag.replace(/-/g, '\\-')));
    }
    expect(() => parsePortalArgs(['--bogus'])).toThrow(/--bogus/);
  });

  it('未知旗标混在合法旗标中：仍 fail-fast', () => {
    expect(() => parsePortalArgs(['--port', '7781', '--bogus', '--no-open'])).toThrow(/--bogus/);
  });

  it('未知旗标先于合法旗标出现：fail-fast（不启动任何后续解析副作用）', () => {
    expect(() => parsePortalArgs(['--verbose', '--port', '8080'])).toThrow(/--verbose/);
  });

  it('已知旗标仍放行：五旗标全组合解析不变（TASK-96/109/113 语义回归）', () => {
    expect(parsePortalArgs([])).toEqual({});
    expect(parsePortalArgs(['--port', '7781', '--host', '0.0.0.0', '--dataDir', '/tmp/seed', '--no-open', '--print-url'])).toEqual({
      port: 7781,
      host: '0.0.0.0',
      dataDir: '/tmp/seed',
      open: false,
      printUrl: true,
    });
    expect(parsePortalArgs(['--print-url'])).toEqual({ printUrl: true });
    expect(parsePortalArgs(['--no-open'])).toEqual({ open: false });
  });

  it('值旗标取值含 -- 前缀仍由既有吞值守卫拦截（回归：--port --bogus 形态 fail-fast）', () => {
    expect(() => parsePortalArgs(['--port', '--bogus'])).toThrow(/--port/);
    expect(() => parsePortalArgs(['--dataDir', '--bogus'])).toThrow(/--dataDir/);
  });
});

describe('TASK-116 parsePortalArgs 多余位置参数口径（默认拒绝）', () => {
  it('shanhai portal foo：位置参数 fail-fast，错误含该参数与支持旗标指引', () => {
    expect(() => parsePortalArgs(['foo'])).toThrow(/foo/);
    expect(() => parsePortalArgs(['foo'])).toThrow(/--port/);
  });

  it('位置参数跟在合法旗标之后：仍 fail-fast', () => {
    expect(() => parsePortalArgs(['--port', '7781', 'extra'])).toThrow(/extra/);
    expect(() => parsePortalArgs(['--no-open', 'oops'])).toThrow(/oops/);
  });

  it('位置参数面核验：portal 命令无任何位置参数依赖（全量旗标-only 契约钉死）', () => {
    // 源契约：cli.ts runPortal 入参 = process.argv.slice(3)，本函数是唯一消费者；
    // 已知脚本/测试调用面（smoke-portal.mjs 等）全部旗标-only——位置参数默认拒绝。
    expect(() => parsePortalArgs(['list'])).toThrow();
    expect(() => parsePortalArgs(['--port', '7781', '--', 'trailing'])).toThrow();
  });
});
