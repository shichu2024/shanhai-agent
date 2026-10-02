import { describe, expect, it } from 'vitest';
import { hostAllowed } from '../src/portal/auth.js';

// TASK-110（每日优化第二批·第一项）：通配绑定 Host 校验收口（第六阶段遗留 P3-③）。
// 备案缺陷：bindHost 为通配（0.0.0.0 / ::）时白名单仅 [bindHost]——经 LAN IP 访问一律 403，
// fail-closed UX 缺陷使通配绑定实际不可用。
// 决策官预裁定语义：通配绑定时放行 Host 主机部分为回环形态（127.0.0.1 / localhost / [::1]）
// 或私网/链路本地字面 IP（IPv4：10/8、172.16/12、192.168/16、169.254/16；IPv6：fc00::/7、fe80::/10）；
// 公网域名与公网字面 IP 仍拒绝——DNS rebinding 防护不得弱化。

describe('TASK-110 hostAllowed 通配绑定放行私网（0.0.0.0 / ::）', () => {
  it('通配 + 回环形态放行（127.0.0.1 / localhost / [::1]，带端口与不带端口）', () => {
    for (const bind of ['0.0.0.0', '::']) {
      expect(hostAllowed('127.0.0.1:7780', bind)).toBe(true);
      expect(hostAllowed('127.0.0.1', bind)).toBe(true);
      expect(hostAllowed('localhost:7780', bind)).toBe(true);
      expect(hostAllowed('localhost', bind)).toBe(true);
      expect(hostAllowed('[::1]:7780', bind)).toBe(true);
      expect(hostAllowed('[::1]', bind)).toBe(true);
    }
  });

  it('通配 + IPv4 私网/链路本地字面 IP 放行（10/8、172.16/12、192.168/16、169.254/16）', () => {
    for (const bind of ['0.0.0.0', '::']) {
      expect(hostAllowed('10.0.0.2:7780', bind)).toBe(true);
      expect(hostAllowed('10.255.255.255', bind)).toBe(true);
      expect(hostAllowed('172.16.0.1:7780', bind)).toBe(true);
      expect(hostAllowed('172.31.255.254', bind)).toBe(true);
      expect(hostAllowed('192.168.1.5:7780', bind)).toBe(true);
      expect(hostAllowed('192.168.0.1', bind)).toBe(true);
      expect(hostAllowed('169.254.7.9:7780', bind)).toBe(true);
    }
  });

  it('通配 + IPv6 ULA/链路本地字面 IP 放行（fc00::/7、fe80::/10，方括号形态）', () => {
    for (const bind of ['0.0.0.0', '::']) {
      expect(hostAllowed('[fc00::1]:7780', bind)).toBe(true);
      expect(hostAllowed('[fd12:3456:789a::1]', bind)).toBe(true);
      expect(hostAllowed('[fe80::1]:7780', bind)).toBe(true);
      expect(hostAllowed('[fe80::a123:bcd:ef01:2345:6789]', bind)).toBe(true);
    }
  });

  it('通配 + 公网域名拒绝（DNS rebinding 防护不弱化）', () => {
    for (const bind of ['0.0.0.0', '::']) {
      expect(hostAllowed('evil.example.com:7780', bind)).toBe(false);
      expect(hostAllowed('shanhai.internal.example.com', bind)).toBe(false);
      // 通配绑定自身字面值不在放行集合（严格按预裁定集合，公网/非私网字面 IP 一律拒）
      expect(hostAllowed('0.0.0.0:7780', bind)).toBe(false);
    }
  });

  it('通配 + 公网字面 IP 拒绝', () => {
    for (const bind of ['0.0.0.0', '::']) {
      expect(hostAllowed('8.8.8.8:7780', bind)).toBe(false);
      expect(hostAllowed('1.1.1.1', bind)).toBe(false);
      expect(hostAllowed('172.32.0.1:7780', bind)).toBe(false); // 172.16/12 边界外
      expect(hostAllowed('172.15.255.1', bind)).toBe(false);
      expect(hostAllowed('11.0.0.1:7780', bind)).toBe(false); // 10/8 边界外
      expect(hostAllowed('192.169.1.1', bind)).toBe(false); // 192.168/16 边界外
      expect(hostAllowed('[2001:db8::1]:7780', bind)).toBe(false); // 全球单播
      expect(hostAllowed('[2600::1]', bind)).toBe(false);
    }
  });

  it('回环绑定分支回归不变（127.0.0.1 / localhost）', () => {
    expect(hostAllowed('127.0.0.1:7780', '127.0.0.1')).toBe(true);
    expect(hostAllowed('localhost:7780', '127.0.0.1')).toBe(true);
    expect(hostAllowed('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(hostAllowed('localhost', 'localhost')).toBe(true);
    expect(hostAllowed('[::1]:7780', '127.0.0.1')).toBe(false); // 原行为：仅 127.0.0.1/localhost
    expect(hostAllowed('192.168.1.5:7780', '127.0.0.1')).toBe(false); // 回环绑定不放私网（回归钉死）
    expect(hostAllowed('evil.example.com:7780', '127.0.0.1')).toBe(false);
    expect(hostAllowed(undefined, '127.0.0.1')).toBe(false); // Host 缺失（HTTP/1.0）拒绝
    expect(hostAllowed(undefined, '0.0.0.0')).toBe(false);
  });

  it('具体地址绑定分支回归不变（白名单=[bindHost]，端口剥离语义不变）', () => {
    expect(hostAllowed('192.168.1.5:7780', '192.168.1.5')).toBe(true);
    expect(hostAllowed('192.168.1.5', '192.168.1.5')).toBe(true);
    expect(hostAllowed('192.168.1.6:7780', '192.168.1.5')).toBe(false);
    expect(hostAllowed('localhost:7780', '192.168.1.5')).toBe(false); // 非回环绑定不放回环
    expect(hostAllowed('10.0.0.2:7780', '192.168.1.5')).toBe(false); // 非通配绑定不放私网
  });
});
