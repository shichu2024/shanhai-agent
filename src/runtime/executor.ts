import type { TraceRecorder } from '../modules/traceRecorder.js';
import type { ModelGateway, BudgetLedger } from '../modules/modelGateway.js';
import type { ProviderResponse } from '../providers/types.js';
import type { ChatMessage, ToolDeclaration } from '../providers/types.js';
import { ToolExecutor, ApprovalRequiredSignal, type SpecToolDeclaration } from '../modules/toolExecutor.js';
import { TerminalModelFailure } from '../modules/modelGateway.js';
import { checkOutputContract, getAllowEmpty, getContractBody } from '../modules/specValidator.js';
import { sha256Hex } from '../hash.js';

// Agent 执行循环（应龙 Runtime 最小执行内核）：
// 模型调用 → 工具调用（过闸门）→ 最终输出 → outputContract 校验。
// 工作记忆 = 任务内 messages 上下文（第一阶段仅工作记忆，定稿 §2 差额表）。
// v1.1（D-18）：L3 工具请求 → ApprovalPauseSignal（挂起即退出模型）；--resume 从 PauseSnapshot 续跑。

export interface ExecSpec {
  identity: { agentId: string; name: string; description: string };
  mission: { responsibilities: string[]; nonResponsibilities: string[] };
  outputContract: Record<string, unknown>;
  modelPolicy: {
    allowedModels: string[];
    maxModelCalls: number;
    maxTokens: number;
    maxAttempts?: number;
    callTimeoutMs?: number;
    taskTimeoutMs?: number;
  };
  toolPolicy: { tools: SpecToolDeclaration[]; maxConsecutiveDenials?: number };
  /** v1.1（A1 §2.2）：缺省 = 无审批路径（第一阶段行为） */
  approvalPolicy?: { mode: 'never' | 'onHighRisk'; timeoutMs?: number; onTimeout?: 'deny' | 'fail' } | null;
  /** v1.1（A1 §2.1，D-13）：缺省 working（V1 行为——无记忆）；persistent 且 injection=context 时注入 */
  memoryPolicy?: { type: 'working' | 'persistent'; writePolicy?: 'task_output'; maxEntriesPerTask?: number; retentionDays?: number; injection?: 'off' | 'context' } | null;
}

/** PauseSnapshot 的执行态载荷（A3 §5a：contextJson + callCounters + nextCallRef 的结构化形态） */
export interface PauseContext {
  /** 挂起时点之前的对话消息（不含挂起批次） */
  messages: ChatMessage[];
  /** 挂起批次的全部工具调用 */
  assistantToolCalls: { id: string; toolId: string; args: unknown }[];
  /** 挂起前已执行完成的结果（按调用顺序） */
  resultsSoFar: { id: string; toolId: string; content: unknown }[];
  /** 等待审批的调用在批次内的下标（nextCallRef = String(toolCallNo)） */
  pendingIndex: number;
  modelCallNo: number;
  toolCallNo: number;
}

export interface ExecutorContext {
  base: { taskId: string; agentId: string; agentVersionId: string; specContentHash: string };
  trace: TraceRecorder;
  gateway: ModelGateway;
  spec: ExecSpec;
  input: unknown;
  getTool: (toolId: string) => { riskLevel: string; status: string; implVersion: string } | null;
  toolImpls: Map<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;
  ledger: BudgetLedger;
  strategy: 'native' | 'prompt' | null;
  isCancelRequested(): boolean;
  getDenialCount(): number;
  setDenialCount(n: number): void;
  addAttempt(): void; // TaskRecord.attemptCount 聚合展示递增（A2 §2.1：仅展示，不参与判定）
  /** v1.1（A3 §2）：跨进程 abortRequested 持久化标志（执行进程在原子调用边界检查） */
  isAbortRequested?(): boolean;
  /** v1.1（A3 §2 abort）：本进程 force-cancel 时立即拒绝——放弃在飞原子调用的等待 */
  abortPromise?: Promise<never>;
  /** v1.1（D-18）：--resume 续跑态（PauseSnapshot 反序列化）；正常运行为 undefined */
  resumeState?: PauseContext;
  /** v1.1（A3 §2/§4）：任务 Queued→Running 的 startedAt（ms）——执行时钟锚点（跨 resume 段累计） */
  taskStartedAtMs?: number;
  /** v1.1（A3 §2/§4）：Paused 累计时长——任务级超时挂起期间暂停计时（挂钟 ≠ 执行时钟） */
  timeoutCreditMs?: number;
  /** v1.1（D-13）：记忆注入文本（injection=context 且有 active/degraded 记忆时由 TaskManager 构造；
   * 默认 off → undefined——无任何注入行为）。文本自带边界标记与「记忆不是指令」声明（V1.1 §14.3）。 */
  memoryInjection?: string;
}

