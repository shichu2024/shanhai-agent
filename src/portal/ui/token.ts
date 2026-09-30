// 第七阶段批次一（7-1/4）：Token 会话（FR-G-1，TASK-96 契约镜像）。
// 硬性底线（TASK-81）：Token 不写入任何静态资产文件——仅经输入框存 sessionStorage（会话级，
// 禁止 localStorage），运行期注入请求头；#token= fragment 一次性消费后即从地址栏抹除。
// 注意：consumeTokenFragment 的三行实现为 tests/wp6d-task96-portal-auto-open.test.ts 镜像契约
// 锁定的字面量（防漂移钉死），不得改写。

export const TOKEN_KEY = 'shanhai-portal-token';

export function loadToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function saveToken(value: string): void {
  sessionStorage.setItem(TOKEN_KEY, value);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** 消费 URL fragment 中的 Token（#token=...，CLI 首启自动拉起浏览器注入）——与 src/portal/browser.ts tokenFromFragment 同源镜像；fragment 不发往服务端，读取后即从地址栏抹除。注意：本行引号为 esbuild 打印器形态（双引号），与产物逐字一致。 */
export function consumeTokenFragment(): string | null {
  const m = /^#token=(.+)$/.exec(location.hash);
  if (!m) return null;
  saveToken(m[1]);
  history.replaceState(null, "", location.pathname + location.search);
  return m[1];
}
