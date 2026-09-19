import type { Runtime } from '../runtime.js';
import type { TraceEnvelope } from '../modules/traceRecorder.js';

// 假设 #4 实验报告聚合（A4 §4 C2 口径）：
// 分母 = 全部尝试样本 −（provider_infra + provider_rejected_schema + 判例排除）；成功样本在分母内；
// 分子 = attempt 1 即契约通过的样本数（首次通过率主指标）；
// Wilson 95% CI；按 Spec 分层（S1/S2/S3 禁止只报合计）；失败分布按 subClass 直方。

const CONTRACT_SUBCLASSES = new Set(['unparseable_output', 'schema_violation', 'enum_violation', 'format_violation', 'truncation']);

export interface ReportJob {
  specId: string;
  strategy: 'A' | 'B';
  task: { id: string } & Record<string, unknown>;
  taskId: string | null;
  error: string | null;
}

export interface ReportInput {
  rt: Runtime;
  specIds: string[];
  specLabels: Record<string, string>;
  strategies: ('A' | 'B')[];
  model: string;
  gitHash: string;
  jobs: ReportJob[];
}

export function wilsonCi(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

interface LayerStat {
  total: number;
  firstPass: number;
  withRetryPass: number;
  avgAttempts: number;
  failureHist: Record<string, number>; // attempt 级 + 终局（标注 terminal: 前缀）
  excludedInfra: number;
  excludedProviderRejectedSchema: number;
  providerPassedLocalFailed: number; // 策略 A：Provider 通过但本地 L2 失败（语义不一致直接度量）
  errors: number; // createTask/runTask 抛错（不应发生）
}

export function generateReport(input: ReportInput): string {
  const { rt, specIds, specLabels, strategies } = input;
  const lines: string[] = [];

  const taskJobByTaskId = new Map<string, ReportJob>();
  for (const j of input.jobs) if (j.taskId) taskJobByTaskId.set(j.taskId, j);

  const stat = (specId: string, strategy: 'A' | 'B'): LayerStat => {
    const s: LayerStat = {
      total: 0, firstPass: 0, withRetryPass: 0, avgAttempts: 0,
      failureHist: {}, excludedInfra: 0, excludedProviderRejectedSchema: 0,
      providerPassedLocalFailed: 0, errors: 0,
    };
    let attemptSum = 0;
    for (const j of input.jobs) {
      if (j.specId !== specId || j.strategy !== strategy) continue;
      s.total += 1;
      if (!j.taskId || j.error) {
        s.errors += 1;
        continue;
      }
      const events = rt.trace.readEvents(j.taskId);
      const modelAttempts = events.filter((e) => e.eventType === 'model_call_completed').length;
      attemptSum += Math.max(1, modelAttempts);
      const modelAttemptFailures = events.filter((e) => e.eventType === 'attempt_failed' && e.callKind === 'model');
      const succeeded = events.some((e) => e.eventType === 'task_succeeded');
      if (succeeded && modelAttemptFailures.length === 0) s.firstPass += 1;
      if (succeeded) s.withRetryPass += 1;
      for (const f of modelAttemptFailures as (TraceEnvelope & { subClass: string })[]) {
        if (f.subClass === 'provider_infra') {
          s.excludedInfra += 1;
          continue;
        }
        if (f.subClass === 'provider_rejected_schema') {
          s.excludedProviderRejectedSchema += 1;
          continue;
        }
        s.failureHist[f.subClass] = (s.failureHist[f.subClass] ?? 0) + 1;
        // 仅契约子类计入「Provider 通过但本地校验失败」（call_timeout 等非语义不一致样本不计）
        if (strategy === 'A' && CONTRACT_SUBCLASSES.has(f.subClass)) s.providerPassedLocalFailed += 1;
      }
      const terminal = events.find((e) => e.eventType === 'task_failed') as (TraceEnvelope & { subClass: string }) | undefined;
      if (terminal) s.failureHist[`terminal:${terminal.subClass}`] = (s.failureHist[`terminal:${terminal.subClass}`] ?? 0) + 1;
    }
    const counted = s.total - s.errors - s.excludedInfra - s.excludedProviderRejectedSchema;
    s.avgAttempts = counted > 0 ? attemptSum / Math.max(1, counted) : 0;
    return s;
  };

  lines.push('# 假设 #4 验证实验报告（LLM 输出契约可约束性）');
  lines.push('');
  lines.push(`- **制品冻结 Git 哈希：** \`${input.gitHash}\`（Specs 与任务集启动前固化，启动后未修改）`);
  lines.push(`- **模型：** ${input.model}（单一模型、版本钉死、temperature=0）`);
  lines.push(`- **策略：** A = 原生 structured output（强制工具 emit_output）；B = 纯 Prompt 声明 Schema + 解析校验`);
  lines.push(`- **重试预算：** 首次（主指标）+ ≤2 次重试（maxAttempts=3，05 号裁定）`);
  lines.push(`- **数据通道：** TraceRecorder 标准通道（实验数据 = Trace 数据，11 号 §2.2）`);
  lines.push(`- **口径：** 分母 = 全部尝试样本 −（provider_infra + provider_rejected_schema + 判例排除）；分子 = attempt 1 即契约通过（A4 §4）`);
  lines.push('');

  for (const strategy of strategies) {
    lines.push(`## 策略 ${strategy === 'A' ? 'A（原生 structured output）' : 'B（纯 Prompt 声明）'}`);
    lines.push('');
    lines.push('| Spec 分层 | N | 分母(计入) | 首次通过(主指标) | 首次通过率 | Wilson 95% CI | 含重试通过率 | 平均模型调用/任务（成本代理） |');
    lines.push('|---|---|---|---|---|---|---|---|');
    const stats: LayerStat[] = [];
    for (const specId of specIds) {
      const s = stat(specId, strategy);
      stats.push(s);
      const denom = s.total - s.errors - s.excludedInfra - s.excludedProviderRejectedSchema;
      const [lo, hi] = wilsonCi(s.firstPass, denom);
      lines.push(
        `| ${specLabels[specId] ?? specId} | ${s.total} | ${denom} | ${s.firstPass} | ${(s.firstPass / Math.max(1, denom) * 100).toFixed(1)}% | [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%] | ${(s.withRetryPass / Math.max(1, denom) * 100).toFixed(1)}% | ${s.avgAttempts.toFixed(2)} |`,
      );
    }
    const agg: LayerStat = stats.reduce(
      (acc, s) => ({
        ...acc,
        total: acc.total + s.total,
        firstPass: acc.firstPass + s.firstPass,
        withRetryPass: acc.withRetryPass + s.withRetryPass,
        errors: acc.errors + s.errors,
        excludedInfra: acc.excludedInfra + s.excludedInfra,
        excludedProviderRejectedSchema: acc.excludedProviderRejectedSchema + s.excludedProviderRejectedSchema,
        providerPassedLocalFailed: acc.providerPassedLocalFailed + s.providerPassedLocalFailed,
        avgAttempts: 0,
        failureHist: {},
      }),
      { total: 0, firstPass: 0, withRetryPass: 0, avgAttempts: 0, failureHist: {}, excludedInfra: 0, excludedProviderRejectedSchema: 0, providerPassedLocalFailed: 0, errors: 0 },
    );
    const denomAgg = agg.total - agg.errors - agg.excludedInfra - agg.excludedProviderRejectedSchema;
    const [lo, hi] = wilsonCi(agg.firstPass, denomAgg);
    lines.push(
      `| **合计（仅参考，分层为准）** | ${agg.total} | ${denomAgg} | ${agg.firstPass} | **${(agg.firstPass / Math.max(1, denomAgg) * 100).toFixed(1)}%** | [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%] | ${(agg.withRetryPass / Math.max(1, denomAgg) * 100).toFixed(1)}% | — |`,
    );
    lines.push('');
    for (const specId of specIds) {
      const s = stat(specId, strategy);
      lines.push(`### 失败分布（${specLabels[specId] ?? specId}，策略 ${strategy}）`);
      lines.push('');
      if (Object.keys(s.failureHist).length === 0) {
        lines.push('无失败样本。');
      } else {
        lines.push('| subClass（attempt 级 / terminal: 终局） | 次数 |');
        lines.push('|---|---|');
        for (const [k, v] of Object.entries(s.failureHist).sort((a, b) => b[1] - a[1])) {
          lines.push(`| ${k} | ${v} |`);
        }
      }
      lines.push('');
      lines.push(`排除计数：provider_infra = ${s.excludedInfra}；provider_rejected_schema = ${s.excludedProviderRejectedSchema}；执行错误 = ${s.errors}；Provider 通过但本地校验失败 = ${s.providerPassedLocalFailed}${strategy === 'A' ? '（语义不一致直接度量，ND-2 副产品）' : ''}。`);
      lines.push('');
    }
  }

  lines.push('## 判定（05 号裁决 1）');
  lines.push('');
  lines.push('- 决策线：首次通过率 ≥80%（按 Spec 分层）；<80% 触发显式第二阶段决策点，非隐式兜底。');
  lines.push('- 小样本声明：N=30/策略时 80% 观测率的 95% Wilson CI 约 65%–90%，须诚实呈现不确定性（11 号 §2.1）。');
  lines.push('- 本报告无论通过与否均已归档；分支动作见 11 号 §2.3。');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*报告由 WP-B 实验运行器自动生成（experiments/hypothesis4 → src/experiment）。*');
  return lines.join('\n');
}
