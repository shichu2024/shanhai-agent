import type { TraceRecorder } from './traceRecorder.js';
import type { RiskLevel } from '../types.js';
import { sha256Hex } from '../hash.js';

// A2 §3–§5/§8：风险闸门（声明检查 → 等级检查 → L2 受控字段）、policy_denied 结构化反馈、
// 连续拦截计数（成功调用清零；达 maxConsecutiveDenials → Failed:Policy(PolicyBlocked)，归因不漂移）。

export interface PolicyDeniedResult {
  result: 'policy_denied';
  toolId: string;
  reasonCode: 'risk_level_blocked' | 'not_declared_in_spec' | 'param_out_of_range' | 'target_not_whitelisted';
  message: string;
}

export interface SpecToolDeclaration {
  toolId: string;
  riskLevel: RiskLevel;
  controlledFields?: { paramRanges?: Record<string, { min?: number; max?: number }>; targetWhitelist?: string[] };
}

/** 连续拦截达上限的终局（A2 §5 / C3-③ 锚点） */
export class PolicyBlockedError extends Error {
  constructor(
    message: string,
    readonly consecutiveDenialCount: number,
    readonly traceRef: string | null,
  ) {
    super(message);
    this.name = 'PolicyBlockedError';
  }
}

export type ToolImpl = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface ToolExecutorOptions {
  base: { taskId: string; agentId: string; agentVersionId: string; specContentHash: string };
  trace: TraceRecorder;
  /** 查询 Tool Registry 当前登记（防御纵深：按当前等级闸门，A2 §4-2） */
  getTool(toolId: string): { riskLevel: string; status: string; implVersion: string } | null;
  impls: Map<string, ToolImpl>;
  declared: SpecToolDeclaration[];
  maxConsecutiveDenials: number;
  maxAttempts: number;
  toolTimeoutMs: number;
  /** 连续拦截计数的读取与写回（持久化于 TaskRecord.consecutiveDenialCount） */
  getDenialCount(): number;
  setDenialCount(n: number): void;
  /** v1.1（A2 §8）：Spec 声明 approvalPolicy.mode=onHighRisk 时 L3 走审批分支（挂起），其余 L3 仍拦截 */
  approvalMode?: 'onHighRisk' | 'never' | null;
}

/** L3 调用等待审批（A2 §8 v1.1 审批分支）——由执行循环接管：写 PauseSnapshot + ApprovalRequest → Paused */
export class ApprovalRequiredSignal extends Error {
  /** 挂起调用在批次内的下标（执行循环回填，快照 pendingIndex 锚点） */
  callIndex?: number;

  constructor(
    readonly toolId: string,
    readonly reasonCode: 'risk_level_blocked',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalRequiredSignal';
  }
}

export class ToolExecutor {
  constructor(private readonly opts: ToolExecutorOptions) {}

  /**
   * @param approvedCallRef 已获审批放行的调用键（A2 §8 v1.1：每次 L3 调用独立审批——resume 后该次调用放行）
   */
  async execute(
    callNo: number,
    toolId: string,
    args: Record<string, unknown>,
    approvedCallRef?: string,
  ): Promise<{ outcome: 'ok'; value: unknown } | { outcome: 'denied'; denied: PolicyDeniedResult }> {
    const { base, trace } = this.opts;
    trace.recordCallEvent(base, 'tool_call_requested', 'tool', callNo, 1, {
      toolId, argsDigest: digestArgs(args),
    });

    const gate = this.gate(toolId, args, callNo, approvedCallRef);
    if (gate === 'needs_approval') {
      // 抛给执行循环接管（写 snapshot + request → Paused → run 进程退出，D-18 挂起即退出模型）
      throw new ApprovalRequiredSignal(toolId, 'risk_level_blocked', `L3 工具 ${toolId} 请求等待人工审批（approvalPolicy.mode=onHighRisk）`);
    }
    if (gate !== null) {
      const count = this.opts.getDenialCount() + 1;
      this.opts.setDenialCount(count);
      const evt = trace.recordCallEvent(base, 'policy_denied', 'tool', callNo, 1, {
        toolId, reasonCode: gate.reasonCode, consecutiveDenialCount: count, message: gate.message,
      });
      if (count >= this.opts.maxConsecutiveDenials) {
        throw new PolicyBlockedError(
          `连续被拒 ${count} 次达 maxConsecutiveDenials=${this.opts.maxConsecutiveDenials}（${toolId}/${gate.reasonCode}）`,
          count, evt.eventId,
        );
      }
      return { outcome: 'denied', denied: gate };
    }

    const impl = this.opts.impls.get(toolId);
    if (!impl) {
      // 声明且登记但运行时未挂实现：内部缺陷信号
      throw new PolicyBlockedError(`工具 ${toolId} 无实现挂载（Runtime internal）`, this.opts.getDenialCount(), null);
    }

    for (let attemptNo = 1; attemptNo <= this.opts.maxAttempts; attemptNo++) {
      trace.recordCallEvent(base, 'attempt_started', 'tool', callNo, attemptNo, { kind: 'tool' });
      const startedAt = Date.now();
      try {
        const value = await withTimeout(impl(args), this.opts.toolTimeoutMs);
        const latencyMs = Date.now() - startedAt;
        const registry = this.opts.getTool(toolId);
        const evt = trace.recordCallEvent(base, 'tool_call_executed', 'tool', callNo, attemptNo, {
          toolId, latencyMs, resultDigest: digestArgs(value), riskLevel: registry?.riskLevel ?? 'L0',
          audited: registry?.riskLevel === 'L1' || registry?.riskLevel === 'L2',
        });
        this.opts.setDenialCount(0); // 任一次成功工具调用清零（A2 §5）
        return { outcome: 'ok', value };
      } catch (err) {
        const subClass = (err as Error).name === 'ToolTimeoutError' ? 'timeout' : (isInvalidParams(err) ? 'invalid_params' : 'execution_failed');
        const willRetry = attemptNo < this.opts.maxAttempts;
        trace.recordCallEvent(base, 'attempt_failed', 'tool', callNo, attemptNo, {
          failureClass: 'Tool', subClass, message: (err as Error).message, willRetry,
        });
        if (!willRetry) {
          throw new ToolTerminalFailure(subClass, (err as Error).message);
        }
      }
    }
    throw new ToolTerminalFailure('internal_error', 'ToolExecutor 不可达路径');
  }

