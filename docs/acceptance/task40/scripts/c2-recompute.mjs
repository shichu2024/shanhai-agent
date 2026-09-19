// C2 验收：从实验原始 Trace（JSONL）独立重算契约通过率（不复用 src/experiment/report.ts 聚合代码）
// 口径（A4 §4）：分母 = 任务样本 − (provider_infra + provider_rejected_schema)；
// 分子 = attempt 1 即契约通过（task_succeeded 且无 model 类 attempt_failed）；
// Wilson 95% CI 独立实现。分层（s1/s2/s3 × A/B）禁止只报合计。
import { readdirSync, readFileSync } from 'node:fs';

const RUN = 'D:/code/shanhai-agent/experiment-runs/hyp4-2026-09-19T07-44-53/traces';

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [p, Math.max(0, c - h), Math.min(1, c + h)];
}

const tasks = [];
for (const f of readdirSync(RUN)) {
  const events = readFileSync(`${RUN}/${f}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const agentId = events[0].agentId; // hyp4-s1-summary 等
  const strategyEvent = events.find((e) => e.eventType === 'model_call_completed');
  const strategy = strategyEvent?.strategy === 'native' ? 'A' : strategyEvent?.strategy === 'prompt' ? 'B' : null;
  const modelFailures = events.filter((e) => e.eventType === 'attempt_failed' && e.callKind === 'model');
  const succeeded = events.some((e) => e.eventType === 'task_succeeded');
  const terminal = events.find((e) => e.eventType === 'task_failed');
  const modelCalls = events.filter((e) => e.eventType === 'model_call_completed').length;
  tasks.push({
    file: f,
    agentId,
    strategy,
    modelCalls,
    succeeded,
    firstPass: succeeded && modelFailures.length === 0,
    subClasses: modelFailures.map((e) => e.subClass),
    terminalSubClass: terminal?.subClass ?? null,
  });
}

const groups = {};
for (const t of tasks) {
  if (!t.strategy) continue;
  const key = `${t.agentId}|${t.strategy}`;
  groups[key] ??= { total: 0, firstPass: 0, withRetry: 0, modelCallsSum: 0, hist: {}, excludedInfra: 0, excludedSchema: 0, terminalHist: {} };
  const g = groups[key];
  g.total += 1;
  g.modelCallsSum += Math.max(1, t.modelCalls);
  if (t.firstPass) g.firstPass += 1;
  if (t.succeeded) g.withRetry += 1;
  for (const s of t.subClasses) {
    if (s === 'provider_infra') { g.excludedInfra += 1; continue; }
    if (s === 'provider_rejected_schema') { g.excludedSchema += 1; continue; }
    g.hist[s] = (g.hist[s] ?? 0) + 1;
  }
  if (t.terminalSubClass) g.terminalHist['terminal:' + t.terminalSubClass] = (g.terminalHist['terminal:' + t.terminalSubClass] ?? 0) + 1;
}

const out = { run: RUN, taskCount: tasks.length, layers: {} };
for (const [key, g] of Object.entries(groups).sort()) {
  const denom = g.total - g.excludedInfra - g.excludedSchema;
  const [p, lo, hi] = wilson(g.firstPass, denom);
  out.layers[key] = {
    N: g.total, denom, firstPass: g.firstPass,
    rate: (p * 100).toFixed(1) + '%',
    wilson95: `[${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`,
    withRetry: ((g.withRetry / denom) * 100).toFixed(1) + '%',
    avgModelCalls: (g.modelCallsSum / denom).toFixed(2),
    attemptFailHist: g.hist, terminalHist: g.terminalHist,
    excluded: { provider_infra: g.excludedInfra, provider_rejected_schema: g.excludedSchema },
    decisionLine: p >= 0.8 ? '≥80% 通过' : '<80% 触发决策点',
  };
}
console.log(JSON.stringify(out, null, 2));
