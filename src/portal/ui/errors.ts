// 第七阶段批次二（7-2/4）：错误分类展示（设计 V0.3 §8 FR-WR-5——错误码面冻结）。
// 码面 = errormap.ts:4-20 全部结构化码 + server.ts 401/403/415/405 + api.ts 400 bad_request
// 与 cancel 前置 409 cross_process_graceful_unsupported；逐码一致、零遗漏、零虚构
// （tests/wp7-2-write-errors.test.ts 测试侧硬编码基线锁定）。
// TASK-128：401 文案去技术化——最终用户不应需要理解 Token/Bearer/Authorization；
// 恢复路径指向自动送达（每次启动自动拉起浏览器），而非要求用户操作口令。

/** 读面 401 专属提示（各页面 content 区整屏态；与 UI_ERROR_TEXT.unauthorized 同口径） */
export const AUTH_EXPIRED_TEXT = '登录状态已失效——请从启动门户的终端重新打开（启动时会自动完成登录，无需手动操作）';

export const UI_ERROR_TEXT: Record<string, string> = {
  // server.ts 错误面
  unauthorized: AUTH_EXPIRED_TEXT,
  host_forbidden: '仅供本机访问',
  unsupported_media_type: '不应出现的 415（unsupported_media_type）——前端只用 GET/POST + JSON，出现即前端缺陷，已如实展示',
  method_not_allowed: '不应出现的 405（method_not_allowed）——前端只用 GET/POST，出现即前端缺陷，已如实展示',
  // api.ts 参数校验
  bad_request: '请求参数无效',
  invalid_task_id: '请求参数无效（taskId 白名单违规）',
  invalid_ref: '证据 ref 格式非法',
  invalid_bound: '趋势时间参数非法（invalid_bound）',
  invalid_bucket: '趋势 bucket 参数非法（invalid_bucket）',
  // errormap 结构化码
  not_found: '对象不存在（可能已终局），刷新查看',
  already_decided: '该审批已决议（approve/deny 竞态后到方），刷新查看',
  task_not_paused: '任务当前状态不可续跑（已续跑或已终局）',
  version_mismatch: '审批绑定版本与任务当前版本不一致，刷新核对',
  timeout_applied: '请求已被惰性超时终局（denied + 任务终局），刷新查看',
  cross_process_graceful_unsupported: '跨进程任务不支持优雅取消——请改用强制中止（force）',
  not_implemented: '该能力为预留位，暂未实现（not_implemented）',
};

export const NETWORK_ERROR_TEXT = '连接断开，操作结果未知——刷新核对后重试';

export type ApiFailure = { ok: false; kind: 'network' } | { ok: false; kind: 'http'; status: number; code: string; message: string };

/** 分类文案：network → 断网口径；已知码 → 专属文案；未知码 → 如实展示 code 与服务端 message */
export function explainFailure(failure: ApiFailure): string {
  if (failure.kind === 'network') return NETWORK_ERROR_TEXT;
  const known = UI_ERROR_TEXT[failure.code];
  if (known) return known;
  return `${failure.code}：${failure.message}`;
}