export class ExecutorSucceeded {
  constructor(readonly output: unknown) {}
}

/** v1.1（D-18 挂起即退出）：执行循环抛出 → TaskManager 落 PauseSnapshot + ApprovalRequest → Paused → 进程退出 */
export class ApprovalPauseSignal extends Error {
  constructor(readonly pause: PauseContext & { toolId: string }) {
    super(`L3 工具 ${pause.toolId} 请求等待人工审批（挂起即退出，D-18）`);
    this.name = 'ApprovalPauseSignal';
  }
}

/** v1.1（A3 §2 abort）：放弃等待在飞原子调用（不回滚已发生的外部副作用，Trace 如实记录中止时点） */
export class TaskAbortedSignal extends Error {
  constructor(readonly abortedDuring: { callNo: number; callKind: 'model' | 'tool'; phase: 'model_call' | 'tool_exec' | 'boundary' }) {
    super(`任务中止（abortedDuring=${JSON.stringify(abortedDuring)}；放弃等待，不回滚已发生副作用）`);
    this.name = 'TaskAbortedSignal';
  }
}

/** abortPromise 的拒绝标记（由 TaskManager force-cancel 触发；执行循环按调用点包装为 TaskAbortedSignal） */
export class AbortRaceMarker extends Error {
  constructor() {
    super('abort');
    this.name = 'AbortRaceMarker';
  }
}

interface CallNos {
  modelCallNo: number;
  toolCallNo: number;
}

