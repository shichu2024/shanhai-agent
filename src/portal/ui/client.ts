// 第七阶段批次二（7-2/4）：API 请求层（15 GET + 5 POST 既有端点，零新增零修改）。
// 统一携带 Authorization: Bearer <sessionStorage Token>；结果归一为
// { ok:true, data } | { ok:false, kind:'network' } | { ok:false, kind:'http', status, code, message }。
// 无 code 的错误体 code 兜底 'unknown'（不虚构码名）；网络层异常归 network（操作结果未知口径）。

export type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'network' }
  | { ok: false; kind: 'http'; status: number; code: string; message: string };

export interface ClientDeps {
  fetchImpl: typeof fetch;
  token: () => string;
}

function headers(deps: ClientDeps, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = deps.token();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function toResult(res: Response): Promise<ApiResult> {
  if (!res.ok) {
    let body: { code?: unknown; message?: unknown } = {};
    try {
      body = (await res.json()) as { code?: unknown; message?: unknown };
    } catch {
      /* 非 JSON 错误体：按 unknown 码如实展示 */
    }
    return {
      ok: false,
      kind: 'http',
      status: res.status,
      code: typeof body.code === 'string' ? body.code : 'unknown',
      message: typeof body.message === 'string' ? body.message : `HTTP ${res.status}`,
    };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, kind: 'network' };
  }
}

export async function apiGet(path: string, deps: ClientDeps): Promise<ApiResult> {
  try {
    const res = await deps.fetchImpl(path, { headers: headers(deps) });
    return await toResult(res);
  } catch {
    return { ok: false, kind: 'network' };
  }
}

export async function apiPost(path: string, body: Record<string, unknown>, deps: ClientDeps): Promise<ApiResult> {
  try {
    const res = await deps.fetchImpl(path, {
      method: 'POST',
      headers: headers(deps, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return await toResult(res);
  } catch {
    return { ok: false, kind: 'network' };
  }
}
