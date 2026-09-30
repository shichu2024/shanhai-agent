// 第七阶段批次一（7-1/4）：断连判定（FR-G-3 / §11-3 口径，纯函数可测）。
// 三态：已连接（绿）/ 重连中（黄）/ 已断开（红）。
// 计入断连的失败 = 网络层错误或 5xx；401/403 不计入（分别走 Token 失效与 Host 拒绝专属处理）；
// 连续 2 次失败 → 重连中；持续 30s 未恢复 → 已断开；任一成功 → 恢复已连接。

export type ConnectionPhase = 'connected' | 'reconnecting' | 'disconnected';

export const CONNECTION_LABELS: Record<ConnectionPhase, string> = {
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '已断开',
};

export interface ConnectionState {
  phase: ConnectionPhase;
  /** 连续失败计数（成功即清零） */
  failStreak: number;
  /** 首次失败时间戳（ms；用于 30s 断连判定） */
  firstFailureAt: number | null;
}

export type Outcome = 'ok' | 'fail' | 'ignored';

export function initialConnection(): ConnectionState {
  return { phase: 'connected', failStreak: 0, firstFailureAt: null };
}

/** 请求结果 → 断连口径结果（401/403 → ignored：不计入断连也不重置计数） */
export function outcomeFor(status: number | 'network-error'): Outcome {
  if (status === 'network-error') return 'fail';
  if (status >= 500) return 'fail';
  if (status === 401 || status === 403) return 'ignored';
  return 'ok';
}

export function nextConnection(prev: ConnectionState, outcome: Outcome, now: number): ConnectionState {
  if (outcome === 'ignored') return prev;
  if (outcome === 'ok') return initialConnection();
  const failStreak = prev.failStreak + 1;
  const firstFailureAt = prev.firstFailureAt ?? now;
  return { phase: failStreak >= 2 ? 'reconnecting' : prev.phase, failStreak, firstFailureAt };
}

/** 时间推进判定：重连中持续 ≥30s 未恢复 → 已断开（由外壳周期或每次更新时调用） */
export function evaluateConnection(state: ConnectionState, now: number): ConnectionState {
  if (state.phase === 'reconnecting' && state.firstFailureAt !== null && now - state.firstFailureAt >= 30_000) {
    return { ...state, phase: 'disconnected' };
  }
  return state;
}
