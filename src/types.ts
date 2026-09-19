// 封闭集定义 —— A3 §1 状态集 / A4 §1 失败分类 / A2 §5 reasonCode / A6 §3 事件目录
// 增补须走章程变更规则（A4 §5-1），实现层禁止现场即造。

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'paused' // 空壳预留（A3 §1）
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

// A5 v1.1（D-10）：Reviewed 可选质量门——draft→reviewed→released；无回退边，直发保留
export type VersionStatus = 'draft' | 'reviewed' | 'released' | 'deprecated';

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

// A4 §1 分类总表（class/subClass 两级，封闭集）
export type FailureClass =
  | 'Input'
  | 'Spec'
  | 'Model'
  | 'Tool'
  | 'Policy'
  | 'Runtime'
  | 'Output';

export type FailureSubClass =
  // Input
  | 'contract_mismatch'
  // Spec
  | 'defensive_revalidation_failed'
  // Model
  | 'provider_error'
  | 'provider_infra'
  | 'call_timeout'
  | 'unparseable_output'
  | 'schema_violation'
  | 'enum_violation'
  | 'format_violation'
  | 'truncation'
  | 'provider_rejected_schema'
  // Tool
  | 'execution_failed'
  | 'timeout'
  | 'invalid_params'
  // Policy
  | 'PolicyBlocked'
  | 'ApprovalTimeout' // v1.1（A4 增补）：onTimeout=fail 的审批超时终局；不计入契约失败率
  // Runtime
  | 'BudgetExceeded'
  | 'TaskTimeout'
  | 'CrashRecovery'
  | 'internal_error'
  // Output
  | 'ContractViolation';

// A4 §1「计入契约失败率」口径：仅此子类计数；provider_infra / provider_rejected_schema 显式排除
export const CONTRACT_RATE_SUBCLASSES: ReadonlySet<FailureSubClass> = new Set([
  'unparseable_output',
  'schema_violation',
  'enum_violation',
  'format_violation',
  'truncation',
  'ContractViolation',
]);

export const EXCLUDED_FROM_CONTRACT_RATE: ReadonlySet<FailureSubClass> = new Set([
  'provider_infra',
  'provider_rejected_schema',
]);

// A2 §5 reasonCode 封闭集（budget_exhausted 已按 P2-1 删除——预算终局唯一归因 Runtime(BudgetExceeded)）
export type PolicyReasonCode =
  | 'risk_level_blocked'
  | 'not_declared_in_spec'
  | 'param_out_of_range'
  | 'target_not_whitelisted';

// A6 §3 事件目录（封闭集；v1.1 增 4 审批事件）
export type TraceEventType =
  | 'task_created'
  | 'task_queued'
  | 'task_started'
  | 'attempt_started'
  | 'model_call_completed'
  | 'tool_call_requested'
  | 'tool_call_executed'
  | 'policy_denied'
  | 'attempt_failed'
  | 'task_succeeded'
  | 'task_failed'
  | 'task_cancelled'
  | 'crash_recovery_marked'
  | 'contract_checked'
  | 'approval_requested' // v1.1：L3 挂起（requestId/toolId/riskLevel/timeoutAt/callRef）
  | 'approval_decided' // v1.1：approve/deny/惰性超时/superseded
  | 'task_paused' // v1.1：Running→Paused（run 进程退出前）
  | 'task_resumed' // v1.1：--resume 进程内 Paused→Running（resumedBy 双值均真实可达）
  | 'memory_written' // v1.1（D-13）：任务成功输出写入记忆（memoryId/taskId/kind/contentDigest）
  | 'memory_loaded' // v1.1：注入上下文（injection=context 时；默认 off 不触发；degraded 回看清单载体）
  | 'memory_state_changed'; // v1.1：可信度状态迁移（含基线快照同事务，D-13）

// A3 §2 v1.1：cancelReason 封闭枚举（互斥，落 TaskRecord 与 task_cancelled 事件）
export type CancelReason = 'user' | 'approval_denied' | 'approval_timeout' | 'abort' | 'superseded';

export type CallKind = 'model' | 'tool';

// 审计流 RejectedRequest kind（A6 §4）
export type RejectedKind = 'spec_registration' | 'task_creation' | 'cli_operation';

// A5 §5 审计流版本事件（v1.1 增 version_reviewed / canary_configured / version_promoted）
export type AuditEventType =
  | 'version_registered'
  | 'version_released'
  | 'version_reviewed' // v1.1：Draft→Reviewed 检视门（载荷含检视清单，A5 §1）
  | 'version_deprecated'
  | 'version_rollback'
  | 'canary_configured' // v1.1（A5 §3a，D-12）：canary set/clear 审计
  | 'version_promoted' // v1.1（A5 §4a，D-12）：canary→current 晋升（决定权留人）
  | 'tool_registered'
  | 'tool_reregistered'
  | 'rejected_request';

export interface FailureRecord {
  recordId: string;
  taskId: string;
  agentId: string;
  agentVersionId: string;
  attemptNo: number; // 0 = 任务级
  failureClass: FailureClass;
  subClass: FailureSubClass;
  reasonCode: string | null;
  message: string;
  expectedVsActual: string; // JSON {expected, actual, path?}
  countedInContractRate: 0 | 1;
  occurredAt: string;
  traceRef: string | null;
}
