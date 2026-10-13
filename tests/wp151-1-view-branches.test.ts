import { describe, expect, it } from 'vitest';
import { evolutionSummary } from '../src/portal/view/evolution.js';
import { approvalSummary, formatDuration } from '../src/portal/view/approvals.js';

// 每日优化第十二批（TASK-151）：门户视图层分支覆盖加固——view/evolution.ts（分支 33.33%）
// 与 view/approvals.ts（分支 62.5%）未覆盖分支段补测（基线 wp148-review/coverage-full.txt：
// evolution 25-26 = evidenceRefs 存量异常形态防御 catch；approvals 31/40-42 = 分钟粒度分界
// + 决议标签回退 + blocked 双侧 + 非待审批超时文案「—」）。断言行为语义，纯函数直测。

type EvoRow = Parameters<typeof evolutionSummary>[0];

function evoRow(partial: Partial<EvoRow>): EvoRow {
  return {
    candidateId: 'c-1',
    agentId: 'ag-1',
    trigger: 'repeated_failure',
    evidenceRefs: '[]',
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
    proposedChange: null,
    decidedAt: null,
    decidedBy: null,
    derivedVersionIds: '[]',
    dismissedAt: null,
    ...partial,
  };
}

describe('wp151 evolutionSummary 分支：存量异常形态与未知状态（view/evolution.ts:22-31）', () => {
  it('evidenceRefs 非 JSON（存量异常形态）→ evidenceCount 视为空 0，页面不崩', () => {
    const s = evolutionSummary(evoRow({ evidenceRefs: 'not-json{{' }));
    expect(s.evidenceCount).toBe(0);
  });

  it('未知 status（枚举外）→ statusLabel 原样回退，不显示空文案', () => {
    const s = evolutionSummary(evoRow({ status: 'mystery-status' }));
    expect(s.statusLabel).toBe('mystery-status');
  });
});

type ApprovalRow = Parameters<typeof approvalSummary>[0];

function approvalRow(partial: Partial<ApprovalRow>): ApprovalRow {
  return {
    requestId: 'req-1',
    taskId: 't-1',
    toolId: 'l3-op',
    decision: 'pending',
    taskStatus: 'paused',
    timeoutRemainingMs: 90_000,
    ...partial,
  };
}

describe('wp151 formatDuration 分钟粒度分界（view/approvals.ts:29-33）', () => {
  it('0 < ms < 60s → 「<1 分钟」', () => {
    expect(formatDuration(1)).toBe('<1 分钟');
    expect(formatDuration(59_999)).toBe('<1 分钟');
  });

  it('ms <= 0（负数余量）→ 「已超时」', () => {
    expect(formatDuration(-1)).toBe('已超时');
  });

  it('整分钟边界：60_000 → 「1 分钟内」（Math.ceil 口径）', () => {
    expect(formatDuration(60_000)).toBe('1 分钟内');
  });
});

describe('wp151 approvalSummary 分支：标签回退 / blocked 双侧 / 非待审批超时文案（view/approvals.ts:40-42）', () => {
  it('superseded（已作废）→ blocked=false、超时文案「—」（终局决议不再计时）', () => {
    const s = approvalSummary(approvalRow({ decision: 'superseded', timeoutRemainingMs: 90_000 }));
    expect(s.decisionLabel).toBe('已作废');
    expect(s.blocked).toBe(false);
    expect(s.timeoutLabel).toBe('—');
  });

  it('denied（已拒绝）→ 同为终局：blocked=false、超时「—」', () => {
    const s = approvalSummary(approvalRow({ decision: 'denied' }));
    expect(s.decisionLabel).toBe('已拒绝');
    expect(s.blocked).toBe(false);
    expect(s.timeoutLabel).toBe('—');
  });

  it('approved（已批准）但任务仍 paused → blocked=false（决议已出，非审批阻塞）', () => {
    const s = approvalSummary(approvalRow({ decision: 'approved', taskStatus: 'paused' }));
    expect(s.decisionLabel).toBe('已批准');
    expect(s.blocked).toBe(false);
    expect(s.timeoutLabel).toBe('—');
  });

  it('pending 但任务非 paused（如 running/timeout 终局面）→ blocked=false、超时仍计时', () => {
    const s = approvalSummary(approvalRow({ decision: 'pending', taskStatus: 'running', timeoutRemainingMs: 30_000 }));
    expect(s.decisionLabel).toBe('待审批');
    expect(s.blocked).toBe(false);
    expect(s.timeoutLabel).toBe('<1 分钟');
  });

  it('未知 decision（枚举外，如超时落地后的扩展态）→ decisionLabel 原样回退', () => {
    const s = approvalSummary(approvalRow({ decision: 'timeout-applied', taskStatus: 'cancelled' }));
    expect(s.decisionLabel).toBe('timeout-applied');
    expect(s.blocked).toBe(false);
    expect(s.timeoutLabel).toBe('—');
  });
});
