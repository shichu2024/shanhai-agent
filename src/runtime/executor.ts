import type { TraceRecorder } from '../modules/traceRecorder.js';
import type { ModelGateway, BudgetLedger } from '../modules/modelGateway.js';
import type { ProviderResponse } from '../providers/types.js';
import type { ChatMessage, ToolDeclaration } from '../providers/types.js';
import { ToolExecutor, ToolTerminalFailure, type SpecToolDeclaration, type PolicyDeniedResult } from '../modules/toolExecutor.js';
import { TerminalModelFailure } from '../modules/modelGateway.js';
import { checkOutputContract, getAllowEmpty, getContractBody } from '../modules/specValidator.js';
import { sha256Hex } from '../hash.js';

// Agent 执行循环（应龙 Runtime 最小执行内核）：
// 模型调用 → 工具调用（过闸门）→ 最终输出 → outputContract 校验。
// 工作记忆 = 任务内 messages 上下文（第一阶段仅工作记忆，定稿 §2 差额表）。

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
}

export class ExecutorSucceeded {
  constructor(readonly output: unknown) {}
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
  });

  const system = buildSystemPrompt(spec, ctx.strategy);
  const messages: ChatMessage[] = [{ role: 'user', text: JSON.stringify(ctx.input) }];
  let modelCallNo = 0;
  let toolCallNo = 0;
  const startedAt = Date.now();

  for (;;) {
    assertNotCancelled(ctx);
    assertTaskTimeout(ctx, startedAt);

    modelCallNo += 1;
    const currentCallNo = modelCallNo;
    const response = await gateway.call({
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
    });

    assertNotCancelled(ctx); // 取消 = 等待当前原子调用完成后生效（A3 §2/§7）

    if (response.value.kind === 'tool_use') {
      const results: { id: string; toolId: string; content: unknown }[] = [];
      for (const call of response.value.calls) {
        toolCallNo += 1;
        ctx.addAttempt();
        // 原生策略：emit_output 视为最终输出提交（归因不漂移：参数不符契约属 Model 契约子类，非 Tool）
        if (ctx.strategy === 'native' && call.toolId === OUTPUT_TOOL_NAME) {
          const verdict = judgeOutput({ kind: 'text', text: JSON.stringify(call.args), finishReason: null }, contractBody, allowEmpty);
          if (verdict.ok) return new ExecutorSucceeded(call.args);
          throw new TerminalModelFailure(verdict.subClass, `emit_output 参数不符契约：${verdict.message}`, verdict.violations, null);
        }
        const outcome = await toolExec.execute(toolCallNo, call.toolId, asArgs(call.args));
        assertNotCancelled(ctx);
        results.push({ id: call.id, toolId: call.toolId, content: outcome.outcome === 'ok' ? outcome.value : outcome.denied });
      }
      messages.push({ role: 'assistant', toolCalls: response.value.calls.map((c) => ({ id: c.id, toolId: c.toolId, args: c.args })) });
      messages.push({ role: 'tool_results', results });
      continue;
    }

    // 文本响应已通过 accept（L1 可解析 + L2 契约通过）
    const output = JSON.parse(response.value.text);
    recordContractChecked(ctx, 'output', true, []);
    return new ExecutorSucceeded(output);
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

function assertTaskTimeout(ctx: ExecutorContext, startedAt: number): void {
  const limit = ctx.spec.modelPolicy.taskTimeoutMs;
  if (limit !== undefined && Date.now() - startedAt > limit) {
    throw new TaskTimeoutSignal(Date.now() - startedAt, limit);
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

function buildSystemPrompt(spec: ExecSpec, strategy: 'native' | 'prompt' | null): string {
  const lines: string[] = [];
  lines.push(`你是 Agent「${spec.identity.name}」。${spec.identity.description}`);
  lines.push(`\n## 职责边界\n职责：\n${spec.mission.responsibilities.map((r) => `- ${r}`).join('\n')}`);
  lines.push(`非职责（禁止）：\n${spec.mission.nonResponsibilities.map((r) => `- ${r}`).join('\n')}`);
  const toolLines = spec.toolPolicy.tools.map((t) => `- ${t.toolId}（${t.riskLevel}）`);
  if (toolLines.length > 0) lines.push(`\n## 可用工具\n${toolLines.join('\n')}`);
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
