import { describe, expect, it, vi } from 'vitest';
import { cancelModeFor, confirmCrashRecoveryText, resumeNote } from '../src/portal/view/write.js';
import { NETWORK_ERROR_TEXT, UI_ERROR_TEXT, explainFailure } from '../src/portal/ui/errors.js';
import {
  approveOp,
  cancelOp,
  crashRecoveryOp,
  createWriteGate,
  denyOp,
  resumeFeedback,
  resumeOp,
  runWrite,
  type WriteOp,
} from '../src/portal/ui/writeFlow.js';
import { apiGet, apiPost } from '../src/portal/ui/client.js';

// 第七阶段批次二（7-2/4）：写操作通用规范（设计 V0.3 §8 FR-WR-1..6）——
// 确认分级四类契约文案逐字复用 view/write.ts、乐观禁用、resume 后续指引（resumeNote 原文 + CLI 兜底）、
// 错误分类展示与 errormap.ts / server.ts 实测错误面逐码一致。TDD 红阶段先行。

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

// ---------- FR-WR-1 确认分级（契约文案逐字） ----------

describe('7-2 writeFlow 写操作构造（FR-WR-1 四级确认）', () => {
  it('cancel：mode 取 cancelModeFor 默认档；confirm 文本=对应分支 hint（逐字）', () => {
    const paused = cancelOp('t-1', 'paused');
    expect(paused.path).toBe('/api/tasks/t-1/cancel');
    expect(paused.body).toEqual({ mode: 'graceful' });
    expect(paused.confirmText).toBe(cancelModeFor('paused').hint);
    const running = cancelOp('t-2', 'running');
    expect(running.body).toEqual({ mode: 'force' });
    expect(running.confirmText).toBe(cancelModeFor('running').hint);
  });

  it('crash-recovery：全局端点无 :id；confirm 文本=confirmCrashRecoveryText(n)（逐字）', () => {
    const op = crashRecoveryOp(3);
    expect(op.path).toBe('/api/portal/crash-recovery');
    expect(op.confirmText).toBe(confirmCrashRecoveryText(3));
  });

  it('resume / approve / deny：无 confirmText（FR-WR-1④ 点击即提交）', () => {
    expect(resumeOp('t-1').confirmText).toBeUndefined();
    expect(approveOp('r-1').confirmText).toBeUndefined();
    expect(denyOp('r-1').confirmText).toBeUndefined();
    expect(approveOp('r-1').path).toBe('/api/approvals/r-1/approve');
    expect(denyOp('r-1').path).toBe('/api/approvals/r-1/deny');
    expect(resumeOp('t-1').path).toBe('/api/tasks/t-1/resume');
  });
});

describe('7-2 runWrite（确认门 + 结果分类）', () => {
  const okDeps = (confirmBox = () => true) => ({
    confirmBox,
    post: vi.fn(async () => jsonResponse({ ok: true })),
  });

  it('有 confirmText：confirmBox 收到逐字文案；用户拒绝 → cancelled-by-user 不发请求', async () => {
    const texts: string[] = [];
    const deps = {
      confirmBox: (t: string) => { texts.push(t); return false; },
      post: vi.fn(async () => jsonResponse({ ok: true })),
    };
    const out = await runWrite(cancelOp('t-1', 'paused'), deps);
    expect(texts).toEqual([cancelModeFor('paused').hint]);
    expect(deps.post).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: false, kind: 'cancelled-by-user' });
  });

  it('无 confirmText：直接提交', async () => {
    const deps = okDeps();
    const out = await runWrite(approveOp('r-1'), deps);
    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, kind: 'success' });
  });

  it('失败：透传 http 分类载荷（code/status/message）', async () => {
    const deps = { confirmBox: () => true, post: vi.fn(async () => ({ ok: false, kind: 'http', status: 409, code: 'task_not_paused', message: 'm' } as const)) };
    const out = await runWrite(resumeOp('t-1'), deps);
    expect(out).toMatchObject({ ok: false, kind: 'failure', status: 409, code: 'task_not_paused' });
  });

  it('断网：kind=network（操作结果未知）', async () => {
    const deps = { confirmBox: () => true, post: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) };
    const out = await runWrite(resumeOp('t-1'), deps);
    expect(out).toMatchObject({ ok: false, kind: 'network' });
  });

  it('FR-WR-2 乐观禁用：gate 在途期间 acquire=false，双击只发 1 个请求', async () => {
    const gate = createWriteGate();
    expect(gate.acquire()).toBe(true);
    expect(gate.acquire()).toBe(false); // 在途
    gate.release();
    expect(gate.acquire()).toBe(true);
    gate.release();
  });
});

