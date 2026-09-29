import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// TASK-96：门户首启自动拉起默认浏览器，Token 经 URL fragment（#token=...）带外注入。
// 安全边界不变（D-44 / P1-2-①）：Token 仍只经终端与本地进程侧发放——fragment 不发往服务端、
// 不进服务端日志与 Trace（node:http 天然收不到 fragment），前端读取后即从地址栏抹除。
// 拉起条件：本次新生成 Token（tokenGenerated），或 Token 文件在但从未拉起过（marker 缺失）；
// 显式 config/env Token（tokenFile=null）不拉起——配置方已自持口令，且测试/冒烟/CI 常用该形态。

/** 拉起标记文件（data/portal/browser-opened）：写入后「Token 文件在」形态不再重复拉起 */
export function browserMarkerFile(dataDir: string): string {
  return path.join(dataDir, 'portal', 'browser-opened');
}

export interface AutoOpenInput {
  /** 本次启动新生成 Token（resolvePortalToken.generated） */
  tokenGenerated: boolean;
  /** Token 文件路径（显式 config/env 覆盖时为 null） */
  tokenFile: string | null;
  dataDir: string;
}

/** 是否应自动拉起浏览器：新生成 Token 恒拉起（新口令需送达）；否则仅首次（marker 缺失）且 Token 为文件托管形态 */
export function shouldAutoOpenBrowser(input: AutoOpenInput): boolean {
  if (input.tokenGenerated) return true;
  return input.tokenFile !== null && !existsSync(browserMarkerFile(input.dataDir));
}

/** 记录「已拉起过」标记（内容为时间戳，不含 Token） */
export function markBrowserOpened(dataDir: string): string {
  const file = browserMarkerFile(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, new Date().toISOString(), { mode: 0o600 });
  return file;
}

/** 门户 URL：Token 置于 fragment——IPv6 字面量主机加方括号，Token 值经 encodeURIComponent */
export function buildPortalUrl(host: string, port: number, token: string): string {
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostPart}:${port}/#token=${encodeURIComponent(token)}`;
}

/** 与 public/app.js consumeTokenFragment 同源镜像：#token=<value> → value；其余形态 null */
export function tokenFromFragment(hash: string): string | null {
  const m = /^#token=(.+)$/.exec(hash);
  return m ? m[1] : null;
}

type SpawnFn = (command: string, args: string[]) => unknown;

/**
 * 跨平台拉起默认浏览器（detached + stdio ignore + unref——门户不等待、不收养浏览器进程）。
 * 尽力而为：拉起失败（无 GUI/无 xdg-open 等）返回 false，由调用方提示 --no-open 逃生口。
 */
export function openBrowser(url: string, opts: { platform?: NodeJS.Platform; spawnFn?: SpawnFn } = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const spawnFn: SpawnFn =
    opts.spawnFn ?? ((command, args) => spawn(command, args, { detached: true, stdio: 'ignore' }).unref());
  const [command, args] =
    platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]] // start 的首参是窗口标题，须占位空串
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawnFn(command, args);
    return true;
  } catch {
    return false;
  }
}