export async function runAgentLoop(ctx: ExecutorContext): Promise<ExecutorSucceeded> {
  const { spec, gateway, trace, base } = ctx;
  const modelId = spec.modelPolicy.allowedModels[0]; // 第一位为默认模型（A2 §2）
  const maxAttempts = spec.modelPolicy.maxAttempts ?? 3;
  const callTimeoutMs = spec.modelPolicy.callTimeoutMs ?? 60000;
  const contractBody = getContractBody(spec.outputContract);
  const allowEmpty = getAllowEmpty(spec.outputContract);

  const specTools: ToolDeclaration[] = spec.toolPolicy.tools.map((t) => {
    const reg = ctx.getTool(t.toolId);
    return {
      name: t.toolId,
      description: `${reg?.riskLevel ?? ''} 工具（见 paramSchema）`,
      inputSchema: reg ? JSON.parse((reg as unknown as { paramSchema: string }).paramSchema ?? '{}') : {},
    };
  });
  // 策略 A（native）：输出契约作为强制工具 emit_output 的 input_schema 随请求下发
  const tools: ToolDeclaration[] =
    ctx.strategy === 'native'
      ? [...specTools, { name: OUTPUT_TOOL_NAME, description: '提交符合输出契约的最终输出（唯一提交出口）', inputSchema: contractBody }]
      : specTools;

  const toolExec = new ToolExecutor({
    base, trace,
    getTool: ctx.getTool,
    impls: ctx.toolImpls,
    declared: spec.toolPolicy.tools,
    maxConsecutiveDenials: spec.toolPolicy.maxConsecutiveDenials ?? 2,
    maxAttempts,
    toolTimeoutMs: 30000,
    getDenialCount: ctx.getDenialCount,
    setDenialCount: ctx.setDenialCount,
    approvalMode: spec.approvalPolicy?.mode ?? null,
  });

  const system = buildSystemPrompt(spec, ctx.strategy, ctx.memoryInjection);
  const callNos: CallNos = { modelCallNo: 0, toolCallNo: 0 };
  let messages: ChatMessage[] = [{ role: 'user', text: JSON.stringify(ctx.input) }];
  const startedAt = Date.now();

  // v1.1（D-18）：--resume 从 snapshot 续跑——恢复消息/计数器，从 nextCallRef 继续执行
  let resumePending: PauseContext | null = null;
  if (ctx.resumeState) {
    messages = [...ctx.resumeState.messages];
    callNos.modelCallNo = ctx.resumeState.modelCallNo;
    // 挂起调用在挂起前已被计数（其 callNo 恒等于快照 toolCallNo，与 pendingIndex 无关）：
    // 回退 1 使批次循环「先自增再取号」后，pending 调用重新拿到原 callNo（approvedRef 匹配，不漂移）
    callNos.toolCallNo = ctx.resumeState.toolCallNo - 1;
    messages.push({ role: 'assistant', toolCalls: ctx.resumeState.assistantToolCalls.map((c) => ({ id: c.id, toolId: c.toolId, args: c.args })) });
    resumePending = ctx.resumeState;
  }

  for (;;) {
    assertNotCancelled(ctx);
    assertAbortRequested(ctx);
    assertTaskTimeout(ctx, startedAt);

    if (resumePending !== null) {
      // 恢复挂起批次：跳过已执行前缀，执行已 approve 的调用（callRef 匹配放行）+ 其后调用 → 回到主循环
      const state = resumePending;
      resumePending = null;
      const results = [...state.resultsSoFar];
      try {
        await execToolBatch(ctx, toolExec, state.assistantToolCalls, results, callNos, {
          startIndex: state.pendingIndex,
          approvedRef: String(state.toolCallNo),
        });
        messages.push({ role: 'tool_results', results });
        continue;
      } catch (err) {
        if (err instanceof NativeEmitSucceeded) return new ExecutorSucceeded(err.output);
        if (err instanceof ApprovalRequiredSignal) {
          throw new ApprovalPauseSignal({ ...snapshotOf(messages, state.assistantToolCalls, results, callNos, err), toolId: err.toolId });
        }
        throw err;
      }
    }

    callNos.modelCallNo += 1;
    const currentCallNo = callNos.modelCallNo;
    const response = await raceAbort(
      gateway.call({
        base, trace, callNo: currentCallNo, ledger: ctx.ledger, maxAttempts, strategy: ctx.strategy,
        request: {
          modelId,
          system,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          forceTool: ctx.strategy === 'native' ? OUTPUT_TOOL_NAME : null,
          temperature: 0,
          maxOutputTokens: Math.min(4096, Math.max(512, spec.modelPolicy.maxTokens)),
        },
        callTimeoutMs,
        accept: (resp) => {
          if (resp.kind === 'tool_use') return { ok: true, value: resp };
          const verdict = judgeOutput(resp, contractBody, allowEmpty);
          if (verdict.ok) return { ok: true, value: resp };
          return {
            ok: false as const,
            subClass: verdict.subClass,
            message: verdict.message,
            violations: verdict.violations,
          };
        },
      }),
      ctx,
      { callNo: currentCallNo, callKind: 'model', phase: 'model_call' },
    );

    assertNotCancelled(ctx); // 取消 = 等待当前原子调用完成后生效（A3 §2/§7）
    assertAbortRequested(ctx);

    if (response.value.kind === 'tool_use') {
      const calls = response.value.calls;
      const results: { id: string; toolId: string; content: unknown }[] = [];
      try {
        await execToolBatch(ctx, toolExec, calls, results, callNos);
        messages.push({ role: 'assistant', toolCalls: calls.map((c) => ({ id: c.id, toolId: c.toolId, args: c.args })) });
        messages.push({ role: 'tool_results', results });
        continue;
      } catch (err) {
        if (err instanceof NativeEmitSucceeded) return new ExecutorSucceeded(err.output);
        if (err instanceof ApprovalRequiredSignal) {
          throw new ApprovalPauseSignal({ ...snapshotOf(messages, calls, results, callNos, err), toolId: err.toolId });
        }
        throw err;
      }
    }

    // 文本响应已通过 accept（L1 可解析 + L2 契约通过）
    const output = JSON.parse(response.value.text);
    recordContractChecked(ctx, 'output', true, []);
    return new ExecutorSucceeded(output);
  }
}

