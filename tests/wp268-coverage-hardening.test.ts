import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { Runtime } from '../src/runtime.js';
import { ApprovalError } from '../src/modules/approval.js';
import { mountTaskDetailPage } from '../src/portal/ui/taskDetailPage.js';
import { mountObserveCapabilitiesPage } from '../src/portal/ui/observeCapabilitiesPage.js';
import { mountAgentsPage, mountAgentDetailPage } from '../src/portal/ui/agentsPage.js';
import { AUTH_EXPIRED_TEXT, NETWORK_ERROR_TEXT } from '../src/portal/ui/errors.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import {
  clickEvent,
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
  type StubDoc,
  type StubEl,
} from './wp7-3-mount-stubs.js';
import { makeHarness, sampleSpec, registerAndRelease, registerL3Tool, approvalSpec, validInput, validOutput, type Harness } from './helpers.js';

// wp268（第五十四批 · 覆盖加固蓄量）：纯测试触达的低风险分支补测，零 src 改动。
// 覆盖面分组：
//  ① taskManager CAS 竞争分支 ×5（runTask/runDelegatedChild Queued→Running、resume Paused→Running、
//     cancel Queued/Paused→Cancelled）——以真实 SQLite BEFORE UPDATE 触发器 RAISE(IGNORE) 模拟
//     「并发进程先落库」窗口（UPDATE 静默放弃 → changes=0 → CAS 返回 false），不 mock 任何源码；
//  ② taskManager 委托孤儿处置 ×2（cancelDescendants 终态子跳过 / 子迁移失败跳过）；
//  ③ taskManager 未分类异常 → Failed:Runtime(internal_error) ×1（落库 input 损坏防御路径）；
//  ④ approval 竞争分支 ×5（approve/deny claim 失败、deny 任务 CAS 失败、惰性超时 claim 失败 / 任务 CAS 失败）
//     ——同为真实触发器模拟并发裁决窗口；
//  ⑤ taskDetailPage 写流与交互边界 ×9（终态 refresh 短路/无 resume 反馈日志短路/写门二次提交忽略/
//     确认拒绝/写 network 与 http 失败反馈/点击未命中/copy-id/事件过滤 checked 双向）；
//  ⑥ observeCapabilitiesPage ×2（矩阵面 401 → 认证失效停轮询/点击与筛选未命中）；
//  ⑦ agentsPage ×5（目录与详情 401 后 retry 短路/目录与详情点击未命中/详情 insight 分区错误）；
//  ⑧ taskManager 挂起窗口取消/中止竞速行为回归 ×4（补修批：反方探针机理独立复现的实测结论）
//     ——按反方配方在原子调用在飞窗口注入取消（cancel() running 分支同步置位进程内标志）或
//     持久化中止标志（直写 abortRequested=1），断言「取消/中止优先于挂起」不变式：主/父任务
//     终局 cancelled（user/abort）、委托场景子任务取消传播 superseded、不落 Paused 快照。
//     实测（JSON 行覆盖证据）：终局由 executor.ts:416/421 边界断言（循环顶 189-190 / 模型调用后
//     252-253 / 每工具后 317-318 三重检查点）经 taskManager.ts:473/591-599 产生，435-436/439-440/
//     448-450/453-455 四分支未被命中——L3 审批门在 ToolExecutor.execute 同步段抛出，最后一个
//     检查点与挂起信号上浮到 runTask catch 之间全为微任务（无真实异步边界），单线程测试代码
//     不可注入；该四分支为跨进程微秒级竞速窗口防御。豁免口径已按实测改写（含已尝试测法与失败点）。
// 零 src 改动、零门值改动、零既有用例改动。

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const validJson = JSON.stringify(validOutput());

function dbOf(rt: Runtime): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

