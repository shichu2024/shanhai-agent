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
 */
export function hostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return false;
  const hostPart = hostHeader.replace(/:\d+$/, '');
  const allowed = bindHost === '127.0.0.1' || bindHost === 'localhost' ? ['127.0.0.1', 'localhost'] : [bindHost];
  return allowed.includes(hostPart);
}
