import { describe, expect, it } from 'vitest';
import { generateReport, wilsonCi, type ReportInput, type ReportJob } from '../src/experiment/report.js';
import type { TraceEnvelope } from '../src/modules/traceRecorder.js';

// TASK-40 F-2/F-3 回归：成本代理已发起口径（含失败 attempt）+ 排除分母单位统一（样本级）

function ev(eventType: TraceEnvelope['eventType'], extra: Record<string, unknown> = {}): TraceEnvelope {
  return {
    eventId: 'e' + Math.random().toString(36).slice(2), timestamp: '2026-09-19T00:00:00.000000Z',
    traceId: 't', taskId: 't', agentId: 'a', agentVersionId: 'v', specContentHash: 'h',
    eventType, callNo: 1, callKind: null, attemptNo: 1, ...extra,
  };
}

function fakeRt(tracesByTask: Record<string, TraceEnvelope[]>): ReportInput['rt'] {
  return { trace: { readEvents: (taskId: string) => tracesByTask[taskId] ?? [] } } as unknown as ReportInput['rt'];
}

function job(specId: string, strategy: 'A' | 'B', taskId: string): ReportJob {
  return { specId, strategy, task: { id: taskId }, taskId, error: null };
}

describe('假设 #4 报告聚合（F-2 成本口径 / F-3 分母单位）', () => {
  it('F-2：平均模型调用按已发起口径计数——失败 attempt 不漏计（A2 §7）', () => {
    // 任务 C：attempt 1 失败（契约子类）→ attempt 2 成功 → 已发起 2 次、完成 1 次
    const taskC = [
      ev('task_created'), ev('task_queued'), ev('task_started'),
      ev('attempt_started', { callKind: 'model' }),
      ev('model_call_completed', { callKind: 'model' }),
      ev('attempt_failed', { callKind: 'model', subClass: 'schema_violation', willRetry: true }),
      ev('attempt_started', { callKind: 'model' }),
      ev('model_call_completed', { callKind: 'model' }),
      ev('task_succeeded'),
    ];
    const report = generateReport({
      rt: fakeRt({ 'task-c': taskC }),
      specIds: ['s1'], specLabels: { s1: 'S1' }, strategies: ['A'], model: 'mock', gitHash: 'x',
      jobs: [job('s1', 'A', 'task-c')],
    });
    expect(report).toContain('| 2.00 |'); // 旧口径（仅 completed）会给出 1.00
    expect(report).toContain('| 1 | 1 | 0 |'); // total=1 分母=1 首过=0（含重试通过）
  });

  it('F-3：排除按样本级计数——单任务多条 infra attempt 只扣 1，不与任务级分母混单位', () => {
    // 任务 A：2 条 provider_infra attempt（旧口径会扣 2，分母 = 2-2 = 0 出错）；任务 B：一次通过
    const taskA = [
      ev('task_created'), ev('task_queued'), ev('task_started'),
      ev('attempt_started', { callKind: 'model' }),
      ev('attempt_failed', { callKind: 'model', subClass: 'provider_infra', willRetry: true }),
      ev('attempt_started', { callKind: 'model' }),
      ev('attempt_failed', { callKind: 'model', subClass: 'provider_infra', willRetry: false }),
    ];
    const taskB = [
      ev('task_created'), ev('task_queued'), ev('task_started'),
      ev('attempt_started', { callKind: 'model' }),
      ev('model_call_completed', { callKind: 'model' }),
      ev('task_succeeded'),
    ];
    const report = generateReport({
      rt: fakeRt({ 'task-a': taskA, 'task-b': taskB }),
      specIds: ['s1'], specLabels: { s1: 'S1' }, strategies: ['A'], model: 'mock', gitHash: 'x',
      jobs: [job('s1', 'A', 'task-a'), job('s1', 'A', 'task-b')],
    });
    // total=2，排除样本 1（非 attempt 计数 2）→ 分母=1，首过=1
    expect(report).toContain('| 2 | 1 | 1 | 100.0% |');
    expect(report).toContain('provider_infra = 1');
    expect(report).not.toContain('provider_infra = 2');
  });

  it('Wilson CI 边界：n=0 返回 [0,0]，正常值在界内', () => {
    expect(wilsonCi(0, 0)).toEqual([0, 0]);
    const [lo, hi] = wilsonCi(24, 30);
    expect(lo).toBeGreaterThan(0.6);
    expect(hi).toBeLessThan(1);
  });
});
