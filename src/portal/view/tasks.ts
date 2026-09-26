// 第六阶段批次一（§4.4 / 假设 5 修订）：任务视图纯函数——渲染数据变换 + 状态机文案。

export interface TaskViewRow {
  taskId: string;
  agentId: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  attemptCount: number;
  modelCallCount: number;
  tokensUsed: number;
}

export interface TaskSummary {
  taskId: string;
  agentId: string;
  statusLabel: string;
  isRunning: boolean;
  createdAt: string;
  endedAt: string | null;
  attemptCount: number;
  modelCallCount: number;
  tokensUsed: number;
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  paused: '已挂起',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
};

export function taskSummary(row: TaskViewRow): TaskSummary {
  return {
    taskId: row.taskId,
    agentId: row.agentId,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    isRunning: row.status === 'running',
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    attemptCount: row.attemptCount,
    modelCallCount: row.modelCallCount,
    tokensUsed: row.tokensUsed,
  };
}

/** D-42：任务列表对 Running 行常驻警示入口（boot 跳过 recover ≠ 永久搁置；确认后走显式崩溃恢复，批次 6-3） */
export function runningWarning(rows: TaskViewRow[]): string | null {
  const running = rows.filter((r) => r.status === 'running');
  if (running.length === 0) return null;
  return `检测到 ${running.length} 个运行中任务（可能正由其他进程执行）。若确认其进程已不存在，可执行显式崩溃恢复（将把所有 Running 任务标记为 Failed(CrashRecovery)）。`;
}
