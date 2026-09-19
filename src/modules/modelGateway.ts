import type { TraceRecorder } from './traceRecorder.js';
import type { ProviderResponse, ChatRequest, ModelProvider } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import type { CallOutcome, ModelAttemptFailure } from './outcomes.js';

// A2 §2/§2.1/§7：预算前置检查、调用级 attempt 计数（调用键 = callNo × kind）、usage 记账（缺失本地估算标 estimated）。
// 边界（冻结）：调用前检查触发的预算终局记 Runtime(BudgetExceeded)；Provider 侧超额报错按 Model(provider_infra) 归因。

export interface BudgetLedger {
  readonly maxModelCalls: number;
  readonly maxTokens: number;
  modelCallsIssued: number;
  tokensUsed: number;
  estimatedTokens: number;
  attemptsSucceeded: number;
  attemptsFailedBySubClass: Record<string, number>;
  /** 记账一次已发起调用（含失败 attempt）。usage 缺失时以本地估算记账并累计 estimatedTokens。 */
  account(usage: { inputTokens: number; outputTokens: number } | null, estimateTokens: number): void;
  breakdown(): { budget: { maxModelCalls: number; maxTokens: number }; consumed: { modelCalls: number; tokens: number; estimatedTokens: number }; attemptBreakdown: { succeeded: number; failedBySubClass: Record<string, number> } };
}

/** 预算终局（A2 §7 / D-2：附调用构成明细） */
export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly detail: ReturnType<BudgetLedger['breakdown']>,
    readonly traceRef: string | null,
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** attempt 耗尽后的终局模型失败（A4 §3：末次 attempt 子类升级为终局） */
export class TerminalModelFailure extends Error implements ModelAttemptFailure {
  constructor(
    readonly subClass: ModelAttemptFailure['subClass'],
    message: string,
    readonly violations: { path: string; expected: string; actual: string }[],
    readonly traceRef: string | null,
  ) {
    super(message);
    this.name = 'TerminalModelFailure';
  }
}

export interface GatewayCallOptions {
  base: { taskId: string; agentId: string; agentVersionId: string; specContentHash: string };
  trace: TraceRecorder;
  callNo: number; // 该逻辑调用的序号（model kind 内独立编号）
  ledger: BudgetLedger;
  maxAttempts: number;
  strategy: 'native' | 'prompt' | null;
  request: Omit<ChatRequest, 'callTimeoutMs'>;
  callTimeoutMs: number;
  /** 输出可受性判定：不通过按 attempt 级 Model 子类记录并重试（A4 unparseable/schema/enum/format/truncation） */
  accept(response: ProviderResponse): { ok: true; value: ProviderResponse } | { ok: false; subClass: 'unparseable_output' | 'schema_violation' | 'enum_violation' | 'format_violation' | 'truncation'; message: string; violations: { path: string; expected: string; actual: string }[] };
}

export class ModelGateway {
  constructor(
    private readonly provider: ModelProvider,
    private readonly whitelist: ReadonlySet<string>,
  ) {
    // A5 §4-2 无配置即拒绝启动：provider/whitelist 由 Runtime 构造期注入并校验（ConfigError 在 config.ts fail-fast）
    if (!provider || whitelist.size === 0) {
      throw new Error('ModelGateway 拒绝启动：无有效 Provider 配置（A5 §4-2）');
    }
  }

  get modelWhitelist(): ReadonlySet<string> {
    return this.whitelist;
  }

