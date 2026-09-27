// 第六阶段批次三（§4.4 / §5.2 / §5.3）：写操作流纯函数——确认文案、模式选择、状态提示。
// 口径与 §4.3 CLI 旗标映射表同源：cancel graceful≡`task cancel`、force≡`--force`、resume≡`--resumed-by manual-resume`。

/** 取消模式选择（D-47）：running 仅 force（graceful 只在本进程可见——跨进程走持久化 abort）；其余非终态两态可选 */
export function cancelModeFor(taskStatus: string): { gracefulDisabled: boolean; defaultMode: 'graceful' | 'force'; hint: string } {
  if (taskStatus === 'running') {
    return {
      gracefulDisabled: true,
      defaultMode: 'force',
      hint: '该任务运行于独立进程，仅支持强制中止（下一个原子调用边界生效，模型调用不打断；graceful 仅执行进程内可见）',
    };
  }
  return { gracefulDisabled: false, defaultMode: 'graceful', hint: 'queued/paused 立即取消（既有 CAS 语义）；paused 取消将连带 pending 审批作废' };
}

/** 崩溃恢复确认对话框文案（§5.1 逃生路径：明示误杀面） */
export function confirmCrashRecoveryText(runningCount: number): string {
  return `将把所有 Running 任务（当前 ${runningCount} 个）标记为 Failed(CrashRecovery)，并执行孤儿快照清理、pending 审批作废与 trace 索引对账。请先确认这些任务的执行进程确实已不存在——正在执行的任务会被误杀且不可恢复。确认继续？`;
}

/** 审批决议区状态（§5.2：approve 只写 decision，续跑是独立两步） */
export function approveActionHint(decision: string, taskStatus: string): { decidable: boolean; hint: string } {
  if (decision === 'pending' && taskStatus === 'paused') {
    return { decidable: true, hint: 'approve 只写决议（任务保持挂起）；deny 为任务级终局（cancelled/approval_denied）' };
  }
  if (decision === 'approved' && taskStatus === 'paused') {
    return { decidable: false, hint: '已批准，待续跑——点击「续跑」以独立进程执行（resumedBy=manual-resume）' };
  }
  if (decision === 'pending') {
    return { decidable: false, hint: `任务状态 ${taskStatus} 非挂起——审批不可决议（可能已被惰性超时终局，刷新查看）` };
  }
  return { decidable: false, hint: '该请求已终局（只读）' };
}

/** resume spawn 结果提示（UI 如实标注 resumedBy + 日志位置，§4.3） */
export function resumeNote(result: { taskId: string; spawned: boolean; logFile: string }): string {
  if (!result.spawned) return '续跑子进程未启动';
  const name = result.logFile.split(/[\\/]/).pop() ?? result.logFile;
  return `已 spawn 续跑子进程（resumedBy=manual-resume；日志 ${name}）——状态以任务页为准，子进程 CAS 失败时日志留因`;
}