/** 真实 SQLite 触发器：使目标 UPDATE 静默放弃（changes=0）——模拟并发进程在同一窗口先落库 */
function blockUpdate(db: Database.Database, trigger: string, table: 'task_record' | 'approval_request', when: string): void {
  db.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table} WHEN ${when} BEGIN SELECT RAISE(IGNORE); END;`);
}

/** 驱动到 Paused：模型请求 L3 工具 → 挂起即退出（runTask 返回 Paused 行）——wp257 同款基座 */
async function driveToPaused(h: Harness, agentId: string) {
  registerL3Tool(h);
  registerAndRelease(h.rt, approvalSpec(agentId));
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const row = await h.rt.tasks.runTask(taskId);
  expect(row.status).toBe('paused');
  const request = h.rt.approvals.pendingForTask(taskId)!;
  expect(request).not.toBeNull();
  return { taskId, request };
}

/** 直插一条挂靠父任务的子任务行（构造孤儿处置入参；绕过委托原语路径） */
function insertChild(db: Database.Database, parentTaskId: string, childTaskId: string, status: string): void {
  db.prepare(
    `INSERT INTO task_record (taskId, agentId, agentVersionId, specContentHash, input, status, createdAt, traceFile, parentTaskId, delegationDepth)
     VALUES (?,?,?,?,?,?,?,?,?,1)`,
  ).run(childTaskId, 'wp268-child-agent', 'wp268-child-ver', 'hash-wp268', '{}', status, '2026-11-01T00:00:00.000000000Z', 'trace-child.jsonl', parentTaskId);
}

// ---------- ① taskManager CAS 竞争分支（触发器模拟并发先落库） ----------

describe('wp268 taskManager CAS 竞争分支（真实触发器模拟并发窗口）', () => {
  it('runTask：Queued→Running 被并发先取（CAS 失败）→ 抛状态竞争且任务留 Queued', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp268-cas-run' }));
    const taskId = h.rt.tasks.createTask('wp268-cas-run', validInput, 't');
    blockUpdate(dbOf(h.rt), 'wp268_t_run', 'task_record', `NEW.status='running' AND OLD.status='queued'`);
    await expect(h.rt.tasks.runTask(taskId)).rejects.toThrowError(/Queued→Running 迁移失败.*当前 queued/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('queued'); // 未被本进程重复执行
  });

  it('runTask --resume：Paused→Running 被并发 resume 先取（CAS 失败）→ 抛迁移权竞争且任务留 Paused', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId, request } = await driveToPaused(h, 'wp268-cas-resume');
    h.rt.approvals.approve(request.requestId, 'wp268');
    blockUpdate(dbOf(h.rt), 'wp268_t_resume', 'task_record', `NEW.status='running' AND OLD.status='paused'`);
    await expect(h.rt.tasks.runTask(taskId, null, { resume: true })).rejects.toThrowError(/Paused→Running 已由其他进程完成.*当前 paused/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  });

  it('runDelegatedChild：Queued→Running 被并发先取（CAS 失败）→ 抛委托子任务状态竞争', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp268-cas-deleg' }));
    const taskId = h.rt.tasks.createTask('wp268-cas-deleg', validInput, 't');
    blockUpdate(dbOf(h.rt), 'wp268_t_deleg', 'task_record', `NEW.status='running' AND OLD.status='queued'`);
    await expect(h.rt.tasks.runDelegatedChild(taskId, { requested: () => false })).rejects.toThrowError(/委托子任务.*Queued→Running 迁移失败.*当前 queued/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('queued');
  });

  it('cancel：Queued→Cancelled 被并发先取（CAS 失败）→ 抛状态竞争（按当前状态重试口径）', () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp268-cas-cq' }));
    const taskId = h.rt.tasks.createTask('wp268-cas-cq', validInput, 't');
    blockUpdate(dbOf(h.rt), 'wp268_t_cq', 'task_record', `NEW.status='cancelled' AND OLD.status='queued'`);
    expect(() => h.rt.tasks.cancel(taskId, 'user')).toThrowError(/取消时任务已离开 Queued.*当前 queued/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('queued');
  });

  it('cancel：Paused→Cancelled 被并发 resume 先取（CAS 失败）→ 抛状态竞争（--force 指引口径）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId } = await driveToPaused(h, 'wp268-cas-cp');
    blockUpdate(dbOf(h.rt), 'wp268_t_cp', 'task_record', `NEW.status='cancelled' AND OLD.status='paused'`);
    expect(() => h.rt.tasks.cancel(taskId, 'user')).toThrowError(/取消时任务已离开 Paused.*当前 paused/);
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  });
});

// ---------- ② taskManager 委托孤儿处置（cancelDescendants） ----------

describe('wp268 cancelDescendants：父取消传播的子任务分支', () => {
  it('父 Paused 取消 → 已终态（succeeded）子任务跳过不覆写', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId } = await driveToPaused(h, 'wp268-orph-done');
    const db = dbOf(h.rt);
    insertChild(db, taskId, 'wp268-child-done', 'succeeded');
    const result = h.rt.tasks.cancel(taskId, 'user');
    expect(result.mode).toBe('graceful');
    expect(h.rt.tasks.getTask(taskId).status).toBe('cancelled');
    const child = db.prepare('SELECT status, cancelReason FROM task_record WHERE taskId=?').get('wp268-child-done') as { status: string; cancelReason: string | null };
    expect(child.status).toBe('succeeded'); // 终态不被覆写
    expect(child.cancelReason).toBeNull(); // 不补写 superseded
  });

  it('父 Paused 取消 → 子任务 Paused→Cancelled 迁移失败（并发先落库）→ 跳过不阻塞父取消', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId } = await driveToPaused(h, 'wp268-orph-race');
    const db = dbOf(h.rt);
    insertChild(db, taskId, 'wp268-child-race', 'paused');
    blockUpdate(db, 'wp268_t_child', 'task_record', `NEW.status='cancelled' AND OLD.status='paused' AND NEW.taskId='wp268-child-race'`);
    h.rt.tasks.cancel(taskId, 'user'); // 不因子迁移失败抛错
    expect(h.rt.tasks.getTask(taskId).status).toBe('cancelled'); // 父终局不受阻
    const child = db.prepare('SELECT status FROM task_record WHERE taskId=?').get('wp268-child-race') as { status: string };
    expect(child.status).toBe('paused'); // 子留原状态（先落库者生效口径）
  });
});

// ---------- ③ taskManager 未分类异常终局 ----------

describe('wp268 executeLoop 未分类异常 → Failed:Runtime(internal_error)', () => {
  it('落库 input 损坏（非法 JSON）→ JSON.parse 抛错走兜底终局（不悬挂在 Running）', async () => {
    const h = makeHarness([{ kind: 'text', text: validJson }]);
    registerAndRelease(h.rt, sampleSpec({ agentId: 'wp268-corrupt' }));
    const taskId = h.rt.tasks.createTask('wp268-corrupt', validInput, 't');
    dbOf(h.rt).prepare('UPDATE task_record SET input=? WHERE taskId=?').run('{not-json', taskId);
    const row = await h.rt.tasks.runTask(taskId);
    expect(row.status).toBe('failed');
    const rec = dbOf(h.rt).prepare('SELECT failureClass, subClass, message FROM failure_record WHERE taskId=?').get(taskId) as { failureClass: string; subClass: string; message: string };
    expect(rec.failureClass).toBe('Runtime');
    expect(rec.subClass).toBe('internal_error');
    expect(rec.message).toContain('未分类异常');
  });
});

// ---------- ④ approval 竞争分支（真实触发器模拟并发裁决） ----------

describe('wp268 approval 竞争分支（先落库者生效）', () => {
  it('approve：claim UPDATE 被并发裁决抢先（changes=0）→ already_decided，decision 不被覆写', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId, request } = await driveToPaused(h, 'wp268-ap-race');
    blockUpdate(dbOf(h.rt), 'wp268_t_ap', 'approval_request', `OLD.decision='pending' AND NEW.decision='approved'`);
    let caught: unknown;
    try { h.rt.approvals.approve(request.requestId, 'wp268'); } catch (e) { caught = e; }
    expect((caught as ApprovalError).code).toBe('already_decided');
    const after = h.rt.approvals.getRequest(request.requestId)!;
    expect(after.decision).toBe('pending'); // 并发语义：无第二次覆写
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 任务不动（迁移权在 resume）
  });

  it('deny：claim UPDATE 被并发裁决抢先（changes=0）→ already_decided，不写 Trace 不迁移', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId, request } = await driveToPaused(h, 'wp268-dn-race');
    blockUpdate(dbOf(h.rt), 'wp268_t_dn', 'approval_request', `OLD.decision='pending' AND NEW.decision='denied'`);
    let caught: unknown;
    try { h.rt.approvals.deny(request.requestId, 'wp268'); } catch (e) { caught = e; }
    expect((caught as ApprovalError).code).toBe('already_decided');
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('pending');
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  });

  it('deny：claim 成功但任务 Paused→Cancelled 被并发 resume 先取 → task_not_paused（denied 审计已落）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId, request } = await driveToPaused(h, 'wp268-dn-cas');
    blockUpdate(dbOf(h.rt), 'wp268_t_dncas', 'task_record', `NEW.status='cancelled' AND OLD.status='paused'`);
    let caught: unknown;
    try { h.rt.approvals.deny(request.requestId, 'wp268'); } catch (e) { caught = e; }
    expect((caught as ApprovalError).code).toBe('task_not_paused');
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('denied'); // 表内裁决不回滚（防审计漂移）
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  });

  it('惰性超时：claim UPDATE 被并发裁决抢先（changes=0）→ 整行跳过，任务不动', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId, request } = await driveToPaused(h, 'wp268-lt-claim');
    const db = dbOf(h.rt);
    db.prepare('UPDATE approval_request SET timeoutAt=? WHERE requestId=?').run('2020-01-01T00:00:00.000000000Z', request.requestId); // 已超时
    blockUpdate(db, 'wp268_t_ltclaim', 'approval_request', `OLD.decision='pending' AND NEW.decision='denied'`);
    const touched = h.rt.approvals.applyLazyTimeouts();
    expect(touched).toEqual([]); // 无终局
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('pending');
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused');
  });

  it('惰性超时：claim 成功但任务 Paused→Cancelled 被并发 resume 先取 → 跳过终局（denied 已落、快照保留）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    const { taskId, request } = await driveToPaused(h, 'wp268-lt-cas');
    const db = dbOf(h.rt);
    db.prepare('UPDATE approval_request SET timeoutAt=? WHERE requestId=?').run('2020-01-01T00:00:00.000000000Z', request.requestId);
    blockUpdate(db, 'wp268_t_ltcas', 'task_record', `NEW.status='cancelled' AND OLD.status='paused'`);
    const touched = h.rt.approvals.applyLazyTimeouts();
    expect(touched).toEqual([]);
    expect(h.rt.approvals.getRequest(request.requestId)!.decision).toBe('denied'); // 表内裁决已认领
    expect(h.rt.tasks.getTask(taskId).status).toBe('paused'); // 不重复终局
    expect(h.rt.approvals.getSnapshot(taskId)).not.toBeNull(); // deleteSnapshot 未执行（跳过路径）
  });
});

// ---------- ⑧ taskManager 挂起信号 vs 取消/中止竞速窗口（await 缝注入，补修批） ----------

describe('wp268 挂起窗口取消/中止竞速（反方探针配方独立复现：行为回归 + 行覆盖实测）', () => {
  it('在飞模型调用窗口内 cancel → 终局 cancelled/user、不落 Paused（取消优先不变式；实测经边界断言路径）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('wp268-race-cancel'));
    const taskId = h.rt.tasks.createTask('wp268-race-cancel', validInput, 't');
    const pending = h.rt.tasks.runTask(taskId); // 同步段：循环顶检查（标志未置）→ 模型调用 await 让出
    h.rt.tasks.cancel(taskId, 'user'); // 在飞窗口：running 分支同步置位进程内 cancelRequested
    const row = await pending; // 模型返回后 executor.ts:252 边界断言先行终局（JSON 覆盖证实未达 435-436）
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('user');
    expect(h.rt.approvals.pendingForTask(taskId)).toBeNull(); // 挂起序列未持久化
    expect(h.rt.approvals.getSnapshot(taskId)).toBeNull();
  });

  it('在飞模型调用窗口内直写 abortRequested=1 → 终局 cancelled/abort、标志复位（实测经边界断言路径）', async () => {
    const h = makeHarness([{ kind: 'tool_use', calls: [{ id: 'a1', toolId: 'l3-op', args: { target: 'x' } }] }]);
    registerL3Tool(h);
    registerAndRelease(h.rt, approvalSpec('wp268-race-abort'));
    const taskId = h.rt.tasks.createTask('wp268-race-abort', validInput, 't');
    const pending = h.rt.tasks.runTask(taskId);
    dbOf(h.rt).prepare('UPDATE task_record SET abortRequested=1 WHERE taskId=?').run(taskId); // 在飞窗口直写（跨进程持久化标志）
    const row = await pending; // executor.ts:253 边界断言重读 DB 先行终局（JSON 覆盖证实未达 439-440）
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('abort');
    expect(row.abortRequested).toBe(0); // 终局写回复位
    expect(h.rt.approvals.getSnapshot(taskId)).toBeNull();
  });

  it('委托在飞窗口内 cancel 父 → 父终局 cancelled/user、子取消传播 superseded（实测经子循环边界断言路径）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: { agentId: 'wp268-race-child', input: validInput, note: 'n' } }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, delegateParentSpecOf('wp268-race-parent', ['wp268-race-child']));
    registerAndRelease(h.rt, approvalSpec('wp268-race-child'));
    const parentTaskId = h.rt.tasks.createTask('wp268-race-parent', validInput, 't');
    const firstPause = await h.rt.tasks.runTask(parentTaskId); // 第一次人工介入：task-delegate 审批挂起
    expect(firstPause.status).toBe('paused');
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const pending = h.rt.tasks.runTask(parentTaskId, null, { resume: true }); // 同步段：子创建并内联执行至子模型调用 await
    h.rt.tasks.cancel(parentTaskId, 'user'); // 在飞窗口：父 running → 置位父 cancelRequested（子循环经 parentCancel 代查可见）
    const row = await pending; // 子模型返回后子循环边界断言先行 → 子 superseded 终局，信号上浮父终局（未达 448-450）
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('user');
    expect(h.rt.approvals.getSnapshot(parentTaskId)).toBeNull(); // 委托等待挂起未持久化
    const child = childrenOfRun(h.rt, parentTaskId)[0]; // 孤儿处置：非终态子取消传播覆盖
    expect(child.status).toBe('cancelled');
    expect(child.cancelReason).toBe('superseded');
  });

  it('委托在飞窗口内直写父 abortRequested=1 → 父终局 cancelled/abort、子取消传播 superseded（实测经子循环边界断言路径）', async () => {
    const h = makeHarness([
      { kind: 'tool_use', calls: [{ id: 'd1', toolId: 'task-delegate', args: { agentId: 'wp268-race-child2', input: validInput, note: 'n' } }] },
      { kind: 'tool_use', calls: [{ id: 'c1', toolId: 'l3-op', args: { target: 'x' } }] },
    ]);
    registerL3Tool(h);
    registerAndRelease(h.rt, delegateParentSpecOf('wp268-race-parent2', ['wp268-race-child2']));
    registerAndRelease(h.rt, approvalSpec('wp268-race-child2'));
    const parentTaskId = h.rt.tasks.createTask('wp268-race-parent2', validInput, 't');
    await h.rt.tasks.runTask(parentTaskId);
    h.rt.approvals.approve(h.rt.approvals.pendingForTask(parentTaskId)!.requestId, 'human');
    const pending = h.rt.tasks.runTask(parentTaskId, null, { resume: true });
    dbOf(h.rt).prepare('UPDATE task_record SET abortRequested=1 WHERE taskId=?').run(parentTaskId); // 在飞窗口直写父标志（子循环 parentCancel 代查可见）
    const row = await pending; // 子循环边界断言先行 → 子 superseded 终局，信号上浮父终局（未达 453-455）
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('abort');
    expect(row.abortRequested).toBe(0);
    const child = childrenOfRun(h.rt, parentTaskId)[0];
    expect(child.status).toBe('cancelled');
    expect(child.cancelReason).toBe('superseded');
  });
});

/** 委托父 Spec（task-delegate L3 + 白名单 + onHighRisk）——wp4b 同款基座 */
function delegateParentSpecOf(agentId: string, whitelist: string[]): Record<string, unknown> {
  return sampleSpec({
    agentId,
    tools: [{ toolId: 'task-delegate', riskLevel: 'L3', controlledFields: { targetWhitelist: whitelist } }],
    extraTop: { approvalPolicy: { mode: 'onHighRisk', timeoutMs: 86400000 } },
  });
}

function childrenOfRun(rt: Runtime, parentTaskId: string): { taskId: string; status: string; cancelReason: string | null }[] {
  return dbOf(rt)
    .prepare('SELECT taskId, status, cancelReason FROM task_record WHERE parentTaskId = ? ORDER BY createdAt')
    .all(parentTaskId) as { taskId: string; status: string; cancelReason: string | null }[];
}

// ---------- ⑤ taskDetailPage 写流与交互边界 ----------

interface DetailFixture {
  view: StubEl;
  doc: StubDoc;
  timers: Array<{ fn: () => void; ms: number }>;
  paths: Array<{ method: string; path: string }>;
  confirmBox: (t: string) => boolean;
}

function baseTask(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'task-wp268aaaa',
    agentId: 'ag-wp268',
    agentVersionId: 'ver-268',
    specContentHash: 'hash-268',
    input: JSON.stringify({ topic: 't' }, null, 2),
    status: 'paused',
    attemptCount: 1,
    modelCallCount: 3,
    tokensUsed: 1234,
    consecutiveDenialCount: 0,
    createdAt: '2026-11-01T10:00:00.000Z',
    startedAt: '2026-11-01T10:00:05.000Z',
    endedAt: null,
    traceFile: 'trace.jsonl',
    terminalFailureClass: null,
    abortRequested: 0,
    pausedDurationMs: 0,
    cancelReason: null,
    assignmentSource: null,
    parentTaskId: null,
    delegationDepth: 0,
    ...partial,
  };
}

const detailEvents = [
  { eventId: 'e-1', eventType: 'task_created', timestamp: '2026-11-01T10:00:00.000Z', callNo: 0, callKind: null, attemptNo: 1 },
  { eventId: 'e-2', eventType: 'task_paused', timestamp: '2026-11-01T10:01:00.000Z', callNo: 3, callKind: 'tool', attemptNo: 1 },
];

/** 任务详情页挂载基座：GET 四读面按入参任务渲染；POST 行为由各用例注入 */
function mountDetail(
  task: Record<string, unknown>,
  post: (path: string) => Promise<Response>,
  confirmBox: (t: string) => boolean = () => true,
): DetailFixture & { handle: { destroy(): void } } {
  const view = stubViewEl();
  const doc = stubDoc();
  const { host, timers } = fakeTimerHost();
  const paths: Array<{ method: string; path: string }> = [];
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    paths.push({ method: init?.method ?? 'GET', path });
    if ((init?.method ?? 'GET') === 'POST') return post(path);
    if (path === `/api/tasks/${task.taskId as string}`) return jsonResponse(task);
    if (path === `/api/tasks/${task.taskId as string}/events`) return jsonResponse(detailEvents);
    if (path === `/api/tasks/${task.taskId as string}/evidence`) return jsonResponse([]);
    if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [], total: 0 });
    return jsonResponse({}, 404);
  };
  const handle = mountTaskDetailPage(
    {
      doc: doc as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: host,
      confirmBox,
      now: () => NOW,
    },
    task.taskId as string,
  );
  return { handle, view, doc, timers, paths, confirmBox };
}

function clickNoHit(): Record<string, unknown> {
  return { preventDefault: () => {}, target: { closest: () => null } };
}

function getPaths(fx: DetailFixture, method: 'GET' | 'POST'): string[] {
  return fx.paths.filter((p) => p.method === method).map((p) => p.path);
}

describe('wp268 taskDetailPage：写流与交互边界', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-268' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('终态任务上的写操作收尾 refresh 短路（不追加四读面请求）', async () => {
    const fx = mountDetail(baseTask({ status: 'cancelled', endedAt: '2026-11-01T10:05:00.000Z' }), async () => jsonResponse({ taskId: 'task-wp268aaaa', spawned: true, logFile: 'x.log' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-cancelled'));
    expect(getPaths(fx, 'GET')).toHaveLength(4); // 首拉后终态即停
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'resume' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('续跑请求已受理'));
    await new Promise((r) => setTimeout(r, 0)); // 等收尾 refresh 微任务完结
    expect(getPaths(fx, 'POST')).toEqual(['/api/tasks/task-wp268aaaa/resume']);
    expect(getPaths(fx, 'GET')).toHaveLength(4); // 终态短路：零追加
    fx.handle.destroy();
  });

  it('无 resume 反馈时点 view-resume-log → 短路（不发日志请求）', async () => {
    const fx = mountDetail(baseTask(), async () => jsonResponse({ taskId: 'task-wp268aaaa' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'view-resume-log' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(getPaths(fx, 'GET').some((p) => p.endsWith('/resume-log'))).toBe(false); // 未发起日志读取
    fx.handle.destroy();
  });

  it('写门：在途期间二次点击取消 → 忽略（仅发一次 POST）', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    const fx = mountDetail(baseTask(), () => gate);
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'cancel' }));
    await new Promise((r) => setTimeout(r, 0));
    (click as (ev: unknown) => void)(clickEvent({ action: 'cancel' })); // 在途二次提交
    await new Promise((r) => setTimeout(r, 0));
    expect(getPaths(fx, 'POST')).toHaveLength(1); // 乐观禁用门生效
    release(jsonResponse({ taskId: 'task-wp268aaaa', mode: 'graceful' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('取消成功'));
    fx.handle.destroy();
  });

  it('取消确认被拒 → cancelled-by-user 收尾（不发 POST、无反馈条）', async () => {
    const fx = mountDetail(baseTask(), async () => jsonResponse({ taskId: 'task-wp268aaaa' }), () => false);
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    const before = fx.view.innerHTML;
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'cancel' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(getPaths(fx, 'POST')).toEqual([]); // 确认门拦截
    expect(fx.view.innerHTML).toBe(before); // 无反馈条
    fx.handle.destroy();
  });

  it('写操作网络层失败（POST 抛异常）→ network 口径反馈条', async () => {
    const fx = mountDetail(baseTask(), async () => { throw new Error('net-down'); });
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'cancel' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain(NETWORK_ERROR_TEXT));
    fx.handle.destroy();
  });

  it('写操作 HTTP 500（结构化 not_found 码）→ 已知码文案反馈条', async () => {
    const fx = mountDetail(baseTask(), async () => jsonResponse({ code: 'not_found', message: 'nope' }, 500));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'cancel' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('对象不存在（可能已终局），刷新查看'));
    fx.handle.destroy();
  });

  it('点击未命中 [data-action] → 无操作（不重渲不发请求）', async () => {
    const fx = mountDetail(baseTask(), async () => jsonResponse({ taskId: 'task-wp268aaaa' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    const before = fx.view.innerHTML;
    const getsBefore = getPaths(fx, 'GET').length;
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickNoHit());
    expect(fx.view.innerHTML).toBe(before);
    expect(getPaths(fx, 'GET')).toHaveLength(getsBefore);
    fx.handle.destroy();
  });

  it('copy-id → 写入剪贴板（复制失败不阻塞语义由可选链兜底）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const fx = mountDetail(baseTask(), async () => jsonResponse({ taskId: 'task-wp268aaaa' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    const click = fx.view.listeners.get('click')![0];
    (click as (ev: unknown) => void)(clickEvent({ action: 'copy-id', id: 'task-wp268aaaa' }));
    expect(writeText).toHaveBeenCalledWith('task-wp268aaaa');
    fx.handle.destroy();
  });

  it('change 无 event-type → 忽略；checked 双向：勾选过滤、取消勾选恢复', async () => {
    const fx = mountDetail(baseTask(), async () => jsonResponse({ taskId: 'task-wp268aaaa' }));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('badge--status-paused'));
    expect(fx.view.innerHTML).toContain('<td class="mono">e-1</td>'); // task_created 行在列
    const change = fx.view.listeners.get('change')![0];
    (change as (ev: unknown) => void)({ target: {} }); // 无 dataset → 忽略
    expect(fx.view.innerHTML).toContain('<td class="mono">e-1</td>');
    (change as (ev: unknown) => void)({ target: { dataset: { 'event-type': 'task_created' }, checked: false } }); // 过滤
    await vi.waitFor(() => expect(fx.view.innerHTML).not.toContain('<td class="mono">e-1</td>'));
    (change as (ev: unknown) => void)({ target: { dataset: { 'event-type': 'task_created' }, checked: true } }); // 恢复
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('<td class="mono">e-1</td>'));
    fx.handle.destroy();
  });
});

// ---------- ⑥ observeCapabilitiesPage ----------

describe('wp268 observeCapabilitiesPage：矩阵面 401 与交互未命中', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-268' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('筛选态下矩阵读面 401 → 认证失效整屏态并停轮询', async () => {
    const view = stubViewEl();
    const doc = stubDoc();
    const { host, timers } = fakeTimerHost();
    const fetchImpl = async (path: string): Promise<Response> => {
      if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [], total: 0 });
      if (path === '/api/capabilities') return jsonResponse([]);
      if (path === '/api/capabilities?agent=wp268-ag') return jsonResponse({}, 401); // 矩阵面认证失效
      return jsonResponse({}, 404);
    };
    const handle = mountObserveCapabilitiesPage(
      { doc: doc as unknown as Document, view: view as unknown as HTMLElement, fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: host, confirmBox: () => true, now: () => NOW },
      { agent: 'wp268-ag' },
    );
    await vi.waitFor(() => expect(view.innerHTML).toContain(AUTH_EXPIRED_TEXT));
    expect(timers).toHaveLength(0); // 停轮询（无在途周期）
    handle.destroy();
  });

  it('点击与筛选 change 未命中 → 无操作（不导航不重渲）', async () => {
    const locationStub = { hash: '#/observe/capabilities' };
    vi.stubGlobal('location', locationStub);
    const view = stubViewEl();
    const doc = stubDoc();
    const { host } = fakeTimerHost();
    let fetchCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetchCount += 1;
      return jsonResponse({ tasks: [], total: 0 });
    };
    const handle = mountObserveCapabilitiesPage(
      { doc: doc as unknown as Document, view: view as unknown as HTMLElement, fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: host, confirmBox: () => true, now: () => NOW },
      {},
    );
    await vi.waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
    const before = view.innerHTML;
    (view.listeners.get('click')![0] as (ev: unknown) => void)(clickNoHit());
    (view.listeners.get('change')![0] as (ev: unknown) => void)({ target: { closest: () => null } });
    expect(view.innerHTML).toBe(before); // 无重渲
    expect(locationStub.hash).toBe('#/observe/capabilities'); // 无导航
    handle.destroy();
  });
});

// ---------- ⑦ agentsPage（目录与详情） ----------

describe('wp268 agentsPage：认证失效短路与交互边界', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-268' })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mountCatalog(statusOf: (path: string) => number | 'ok'): { handle: { destroy(): void }; view: StubEl; paths: string[] } {
    const view = stubViewEl();
    const doc = stubDoc();
    const { host } = fakeTimerHost();
    const paths: string[] = [];
    const fetchImpl = async (path: string): Promise<Response> => {
      paths.push(path);
      const s = statusOf(path);
      return s === 'ok' ? jsonResponse({ tasks: [], total: 0 }) : jsonResponse({ message: 'denied' }, s as number);
    };
    const handle = mountAgentsPage(
      { doc: doc as unknown as Document, view: view as unknown as HTMLElement, fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: host, confirmBox: () => true, now: () => NOW },
    );
    return { handle, view, paths };
  }

  function mountDetail4(statusOf: (path: string) => number | 'ok', bodyOf: (path: string) => Record<string, unknown> = () => ({})): { handle: { destroy(): void }; view: StubEl; paths: string[] } {
    const view = stubViewEl();
    const doc = stubDoc();
    const { host } = fakeTimerHost();
    const paths: string[] = [];
    const fetchImpl = async (path: string): Promise<Response> => {
      paths.push(path);
      const s = statusOf(path);
      return s === 'ok' ? jsonResponse(bodyOf(path)) : jsonResponse(bodyOf(path), s as number);
    };
    const handle = mountAgentDetailPage(
      { doc: doc as unknown as Document, view: view as unknown as HTMLElement, fetchImpl: fetchImpl as unknown as typeof fetch, timerHost: host, confirmBox: () => true, now: () => NOW },
      'wp268-agent',
      {},
    );
    return { handle, view, paths };
  }

  it('目录：读面 401 → 认证失效；后续 retry 点击短路（零追加请求）', async () => {
    const fx = mountCatalog((p) => (p === '/api/tasks?limit=100' ? 401 : 'ok'));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain(AUTH_EXPIRED_TEXT));
    expect(fx.paths).toHaveLength(2);
    (fx.view.listeners.get('click')![0] as (ev: unknown) => void)(clickEvent({ action: 'retry' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.paths).toHaveLength(2); // 认证失效守卫生效
    expect(fx.view.innerHTML).toContain(AUTH_EXPIRED_TEXT);
    fx.handle.destroy();
  });

  it('目录：点击未命中 [data-action] → 无操作', async () => {
    const fx = mountCatalog(() => 'ok');
    await vi.waitFor(() => expect(fx.paths).toHaveLength(2));
    const before = fx.view.innerHTML;
    (fx.view.listeners.get('click')![0] as (ev: unknown) => void)(clickNoHit());
    expect(fx.view.innerHTML).toBe(before);
    expect(fx.paths).toHaveLength(2);
    fx.handle.destroy();
  });

  it('详情：读面 401 → 认证失效；后续 retry 点击短路（零追加请求）', async () => {
    const fx = mountDetail4((p) => (p.endsWith('/card') ? 401 : 'ok'));
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain(AUTH_EXPIRED_TEXT));
    expect(fx.paths).toHaveLength(4);
    (fx.view.listeners.get('click')![0] as (ev: unknown) => void)(clickEvent({ action: 'retry' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fx.paths).toHaveLength(4); // 认证失效守卫
    fx.handle.destroy();
  });

  it('详情：insight 读面 500（未知码 + message）→ 分区错误条如实展示', async () => {
    const fx = mountDetail4(
      (p) => (p.endsWith('/insight') ? 500 : 'ok'),
      (p) => (p.endsWith('/insight') ? { code: 'unknown', message: 'insight-broken' } : {}),
    );
    await vi.waitFor(() => expect(fx.view.innerHTML).toContain('insight-broken')); // 未知码：code + 服务端 message
    expect(fx.view.innerHTML).not.toContain(AUTH_EXPIRED_TEXT); // 非 401 不整屏
    fx.handle.destroy();
  });

  it('详情：点击未命中 [data-action] → 无操作', async () => {
    const fx = mountDetail4(() => 'ok');
    await vi.waitFor(() => expect(fx.paths).toHaveLength(4));
    const before = fx.view.innerHTML;
    (fx.view.listeners.get('click')![0] as (ev: unknown) => void)(clickNoHit());
    expect(fx.view.innerHTML).toBe(before);
    fx.handle.destroy();
  });
});
