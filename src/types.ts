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

export type VersionStatus = 'draft' | 'released' | 'deprecated';

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

// A6 §3 事件目录（封闭集）
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
  | 'contract_checked';

export type CallKind = 'model' | 'tool';

// 审计流 RejectedRequest kind（A6 §4）
export type RejectedKind = 'spec_registration' | 'task_creation' | 'cli_operation';

// A5 §5 审计流版本事件
export type AuditEventType =
  | 'version_registered'
  | 'version_released'
  | 'version_deprecated'
  | 'version_rollback'
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
