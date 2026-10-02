import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

// 第六阶段批次一（§6 安全边界论证 / D-44）：认证与监听边界。
// Token 缺省启用无关闭项（P1-2-①）：解析序 config portal.token > env SHANHAI_PORTAL_TOKEN >
// 首次启动自动生成（randomBytes(32) hex，落 data/portal/token，0600——非 POSIX 平台权限位降级为警示）。

/** Token 解析结果：generated=true 表示本次启动新生成并已落盘 */
export interface ResolvedToken {
  token: string;
  generated: boolean;
  tokenFile: string | null;
}

export function resolvePortalToken(dataDir: string, configToken?: string, envToken?: string): ResolvedToken {
  if (configToken !== undefined && configToken.length > 0) return { token: configToken, generated: false, tokenFile: null };
  if (envToken !== undefined && envToken.length > 0) return { token: envToken, generated: false, tokenFile: null };
  const tokenFile = path.join(dataDir, 'portal', 'token');
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing.length > 0) return { token: existing, generated: false, tokenFile };
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, token, { mode: 0o600 }); // POSIX 0600；Windows 权限位不适用（ACL 另治，设计知悉项）
  return { token, generated: true, tokenFile };
}

/** 只读 Token 解析结果（无 generated——绝不生成） */
export interface ReadPortalToken {
  token: string;
  /** Token 来源文件路径（config/env 形态为 null） */
  tokenFile: string | null;
}

/**
 * 只读既有门户 Token（TASK-113，--print-url 用）：解析序 config > env > token 文件，均无返回 null。
 * 与 resolvePortalToken 的关键差异：绝不生成、绝不落盘、绝不建目录——零副作用
 * （打印路径不得在「从未首启」的数据目录里凭空造出 Token 文件）。
 */
export function readPortalToken(dataDir: string, configToken?: string, envToken?: string): ReadPortalToken | null {
  if (configToken !== undefined && configToken.length > 0) return { token: configToken, tokenFile: null };
  if (envToken !== undefined && envToken.length > 0) return { token: envToken, tokenFile: null };
  const tokenFile = path.join(dataDir, 'portal', 'token');
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing.length > 0) return { token: existing, tokenFile };
  }
  return null;
}

/** 从 Authorization 头取 Bearer 凭据（非 Bearer 形态返回 null） */
export function bearerTokenOf(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

/** 恒时比对（长度不等直接 false——长度本身非秘密） */
export function tokenMatches(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Host 头校验（防 DNS rebinding，D-44-4）：主机部分必须为回环形态或配置绑定地址（[:port] 任意端口均放行——
 * 端口由本服务自己监听，不构成 rebinding 面）。Host 缺失（HTTP/1.0 形态）一律拒绝。
 *
 * TASK-110（P3-③ 收口）：bindHost 为通配（0.0.0.0 / ::）时原白名单仅 [bindHost]——经 LAN IP 访问
 * 一律 403，fail-closed UX 缺陷使通配绑定实际不可用。现放行 Host 主机部分为回环形态
 * （127.0.0.1 / localhost / [::1]）或私网/链路本地字面 IP（决策官预裁定集合）；
 * 公网域名与公网字面 IP 仍拒绝——rebinding 场景 Host 是公网域名，防护不弱化。
 * 回环绑定（127.0.0.1/localhost）与具体地址绑定分支行为不变。
 */
export function hostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return false;
  const hostPart = hostHeader.replace(/:\d+$/, '');
  if (bindHost === '127.0.0.1' || bindHost === 'localhost') {
    return hostPart === '127.0.0.1' || hostPart === 'localhost';
  }
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    return hostPart === '127.0.0.1' || hostPart === 'localhost' || hostPart === '[::1]'
      || isPrivateOrLinkLocalIpv4(hostPart)
      || isPrivateOrLinkLocalIpv6(hostPart);
  }
  return hostPart === bindHost;
}

/** IPv4 私网/链路本地字面 IP：10/8、172.16/12、192.168/16、169.254/16（点分十进制逐段校验，非 IP 形态 false） */
function isPrivateOrLinkLocalIpv4(hostPart: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostPart);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return a === 169 && b === 254; // 169.254/16
}

/** IPv6 ULA/链路本地字面 IP：fc00::/7（含 fd 前缀）、fe80::/10——Host 头 IPv6 形态为 [addr]，按首 hextet 判段 */
function isPrivateOrLinkLocalIpv6(hostPart: string): boolean {
  if (!hostPart.startsWith('[') || !hostPart.endsWith(']')) return false;
  const inner = hostPart.slice(1, -1);
  if (!inner.includes(':')) return false;
  const firstHextet = Number.parseInt(inner.split(':')[0] || '0', 16);
  if (Number.isNaN(firstHextet)) return false;
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7
  return firstHextet >= 0xfe80 && firstHextet <= 0xfebf; // fe80::/10
}
