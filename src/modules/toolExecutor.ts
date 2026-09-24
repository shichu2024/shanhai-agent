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
  /** 第四阶段批次一（§4.2-3 调用桥）：impls Miss 时的 external 分派（kind=external → MCP tools/call）；
   * attempt/timeout/归因由本执行器既有循环承载（同构，A-14）。 */
  externalCall?: (toolId: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 第四阶段批次三（§4.4，D-30）：委托原语特殊类别接线——task-delegate 走独立分派路径
   *  （超时豁免 / attempt=1 禁重试 / anchorChildTaskId 幂等重入 / 挂起信号上浮）。 */
  delegation?: {
    primitive: DelegatePrimitive;
    task: DelegateTaskContext;
    /** resume 幂等重入锚点（PauseSnapshot.delegation.childTaskId——挂起前已创建子任务时存在） */
    anchorChildTaskId?: string;
  };
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

// ---------- §4.4 鲲鹏委托最小形态（批次三）：委托原语特殊类别 ----------

/** 委托原语工具 ID（builtin，登记缺省 L3） */
export const DELEGATE_TOOL_ID = 'task-delegate';

/** 委托等待信号（§4.4 信号上浮 / 幂等重入）：子任务未终态（Paused/pending）→ 父保持 Paused + 提示。
 *  在 ToolExecutor 委托原语路径原样上浮（不进 attempt 异常归类——R-1 分类表）。 */
export class DelegationWaitSignal extends Error {
  /** 挂起调用在批次内的下标（执行循环回填，快照 pendingIndex 锚点） */
  callIndex?: number;

  constructor(
    readonly childTaskId: string,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationWaitSignal';
  }
}

/** 委托原语 impl 的任务侧上下文（§4.4：治理预检与 impl 执行均以发起委托的任务为锚） */
export interface DelegateTaskContext {
  parentTaskId: string;
  delegationDepth: number;
  /** 父取消检查（P2-2 线程化：注入嵌套子循环原子调用边界代查 graceful/abort） */
  isParentCancelRequested(): boolean;
}

/** 委托原语（§4.4，D-30）：由组合根接线（runtime/delegation.ts）——治理预检 + 阻塞式嵌套 impl */
export interface DelegatePrimitive {
  /** 治理预检（§4.4 治理规则表）：环路（沿 parentTaskId 上溯）/深度超限 → 结构化拒绝（policy_denied 语义） */
  govern(args: Record<string, unknown>, task: DelegateTaskContext): PolicyDeniedResult | null;
  /** impl 执行：子任务创建（先持久化）→ 同进程嵌套循环；子挂起经 DelegationWaitSignal 上浮 */
  execute(args: Record<string, unknown>, task: DelegateTaskContext, call: { callNo: number; anchorChildTaskId?: string }): Promise<unknown>;
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

    // 委托原语特殊类别（§4.4，D-30）：治理预检（环路/深度）先于等级分支——
    // 越权委托请求不进入 L3 审批挂起（F-12-⑤ 调用点拦截，闸门顺序见 gate 注释）。
    const delegation = toolId === DELEGATE_TOOL_ID ? this.opts.delegation : undefined;
    if (delegation) {
      const governed = delegation.primitive.govern(args, delegation.task);
      if (governed !== null) {
        return this.handleDenial(governed, callNo);
      }
    }

    const gate = this.gate(toolId, args, callNo, approvedCallRef);
    if (gate === 'needs_approval') {
      // 抛给执行循环接管（写 snapshot + request → Paused → run 进程退出，D-18 挂起即退出模型）
      throw new ApprovalRequiredSignal(toolId, 'risk_level_blocked', `L3 工具 ${toolId} 请求等待人工审批（approvalPolicy.mode=onHighRisk）`);
    }
    if (gate !== null) {
      return this.handleDenial(gate, callNo);
    }

    // 委托原语特殊类别（§4.4 四属性，R-1 分类表见 runtime/delegation.ts）：
    //   超时豁免——不受 toolTimeoutMs 约束（impl = 整个嵌套子任务循环，30s 必超时，P1-1）；
    //   禁重试——attempt=1，失败即终局（impl 含创建子任务副作用，重试 = 重复子任务，P1-1）；
    //   信号上浮——DelegationWaitSignal（子未终态）/ApprovalRequiredSignal 原样上浮，
    //             不进 attempt 异常归类为 Tool(execution_failed)（P0-1）。
    if (delegation) {
      trace.recordCallEvent(base, 'attempt_started', 'tool', callNo, 1, { kind: 'tool', delegation: true });
      const delegateStartedAt = Date.now();
      try {
        const value = await delegation.primitive.execute(args, delegation.task, { callNo, anchorChildTaskId: delegation.anchorChildTaskId });
        const registry = this.opts.getTool(toolId);
        trace.recordCallEvent(base, 'tool_call_executed', 'tool', callNo, 1, {
          toolId, latencyMs: Date.now() - delegateStartedAt, resultDigest: digestArgs(value), riskLevel: registry?.riskLevel ?? 'L3',
          audited: false, delegation: true,
        });
        this.opts.setDenialCount(0);
        return { outcome: 'ok', value };
      } catch (err) {
        const sigName = (err as Error).name;
        if (
          err instanceof ApprovalRequiredSignal || err instanceof DelegationWaitSignal ||
          sigName === 'CancelRequestedSignal' || sigName === 'TaskAbortedSignal' || sigName === 'ExecutorSucceeded'
        ) {
          throw err; // 信号上浮特判（R-1）：取消/中止/挂起信号不归类 Tool(execution_failed)、不重试
        }
        const subClass = (err as Error).name === 'ToolTimeoutError' ? 'timeout' : (isInvalidParams(err) ? 'invalid_params' : 'execution_failed');
        trace.recordCallEvent(base, 'attempt_failed', 'tool', callNo, 1, {
          failureClass: 'Tool', subClass, message: (err as Error).message, willRetry: false, // 禁重试：attempt=1 即终局
        });
        throw new ToolTerminalFailure(subClass, (err as Error).message);
      }
    }

    const impl = this.resolveImpl(toolId);
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

  /** 拒绝处理（闸门与治理预检共用）：连续拦截计数 + policy_denied 留痕 + 达上限终局 */
  private handleDenial(gate: PolicyDeniedResult, callNo: number): { outcome: 'denied'; denied: PolicyDeniedResult } {
    const { base, trace } = this.opts;
    const count = this.opts.getDenialCount() + 1;
    this.opts.setDenialCount(count);
    const evt = trace.recordCallEvent(base, 'policy_denied', 'tool', callNo, 1, {
      toolId: gate.toolId, reasonCode: gate.reasonCode, consecutiveDenialCount: count, message: gate.message,
    });
    if (count >= this.opts.maxConsecutiveDenials) {
      throw new PolicyBlockedError(
        `连续被拒 ${count} 次达 maxConsecutiveDenials=${this.opts.maxConsecutiveDenials}（${gate.toolId}/${gate.reasonCode}）`,
        count, evt.eventId,
      );
    }
    return { outcome: 'denied', denied: gate };
  }

  /** 实现解析层（§4.2-3）：builtin impls 优先；Miss 且有 external 分派 → MCP 调用桥 */
  private resolveImpl(toolId: string): ToolImpl | undefined {
    const builtin = this.opts.impls.get(toolId);
    if (builtin) return builtin;
    if (this.opts.externalCall) {
      const external = this.opts.externalCall;
      return (args: Record<string, unknown>) => external(toolId, args); // 桥自身校验 kind=external（非 external 拒绝分派）
    }
    return undefined;
  }

  /** 闸门顺序（A2 §8 v1.2 批次三增补，P1-2）：声明检查 → 目标白名单（等级无关）→ 等级分支（L3 审批 / L4 拦截）→ L2 参数范围。
   *  目标白名单从 L2 分支提升为等级无关步骤：凡 declared.controlledFields.targetWhitelist 存在即检查——
   *  task-delegate 参数映射 agentId；既有 L2 工具维持字面 target 检查（行为零变更，回归断言随批）。paramRanges 维持 L2-only。 */
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
    // 目标白名单（等级无关，A2 §8 v1.2）：委托原语查 agentId，其余查字面 target
    const whitelist = declared.controlledFields?.targetWhitelist;
    if (whitelist) {
      const param = toolId === DELEGATE_TOOL_ID ? 'agentId' : 'target';
      if (param in args) {
        const target = String(args[param]);
        if (!whitelist.includes(target)) {
          return deny(toolId, 'target_not_whitelisted', `目标 ${target} 不在白名单（共 ${whitelist.length} 项）`);
        }
      }
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