  /** 闸门顺序（A2 §8）：声明检查 → 当前登记等级 L3/L4（v1.1 审批分支）→ L2 受控字段 */
  private gate(toolId: string, args: Record<string, unknown>, callNo: number, approvedCallRef?: string): PolicyDeniedResult | null | 'needs_approval' {
    const declared = this.opts.declared.find((t) => t.toolId === toolId);
    if (!declared) {
      return deny(toolId, 'not_declared_in_spec', '工具存在但未在该 Spec 声明（默认拒绝）');
    }
    const registry = this.opts.getTool(toolId);
    const currentLevel = registry?.riskLevel;
    if (!registry || registry.status !== 'active') {
      return deny(toolId, 'not_declared_in_spec', `工具 ${toolId} 已 ${registry?.status ?? '注销'}，不可调用`);
    }
    if (currentLevel === 'L4') {
      return deny(toolId, 'risk_level_blocked', `当前登记等级 L4（禁区，注册即拒为主路径，运行期闸门为兜底）`);
    }
    if (currentLevel === 'L3') {
      // A2 §4-2 v1.1（D-8 + 终审 R-3）：调用点按当前登记等级判定——
      // Spec 声明 L3 + approvalPolicy=onHighRisk → 审批分支（每次调用独立审批）；
      // 其余（含 L2 声明被重登记上调 L3 的漂移窗口）→ risk_level_blocked 拦截（防御纵深维持）。
      if (declared.riskLevel === 'L3' && this.opts.approvalMode === 'onHighRisk') {
        if (approvedCallRef !== undefined && approvedCallRef === String(callNo)) {
          return null; // 该次调用已获 approve 放行（callRef 匹配，A3 §5）
        }
        return 'needs_approval';
      }
      return deny(toolId, 'risk_level_blocked', `当前登记等级 L3（注册即拒为主路径，运行期闸门为兜底；R-3 调用点按当前登记等级拦截）`);
    }
    if (declared.riskLevel === 'L2' && declared.controlledFields) {
      const ranges = declared.controlledFields.paramRanges;
      if (ranges) {
        for (const [param, range] of Object.entries(ranges)) {
          const v = args[param];
          if (typeof v === 'number') {
            if ((range.min !== undefined && v < range.min) || (range.max !== undefined && v > range.max)) {
              return deny(toolId, 'param_out_of_range', `参数 ${param}=${v} 越界（[${range.min ?? '-∞'}, ${range.max ?? '+∞'}]）`);
            }
          }
        }
      }
      const whitelist = declared.controlledFields.targetWhitelist;
      if (whitelist && 'target' in args) {
        const target = String(args.target);
        if (!whitelist.includes(target)) {
          return deny(toolId, 'target_not_whitelisted', `目标 ${target} 不在白名单（共 ${whitelist.length} 项）`);
        }
      }
    }
    return null;
  }
}

export class ToolTerminalFailure extends Error {
  constructor(
    readonly subClass: 'execution_failed' | 'timeout' | 'invalid_params' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'ToolTerminalFailure';
  }
}

function deny(toolId: string, reasonCode: PolicyDeniedResult['reasonCode'], message: string): PolicyDeniedResult {
  return { result: 'policy_denied', toolId, reasonCode, message };
}

function digestArgs(value: unknown): string {
  // SHA-256 摘要（A6 §8：digest 用于索引与去重；原文保留策略属第二阶段）
  return sha256Hex(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 16);
}

function isInvalidParams(err: unknown): boolean {
  return err instanceof Error && err.name === 'InvalidToolParams';
}

class ToolTimeoutMarker extends Error {
  constructor() {
    super('工具执行超时');
    this.name = 'ToolTimeoutError';
  }
}
function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, rej) => setTimeout(() => rej(new ToolTimeoutMarker()), ms)),
  ]) as Promise<T>;
}