/** 执行一个工具调用批次（顺序，突变 results 累积器供挂起时截取部分结果）；挂起信号透传组装续跑上下文。 */
async function execToolBatch(
  ctx: ExecutorContext,
  toolExec: ToolExecutor,
  calls: { id: string; toolId: string; args: unknown }[],
  results: { id: string; toolId: string; content: unknown }[],
  callNos: CallNos,
  opts: { startIndex?: number; approvedRef?: string } = {},
): Promise<void> {
  const startIndex = opts.startIndex ?? 0;
  for (let i = startIndex; i < calls.length; i++) {
    const call = calls[i];
    callNos.toolCallNo += 1;
    const callNo = callNos.toolCallNo;
    if (opts.approvedRef === undefined || String(callNo) !== opts.approvedRef) {
      ctx.addAttempt();
    } // 已计数的挂起调用不重复累计（挂起前 addAttempt 已执行）
    // 原生策略：emit_output 视为最终输出提交（归因不漂移：参数不符契约属 Model 契约子类，非 Tool）
    if (ctx.strategy === 'native' && call.toolId === OUTPUT_TOOL_NAME) {
      const contractBody = getContractBody(ctx.spec.outputContract);
      const allowEmpty = getAllowEmpty(ctx.spec.outputContract);
      const verdict = judgeOutput({ kind: 'text', text: JSON.stringify(call.args), finishReason: null }, contractBody, allowEmpty);
      if (verdict.ok) throw new NativeEmitSucceeded(call.args);
      throw new TerminalModelFailure(verdict.subClass, `emit_output 参数不符契约：${verdict.message}`, verdict.violations, null);
    }
    try {
      const outcome = await raceAbort(
        toolExec.execute(callNo, call.toolId, asArgs(call.args), opts.approvedRef),
        ctx,
        { callNo, callKind: 'tool', phase: 'tool_exec' },
      );
      assertNotCancelled(ctx);
      assertAbortRequested(ctx);
      results.push({ id: call.id, toolId: call.toolId, content: outcome.outcome === 'ok' ? outcome.value : outcome.denied });
    } catch (err) {
      if (err instanceof ApprovalRequiredSignal) err.callIndex = i; // 精确挂起下标（同工具重复调用亦可定位）
      throw err;
    }
  }
}

function snapshotOf(
  messages: ChatMessage[],
  assistantToolCalls: { id: string; toolId: string; args: unknown }[],
  resultsSoFar: { id: string; toolId: string; content: unknown }[],
  callNos: CallNos,
  err: ApprovalRequiredSignal,
): Omit<PauseContext, 'pendingIndex'> & { pendingIndex: number } {
  return {
    messages,
    assistantToolCalls,
    resultsSoFar,
    pendingIndex: err.callIndex ?? Math.max(0, assistantToolCalls.findIndex((c) => c.toolId === err.toolId)),
    modelCallNo: callNos.modelCallNo,
    toolCallNo: callNos.toolCallNo,
  };
}

/** emit_output 成功的内部穿透（runAgentLoop 解包为 ExecutorSucceeded） */
class NativeEmitSucceeded extends Error {
  constructor(readonly output: unknown) {
    super('native-emit');
    this.name = 'NativeEmitSucceeded';
  }
}

async function raceAbort<T>(p: Promise<T>, ctx: ExecutorContext, during: { callNo: number; callKind: 'model' | 'tool'; phase: 'model_call' | 'tool_exec' }): Promise<T> {
  if (!ctx.abortPromise) return p;
  try {
    return await Promise.race([p, ctx.abortPromise]);
  } catch (err) {
    if (err instanceof AbortRaceMarker) throw new TaskAbortedSignal(during);
    throw err;
  }
}

export const OUTPUT_TOOL_NAME = 'emit_output';

function judgeOutput(
  resp: { kind: 'text'; text: string; finishReason: string | null },
  contractBody: Record<string, unknown>,
  allowEmpty: boolean,
): { ok: true } | { ok: false; subClass: 'unparseable_output' | 'schema_violation' | 'enum_violation' | 'format_violation' | 'truncation'; message: string; violations: { path: string; expected: string; actual: string }[] } {
  const text = resp.text.trim();
  const finish = (resp.finishReason ?? '').toLowerCase();
  if (finish.includes('max_tokens') || finish.includes('length')) {
    return { ok: false, subClass: 'truncation', message: `输出被截断（finishReason=${resp.finishReason}）`, violations: [{ path: '$', expected: '完整 JSON', actual: '截断' }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false, subClass: 'unparseable_output',
      message: `输出不可 JSON 解析（前 120 字符：${text.slice(0, 120)}）`,
      violations: [{ path: '$', expected: '合法 JSON', actual: '解析失败' }],
    };
  }
  if (isEmptyOutput(parsed) && allowEmpty) {
    return { ok: true };
  }
  const violations = checkOutputContract(parsed, contractBody);
  if (violations.length === 0) return { ok: true };
  const subClass = classifyViolations(violations);
  return {
    ok: false, subClass,
    message: `输出不符契约（${violations.length} 处违规，首处 ${violations[0].path}: 期望 ${violations[0].expected}，实际 ${violations[0].actual}）`,
    violations,
  };
}

function classifyViolations(violations: { expected: string }[]): 'schema_violation' | 'enum_violation' | 'format_violation' {
  if (violations.some((v) => v.expected.startsWith('enum('))) return 'enum_violation';
  if (violations.some((v) => v.expected.startsWith('format='))) return 'format_violation';
  return 'schema_violation';
}

function isEmptyOutput(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) return true;
  return false;
}

