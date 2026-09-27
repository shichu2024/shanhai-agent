// 第六阶段批次二（§4.4 / 假设 5 修订）：events 时间线视图纯函数——事件行展示变换。

import type { TraceEventType } from '../../types.js';

export interface EventViewRow {
  eventId: string;
  eventType: TraceEventType | string;
  timestamp: string;
  callKind: string | null;
  callNo: number;
}

export interface EventSummary {
  eventId: string;
  eventType: string;
  label: string;
  timestamp: string;
  /** 调用面标注（非调用事件为 null）：如「调用 3 · tool」 */
  callLabel: string | null;
}

/** 事件类型中文标签（未知事件回退原文——封闭集外不猜测） */
const EVENT_LABELS: Record<string, string> = {
  task_created: '任务创建',
  task_queued: '进入队列',
  task_started: '开始执行',
  attempt_started: '尝试开始',
  model_call_completed: '模型调用完成',
  tool_call_requested: '工具调用请求',
  tool_call_executed: '工具调用完成',
  policy_denied: '策略拒绝',
  attempt_failed: '尝试失败',
  task_succeeded: '执行成功',
  task_failed: '执行失败',
  task_cancelled: '任务取消',
  crash_recovery_marked: '崩溃恢复标记',
  contract_checked: '契约校验',
  approval_requested: '审批请求',
  approval_decided: '审批决议',
  task_paused: '任务挂起',
  task_resumed: '任务续跑',
  task_delegated: '委托子任务',
  task_delegation_completed: '委托完成',
  memory_written: '记忆写入',
  memory_loaded: '记忆注入',
  memory_state_changed: '记忆状态迁移',
};

export function eventSummary(row: EventViewRow): EventSummary {
  return {
    eventId: row.eventId,
    eventType: String(row.eventType),
    label: EVENT_LABELS[row.eventType] ?? String(row.eventType),
    timestamp: row.timestamp,
    callLabel: row.callKind !== null ? `调用 ${row.callNo} · ${row.callKind}` : null,
  };
}
