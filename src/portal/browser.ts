import { spawn } from 'node:child_process';

// TASK-96：门户首启自动拉起默认浏览器，Token 经 URL fragment（#token=...）带外注入。
// 安全边界不变（D-44 / P1-2-①）：Token 仍只经终端与本地进程侧发放——fragment 不发往服务端、
// 不进服务端日志与 Trace（node:http 天然收不到 fragment），前端读取后即从地址栏抹除。
// TASK-128（修订 TASK-96 marker 语义）：文件托管形态**每次启动恒拉起**——旧「marker 单次拉起」
// 使后续启动浏览器不再收到凭证，用户手动打开页面即见「缺少或错误的 Bearer Token」技术性报错
// （用户不应需要理解 Token）。每次启动自动送达新会话后，正常本地使用无需任何手动口令操作。
// 显式 config/env Token（tokenFile=null）仍不拉起——配置方已自持口令，且测试/冒烟/CI 常用该形态。

export interface AutoOpenInput {
  /** 本次启动新生成 Token（resolvePortalToken.generated） */
  tokenGenerated: boolean;
  /** Token 文件路径（显式 config/env 覆盖时为 null） */
  tokenFile: string | null;
}

/**
 * 是否应自动拉起浏览器（TASK-128 口径）：
 * 文件托管形态（含新生成）每次启动恒拉起——会话凭证随每次启动自动送达；
 * 显式 config/env Token 不拉起（配置方自持口令，护测试/冒烟/CI 形态）。
 */
export function shouldAutoOpenBrowser(input: AutoOpenInput): boolean {
  return input.tokenFile !== null;
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
 * 尽力而为：拉起失败（无 GUI/无 xdg-open 等）返回 false，由调用方提示 --print-url 再取通道。
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
