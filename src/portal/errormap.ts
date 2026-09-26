// 第六阶段批次一（§4.1 / D-50）：结构化错误码 → HTTP 状态映射。
// 响应形状对齐 CLI：{ ok:false, code, message, detail? }（cli.ts 错误输出同源字段）。

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  // ApprovalError 族（CAS 透传，A-34 基础）
  already_decided: 409,
  task_not_paused: 409,
  version_mismatch: 409,
  timeout_applied: 409,
  // TrendError 族（批次 6-2 读面全景将消费，先入表）
  invalid_bound: 400,
  invalid_bucket: 400,
};

/** 错误码 → HTTP 状态（未知码 → 500 兜底，不向上抛裸异常面） */
export function apiErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}

export interface ApiErrorBody {
  ok: false;
  code: string;
  message: string;
  detail?: unknown;
}

/** 结构化错误载荷（识别带 code 的 Manager 错误；无 code 的通用错误归 internal_error） */
export function apiErrorPayload(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof Error && typeof (err as Error & { code?: unknown }).code === 'string') {
    const code = (err as Error & { code: string }).code;
    return {
      status: apiErrorStatus(code),
      body: { ok: false, code, message: err.message, detail: (err as Error & { detail?: unknown }).detail ?? undefined },
    };
  }
  if (err instanceof Error && err.message.startsWith('任务不存在')) {
    return { status: 404, body: { ok: false, code: 'not_found', message: err.message } };
  }
  return {
    status: 500,
    body: { ok: false, code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
  };
}