// ---------- FR-WR-4 resume 后续指引 ----------

describe('7-2 resumeFeedback（FR-WR-4：resumeNote 原文 + CLI 兜底 + 日志链接）', () => {
  it('spawned=true：note=resumeNote 原文；CLI 命令逐字；日志链接指向 resume-log 端点', () => {
    const result = { taskId: 't-9', spawned: true, logFile: 'D:\\logs\\resume-t-9.log' };
    const fb = resumeFeedback(result, 't-9');
    expect(fb.note).toBe(resumeNote(result));
    expect(fb.cli).toBe('shanhai task run t-9 --resume --resumed-by manual-resume');
    expect(fb.logUrl).toBe('/api/tasks/t-9/resume-log');
  });

  it('spawned=false：note=「续跑子进程未启动」', () => {
    const fb = resumeFeedback({ taskId: 't-9', spawned: false, logFile: '' }, 't-9');
    expect(fb.note).toBe('续跑子进程未启动');
  });
});

// ---------- FR-WR-5 错误分类（码面与 errormap.ts / server.ts 逐码一致） ----------

describe('7-2 错误码面（FR-WR-5 逐码一致）', () => {
  // 冻结基线（errormap.ts:4-20 十一码 + server.ts 401/403/415/405 四码 + api.ts bad_request + cancel 前置 409）：
  // 测试侧硬编码锁定，UI 错误面零遗漏、零虚构。
  const EXPECTED_FACE = [
    'already_decided',            // errormap 409
    'bad_request',                // api.ts 参数校验 400
    'cross_process_graceful_unsupported', // api.ts cancel 前置 409
    'host_forbidden',             // server.ts 403
    'invalid_bound',              // errormap 400（trend）
    'invalid_bucket',             // errormap 400（trend）
    'invalid_ref',                // errormap 400（evidence）
    'invalid_task_id',            // errormap 400（resume）
    'method_not_allowed',         // server.ts 405
    'not_found',                  // errormap 404
    'not_implemented',            // errormap 501（eval 预留位）
    'task_not_paused',            // errormap 409（resume）
    'timeout_applied',            // errormap 409（approve）
    'unauthorized',               // server.ts 401
    'unsupported_media_type',     // server.ts 415
    'version_mismatch',           // errormap 409（approve）
  ].sort();

  it('UI_ERROR_TEXT 覆盖全部实测错误码，零遗漏零虚构', () => {
    expect(Object.keys(UI_ERROR_TEXT).sort()).toEqual(EXPECTED_FACE);
  });

  it('关键分类文案（FR-WR-5 逐字要点）', () => {
    expect(UI_ERROR_TEXT.not_found).toBe('对象不存在（可能已终局），刷新查看');
    expect(UI_ERROR_TEXT.already_decided).toBe('该审批已决议（approve/deny 竞态后到方），刷新查看');
    expect(UI_ERROR_TEXT.task_not_paused).toBe('任务当前状态不可续跑（已续跑或已终局）');
    expect(UI_ERROR_TEXT.version_mismatch).toBe('审批绑定版本与任务当前版本不一致，刷新核对');
    expect(UI_ERROR_TEXT.timeout_applied).toBe('请求已被惰性超时终局（denied + 任务终局），刷新查看');
    expect(UI_ERROR_TEXT.unauthorized).toContain('Token');
    expect(UI_ERROR_TEXT.host_forbidden).toBe('仅供本机访问');
    expect(UI_ERROR_TEXT.bad_request).toBe('请求参数无效');
    expect(UI_ERROR_TEXT.cross_process_graceful_unsupported).toContain('强制中止');
  });

  it('断网文案（§8 断网口径逐字）', () => {
    expect(NETWORK_ERROR_TEXT).toBe('连接断开，操作结果未知——刷新核对后重试');
  });

  it('explainFailure：network → 断网文案；http 已知码 → 分类文案；未知码 → 如实展示 code+message', () => {
    expect(explainFailure({ ok: false, kind: 'network' })).toBe(NETWORK_ERROR_TEXT);
    expect(explainFailure({ ok: false, kind: 'http', status: 409, code: 'already_decided', message: 'm' })).toBe(UI_ERROR_TEXT.already_decided);
    expect(explainFailure({ ok: false, kind: 'http', status: 500, code: 'weird_new_code', message: 'boom' })).toContain('weird_new_code');
    expect(explainFailure({ ok: false, kind: 'http', status: 500, code: 'weird_new_code', message: 'boom' })).toContain('boom');
  });
});

