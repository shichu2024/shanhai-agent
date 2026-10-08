import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness, registerAndRelease, validInput, registerL3Tool, approvalSpec } from './helpers.js';
import { startPortalServer, stopPortalServer, type PortalHandle } from '../src/portal/server.js';
import { ResumeService } from '../src/portal/resume.js';

// WP-6B 批次四（6-4/4）：walkthrough 契约钉死（P2-5，设计 §11 批次 6-4 行）——
// 脚本化 headless API 序列断言：node:http 客户端打全链路
//   构造审批（L3 挂起）→ 看到 Paused 任务 → 审批清单/详情 → approve → resume → 终态观测。
// 这是「浏览器能看到 Paused → 查详情 → approve → 触发 resume → 观测终态」的 API 序列等价钉死：
// 前端为静态资产（零构建），按钮接线=API 调用，故 API 序列断言即全链路契约（设计裁定 3 残余风险口径）。
// 稳定性注（TASK-136，对齐 TASK-119 第五批口径）：本文件两用例均为真实 server 往返，
//           统一显式 timeout=20s——防高负载下 vitest 缺省 5s 超时红（trend 族同机理余量不足）。

const AUTH = { Authorization: 'Bearer test-token-0000000000000000000000000000', 'Content-Type': 'application/json' };

interface TestResponse {
  status: number;
  body: string;
}

function request(port: number, method: string, pathName: string, headers: Record<string, string> = {}, body = ''): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const servers: PortalHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await stopPortalServer(s);
});

// ---------- P2-5：headless API 全链路序列（浏览器 walkthrough 的契约形态） ----------