  async call(opts: GatewayCallOptions): Promise<CallOutcome<ProviderResponse>> {
    const { base, trace, ledger, callNo } = opts;
    for (let attemptNo = 1; attemptNo <= opts.maxAttempts; attemptNo++) {
      // 预算前置检查（每次 attempt 前判定——已发起调用数含失败 attempt，D-2）
      if (ledger.modelCallsIssued + 1 > ledger.maxModelCalls) {
        throw new BudgetExceededError(
          `maxModelCalls 超限：下次调用将是第 ${ledger.modelCallsIssued + 1} 次 > ${ledger.maxModelCalls}`,
          ledger.breakdown(), null,
        );
      }
      const estimateTokens = estimateTokensOf(opts.request);
      if (ledger.tokensUsed + estimateTokens > ledger.maxTokens) {
        throw new BudgetExceededError(
          `maxTokens 超限：已记账 ${ledger.tokensUsed} + 本次预估 ${estimateTokens} > ${ledger.maxTokens}（保守口径）`,
          ledger.breakdown(), null,
        );
      }

      trace.recordCallEvent(base, 'attempt_started', 'model', callNo, attemptNo, { kind: 'model' });
      const startedAt = Date.now();
      let response: ProviderResponse;
      try {
        response = await this.provider.chat({ ...opts.request, callTimeoutMs: opts.callTimeoutMs });
      } catch (err) {
        const failure = classifyProviderError(err);
        const willRetry = attemptNo < opts.maxAttempts;
        const evt = trace.recordCallEvent(base, 'attempt_failed', 'model', callNo, attemptNo, {
          failureClass: 'Model', subClass: failure.subClass, reasonCode: failure.reasonCode, message: failure.message, willRetry,
        });
        ledger.attemptsFailedBySubClass[failure.subClass] = (ledger.attemptsFailedBySubClass[failure.subClass] ?? 0) + 1;
        ledger.account(null, estimateTokens); // 失败 attempt 仍计数（已发起口径）且估算记账
        if (!willRetry) {
          throw new TerminalModelFailure(failure.subClass, `模型调用失败（attempt ${attemptNo}/${opts.maxAttempts} 耗尽）：${failure.message}`, [], evt.eventId);
        }
        continue;
      }

      const latencyMs = Date.now() - startedAt;
      const usage = response.usage ?? { inputTokens: estimateTokens, outputTokens: 0 };
      const estimated = response.usage === null || response.usage === undefined;
      ledger.account(usage, estimateTokens);
      const completed = trace.recordCallEvent(base, 'model_call_completed', 'model', callNo, attemptNo, {
        modelId: opts.request.modelId,
        latencyMs,
        finishReason: response.finishReason,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimated },
        strategy: opts.strategy,
      });

      const verdict = opts.accept(response);
      if (verdict.ok) {
        ledger.attemptsSucceeded += 1;
        return { ok: true, value: verdict.value, eventId: completed.eventId };
      }
      const willRetry = attemptNo < opts.maxAttempts;
      const evt = trace.recordCallEvent(base, 'attempt_failed', 'model', callNo, attemptNo, {
        failureClass: 'Model', subClass: verdict.subClass, message: verdict.message, willRetry,
        violations: verdict.violations,
      });
      ledger.attemptsFailedBySubClass[verdict.subClass] = (ledger.attemptsFailedBySubClass[verdict.subClass] ?? 0) + 1;
      if (!willRetry) {
        throw new TerminalModelFailure(verdict.subClass, `输出契约不满足（attempt ${attemptNo}/${opts.maxAttempts} 耗尽）：${verdict.message}`, verdict.violations, evt.eventId);
      }
    }
    /* 不可达：循环内必 return 或 throw */
    throw new TerminalModelFailure('internal_error', 'ModelGateway 不可达路径', [], null);
  }
}

function classifyProviderError(err: unknown): { subClass: 'provider_error' | 'provider_infra' | 'call_timeout' | 'provider_rejected_schema'; reasonCode: string; message: string } {
  if (err instanceof ProviderError) {
    if (err.code === 'call_timeout') return { subClass: 'call_timeout', reasonCode: err.code, message: err.message };
    if (err.schemaRejected) return { subClass: 'provider_rejected_schema', reasonCode: err.code, message: err.message };
    if (err.retryable) return { subClass: 'provider_infra', reasonCode: err.code, message: err.message };
    return { subClass: 'provider_error', reasonCode: err.code, message: err.message };
  }
  return { subClass: 'provider_error', reasonCode: 'unknown', message: (err as Error).message };
}

function estimateTokensOf(req: Omit<ChatRequest, 'callTimeoutMs'>): number {
  const chars = JSON.stringify(req.messages ?? '').length + (req.system ?? '').length;
  return Math.ceil(chars / 4) + 256; // 输入估算 + 输出余量（保守口径）
}