// ---------- client（请求层） ----------

describe('7-2 client（GET/POST 统一携带 Bearer Token + 结果归一）', () => {
  const deps = { fetchImpl: vi.fn(async () => jsonResponse({ ok: true, data: 1 })), token: () => 'tok-c' };

  it('GET：Authorization 头 + ok 归一', async () => {
    const r = await apiGet('/api/tasks', deps);
    expect(r).toEqual({ ok: true, data: { ok: true, data: 1 } });
    expect(deps.fetchImpl).toHaveBeenCalledWith('/api/tasks', { headers: { Authorization: 'Bearer tok-c' } });
  });

  it('POST：method/body/Content-Type', async () => {
    await apiPost('/api/tasks/t-1/cancel', { mode: 'force' }, deps);
    const calls = (deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-c');
    expect(init.body).toBe(JSON.stringify({ mode: 'force' }));
  });

  it('HTTP 错误：status/code/message 归一（服务端 { ok:false, code, message }）', async () => {
    const d2 = { fetchImpl: vi.fn(async () => jsonResponse({ ok: false, code: 'not_found', message: '任务不存在' }, 404)), token: () => 't' };
    const r = await apiGet('/api/tasks/none', d2);
    expect(r).toEqual({ ok: false, kind: 'http', status: 404, code: 'not_found', message: '任务不存在' });
  });

  it('无 code 的错误体：code 兜底 unknown（不虚构码名）', async () => {
    const d3 = { fetchImpl: vi.fn(async () => jsonResponse({ ok: false, message: 'x' }, 500)), token: () => 't' };
    const r = (await apiGet('/api/tasks', d3)) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('unknown');
  });

  it('网络异常 → kind=network', async () => {
    const d4 = { fetchImpl: vi.fn(async () => { throw new TypeError('Failed to fetch'); }), token: () => 't' };
    expect(await apiGet('/api/tasks', d4)).toEqual({ ok: false, kind: 'network' });
  });

  it('无 Token：仍发请求（由服务端 401 裁决，前端不预判）', async () => {
    const d5 = { fetchImpl: vi.fn(async () => jsonResponse({ ok: false, code: 'unauthorized', message: 'm' }, 401)), token: () => '' };
    const r = await apiGet('/api/tasks', d5);
    expect(r).toMatchObject({ ok: false, status: 401, code: 'unauthorized' });
  });
});

// ---------- FR-WR-6 不可变物 ----------

describe('7-2 FR-WR-6 不可变物（write.ts 四函数经 UI 直接复用，逐字零改写）', () => {
  it('UI 确认文案全部来自 view/write.ts 原函数（同源引用，非抄写）', async () => {
    const seen: string[] = [];
    const op: WriteOp = cancelOp('t-x', 'queued');
    await runWrite(op, { confirmBox: (t) => { seen.push(t); return false; }, post: vi.fn() });
    expect(seen[0]).toBe(cancelModeFor('queued').hint);
  });
});