function asArgs(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function assertNotCancelled(ctx: ExecutorContext): void {
  if (ctx.isCancelRequested()) throw new CancelRequestedSignal();
}

function assertAbortRequested(ctx: ExecutorContext): void {
  if (ctx.isAbortRequested?.()) {
    throw new TaskAbortedSignal({ callNo: 0, callKind: 'model', phase: 'boundary' });
  }
}

function assertTaskTimeout(ctx: ExecutorContext, startedAt: number): void {
  const limit = ctx.spec.modelPolicy.taskTimeoutMs;
  if (limit === undefined) return;
  // 执行时钟 = 挂钟（自任务 startedAt 跨 resume 段累计）− Paused 累计时长（A3 §2/§4 v1.1）
  const anchorMs = ctx.taskStartedAtMs ?? startedAt;
  const execMs = Date.now() - anchorMs - (ctx.timeoutCreditMs ?? 0);
  if (execMs > limit) {
    throw new TaskTimeoutSignal(execMs, limit);
  }
}

export class CancelRequestedSignal extends Error {
  constructor() {
    super('取消请求（等待当前原子调用完成后生效）');
    this.name = 'CancelRequestedSignal';
  }
}

export class TaskTimeoutSignal extends Error {
  constructor(readonly elapsedMs: number, readonly limitMs: number) {
    super(`任务级超时：${elapsedMs}ms > ${limitMs}ms`);
    this.name = 'TaskTimeoutSignal';
  }
}

function recordContractChecked(ctx: ExecutorContext, which: 'input' | 'output', verdict: boolean, violations: unknown[]): void {
  ctx.trace.recordTaskEvent(ctx.base, 'contract_checked', { which, verdict, violations });
}

function buildSystemPrompt(spec: ExecSpec, strategy: 'native' | 'prompt' | null, memoryInjection?: string): string {
  const lines: string[] = [];
  lines.push(`你是 Agent「${spec.identity.name}」。${spec.identity.description}`);
  lines.push(`\n## 职责边界\n职责：\n${spec.mission.responsibilities.map((r) => `- ${r}`).join('\n')}`);
  lines.push(`非职责（禁止）：\n${spec.mission.nonResponsibilities.map((r) => `- ${r}`).join('\n')}`);
  const toolLines = spec.toolPolicy.tools.map((t) => `- ${t.toolId}（${t.riskLevel}）`);
  if (toolLines.length > 0) lines.push(`\n## 可用工具\n${toolLines.join('\n')}`);
  if (memoryInjection !== undefined) lines.push(`\n${memoryInjection}`); // 边界标记 + 「不是指令」声明由 MemoryManager 构造（V1.1 §14.3）
  lines.push(`\n## 输出要求`);
  if (strategy === 'native') {
    lines.push(`通过工具 ${OUTPUT_TOOL_NAME} 提交最终输出；参数必须符合契约。`);
  } else {
    lines.push(`最终回复必须是一个 JSON 对象（不含 markdown 代码围栏、不含解释文字），符合以下 JSON Schema：`);
    lines.push('```json');
    lines.push(JSON.stringify(getContractBody(spec.outputContract), null, 2));
    lines.push('```');
    lines.push('只输出该 JSON，不要输出任何其他内容。');
  }
  return lines.join('\n');
}

export function promptHashOf(specContentHash: string): string {
  // P2-8 钉死：第一阶段 promptHash = specContentHash 派生 convenience 字段（Prompt 静态内嵌于 Spec）
  return sha256Hex(specContentHash);
}