describe('WP6B4-4 walkthrough 契约（P2-5）：构造审批 → approve → resume → 终态观测', () => {
  it('全链路 API 序列（每步响应与库内状态一致）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('walk-agent'));

    // 步骤 0（构造审批，非 API 面）：驱动到 L3 审批挂起——浏览器场景中的「任务已挂起」前置
    h.provider.script.push({ kind: 'tool_use', calls: [{ id: 'w1', toolId: 'l3-op', args: { target: 'prod' } }] });
    h.provider.script.push({ kind: 'text', text: JSON.stringify({ summary: '走查完成', filesCovered: 1, verdict: 'ok' }) });
    const taskId = h.rt.tasks.createTask('walk-agent', validInput, 't');
    const paused = await h.rt.tasks.runTask(taskId);
    expect(paused.status).toBe('paused');
    const pending = h.rt.approvals.pendingForTask(taskId)!;
    expect(pending).not.toBeNull();

    const resume = new ResumeService({
      dataDir: mkdtempSync(path.join(tmpdir(), 'shanhai-walk-')),
      repoRoot: process.cwd(),
      cliEntry: path.resolve('tests/fixtures/resumeChild.mjs'),
    });
    const handle = await startPortalServer(h.rt, {
      dataDir: mkdtempSync(path.join(tmpdir(), 'shanhai-walk-srv-')),
      repoRoot: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-0000000000000000000000000000',
      resume,
    });
    servers.push(handle);
    const get = (p: string) => request(handle.port, 'GET', p, { Authorization: AUTH.Authorization });

    // 步骤 1：任务清单能看到 Paused 任务（walkthrough「看到 Paused 任务」）
    const listRes = await get('/api/tasks?status=paused');
    expect(listRes.status).toBe(200);
    const listBody = JSON.parse(listRes.body) as { tasks?: { taskId: string; status: string }[] };
    const seen = Array.isArray(listBody) ? listBody : listBody.tasks;
    expect(seen!.some((t) => t.taskId === taskId && t.status === 'paused')).toBe(true);

    // 步骤 2：审批清单（pending）能看到挂起请求
    const approvalsRes = await get('/api/approvals?pending=true');
    expect(approvalsRes.status).toBe(200);
    const approvals = JSON.parse(approvalsRes.body);
    const approvalRows = Array.isArray(approvals) ? approvals : approvals.approvals;
    expect(approvalRows!.some((r: { requestId: string }) => r.requestId === pending.requestId)).toBe(true);

    // 步骤 3：审批详情（walkthrough「查看审批详情」）
    const detailRes = await get(`/api/approvals/${pending.requestId}`);
    expect(detailRes.status).toBe(200);
    const detail = JSON.parse(detailRes.body);
    expect(String(JSON.stringify(detail))).toContain('l3-op');

    // 步骤 4：approve → 200；任务保持 Paused（决议与续跑两步明示，§4.4 前端口径）
    const approveRes = await request(handle.port, 'POST', `/api/approvals/${pending.requestId}/approve`, AUTH, '{}');
    expect(approveRes.status).toBe(200);
    expect(JSON.parse(approveRes.body)).toMatchObject({ ok: true, decision: 'approved', taskStatus: 'paused' });

    // 步骤 5：resume → 立即返回 spawned:true + 日志位置（HTTP 不阻塞）
    const resumeRes = await request(handle.port, 'POST', `/api/tasks/${taskId}/resume`, AUTH, '{}');
    expect(resumeRes.status).toBe(200);
    const resumeBody = JSON.parse(resumeRes.body);
    expect(resumeBody).toMatchObject({ ok: true, taskId, spawned: true, resumedBy: 'manual-resume' });
    expect(typeof resumeBody.logFile).toBe('string');

    // 步骤 6：终态观测——续跑至 succeeded（detached 子进程与本进程同款 Manager 调用，WP6B3-6 等价先例）
    const final = await h.rt.tasks.runTask(taskId, null, { resume: true, resumedBy: 'manual-resume' });
    expect(final.status).toBe('succeeded');
    const finalGet = await get(`/api/tasks/${taskId}`);
    expect(JSON.parse(finalGet.body).status).toBe('succeeded');

    // 步骤 7：事件时间线含 approval_decided + task_resumed(manual-resume)（锚点=当前挂起点）
    const eventsRes = await get(`/api/tasks/${taskId}/events`);
    const events = JSON.parse(eventsRes.body) as { eventType: string }[];
    const types = events.map((e) => e.eventType);
    expect(types).toContain('approval_decided');
    expect(types).toContain('task_resumed');
    const resumed = events.find((e) => e.eventType === 'task_resumed') as unknown as { resumedBy: string; requestId: string };
    expect(resumed.resumedBy).toBe('manual-resume');
    expect(resumed.requestId).toBe(pending.requestId);

    // 步骤 8：resume-log 可读（续跑产物留痕）
    await new Promise((r) => setTimeout(r, 1500)); // detached 子进程落日志
    const logRes = await get(`/api/tasks/${taskId}/resume-log`);
    expect(logRes.status).toBe(200);
    const logBody = JSON.parse(logRes.body);
    expect(logBody.ok).toBe(true);
    expect(logBody.content).toContain('--resume');
  });

  it('deny 支线：审批详情 → deny → 任务终态 cancelled(approval_denied)（walkthrough 拒绝路径契约）', { timeout: 20_000 }, async () => {
    const h = makeHarness();
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('walk-deny'));
    h.provider.script.push({ kind: 'tool_use', calls: [{ id: 'd1', toolId: 'l3-op', args: { target: 'x' } }] });
    const taskId = h.rt.tasks.createTask('walk-deny', validInput, 't');
    const paused = await h.rt.tasks.runTask(taskId);
    expect(paused.status).toBe('paused');
    const pending = h.rt.approvals.pendingForTask(taskId)!;

    const handle = await startPortalServer(h.rt, {
      dataDir: mkdtempSync(path.join(tmpdir(), 'shanhai-walk-deny-')),
      repoRoot: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      token: 'test-token-0000000000000000000000000000',
    });
    servers.push(handle);

    const denyRes = await request(handle.port, 'POST', `/api/approvals/${pending.requestId}/deny`, AUTH, JSON.stringify({ reason: '走查拒绝' }));
    expect(denyRes.status).toBe(200);
    expect(JSON.parse(denyRes.body)).toMatchObject({ ok: true, decision: 'denied', taskStatus: 'cancelled', cancelReason: 'approval_denied' });

    const finalGet = await request(handle.port, 'GET', `/api/tasks/${taskId}`, { Authorization: AUTH.Authorization });
    const row = JSON.parse(finalGet.body);
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('approval_denied');
  });
});
