import { z } from 'zod';
import { checkSubset, validateInstance, type ContractViolation, type SubsetViolation } from './contractSchema.js';

// A1 §2–§3 字段表 → zod 元 Schema；A1 §4 + A3 §3.1 两层校验职责 → 两个入口函数。
// D-1 附条件落地：注册拒绝错误信息必须指名字段路径。

const jsonSchemaNode = z.record(z.unknown());

const metaSchema = z
  .object({
    specVersion: z.literal('1', { errorMap: () => ({ message: 'specVersion 必须为 "1"' }) }),
    identity: z.object({
      agentId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, '须匹配 ^[a-z][a-z0-9-]{1,63}$'),
      name: z.string().min(1).max(64),
      description: z.string().min(1).max(512),
      author: z.string().optional(),
    }),
    mission: z.object({
      responsibilities: z.array(z.string().min(1).max(200)).min(1),
      nonResponsibilities: z.array(z.string().min(1).max(200)).min(1),
    }),
    inputContract: jsonSchemaNode,
    outputContract: jsonSchemaNode,
    modelPolicy: z.object({
      allowedModels: z.array(z.string().min(1)).min(1),
      maxModelCalls: z.number().int().min(1),
      maxTokens: z.number().int().min(1),
      maxAttempts: z.number().int().min(1).optional(),
      callTimeoutMs: z.number().int().min(1).optional(),
      taskTimeoutMs: z.number().int().min(1).optional(),
      fallbackModel: z.string().optional(),
    }),
    toolPolicy: z.object({
      tools: z
        .array(
          z.object({
            toolId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
            riskLevel: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
            controlledFields: z
              .object({
                paramRanges: z.record(z.unknown()).optional(),
                targetWhitelist: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            notes: z.string().optional(),
          }),
        )
        .min(1),
      maxConsecutiveDenials: z.number().int().min(1).optional(),
    }),
    evaluationPolicy: z
      .object({
        assertions: z
          .array(z.object({ path: z.string(), op: z.string(), value: z.unknown().optional() }))
          .optional(),
        reviewGate: z.enum(['manual', 'assertions', 'none']).optional(), // v1.1（A1 §2）：A5 review 检视门消费，缺省 manual
      })
      .optional()
      .nullable(),
    memoryPolicy: z.object({ type: z.literal('working') }).optional(),
    approvalPolicy: z // v1.1 增补（A1 §2.2，D-8/D-9/D-18）：缺省 = 无审批路径（V1 行为不变）
      .object({
        mode: z.enum(['never', 'onHighRisk'], { errorMap: () => ({ message: 'approvalPolicy.mode 仅为 never/onHighRisk（always 注册拒绝，防伪声明——D-9）' }) }),
        timeoutMs: z.number().int().min(1000).optional(),
        onTimeout: z.enum(['deny', 'fail']).optional(),
      })
      .optional()
      .nullable(),
  })
  .strict(); // 顶层封闭：evolutionPolicy 等未声明字段出现即拒绝（A1 §2 顶层禁止字段）

export interface ToolRegistryEntryView {
  toolId: string;
  riskLevel: string;
  status: string;
  implVersion: string;
  controlledFieldsSchema: string | null;
}

export interface ValidationDeps {
  getTool(toolId: string): ToolRegistryEntryView | null;
  modelWhitelist: ReadonlySet<string>;
}

export interface SpecIssue {
  path: string;
  message: string;
}

export interface RegistrationValidationResult {
  ok: boolean;
  issues: SpecIssue[];
}

/** 注册时校验（准入）：元 Schema + 引用完整性 + A2 §6 子集（A1 §4 第①层） */
export function validateRegistration(spec: unknown, deps: ValidationDeps): RegistrationValidationResult {
  const issues: SpecIssue[] = [];

  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, issues: [{ path: '$', message: 'Spec 必须为 JSON 对象' }] };
  }
  const raw = spec as Record<string, unknown>;
  if ('evolutionPolicy' in raw) {
    issues.push({ path: 'evolutionPolicy', message: '顶层禁止字段（Q5-3 已删除；出现即注册拒绝）' });
  }

  const parsed = metaSchema.safeParse(spec);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ path: issue.path.join('.') || '$', message: issue.message });
    }
    return { ok: false, issues };
  }
  const s = parsed.data;

  // memoryPolicy 其他取值注册拒绝（防伪声明）—— zod literal 已保证；显式留位说明
  // 引用完整性（A1 §4-②）
  s.toolPolicy.tools.forEach((t, i) => {
    const entry = deps.getTool(t.toolId);
    const base = `toolPolicy.tools[${i}]`;
    if (!entry) {
      issues.push({ path: `${base}.toolId`, message: `未注册：${t.toolId}` });
      return;
    }
    if (entry.status !== 'active') {
      issues.push({ path: `${base}.toolId`, message: `工具 ${t.toolId} 已 ${entry.status}（悬空引用防线，A2 附录 A）` });
    }
    if (entry.riskLevel !== t.riskLevel) {
      issues.push({ path: `${base}.riskLevel`, message: `声明 ${t.riskLevel} 与登记 ${entry.riskLevel} 不一致` });
    }
    if (t.riskLevel === 'L3') {
      // A2 §4-3 v1.1（D-8）：L3 注册放行，仅当 approvalPolicy.mode=onHighRisk（防「声明了却无审批路径」的死声明）
      const mode = s.approvalPolicy?.mode;
      if (mode !== 'onHighRisk') {
        issues.push({
          path: `${base}.riskLevel`,
          message: `${t.toolId} 为 L3：引用 L3 工具须声明 approvalPolicy.mode=onHighRisk，否则注册即拒（D-8；当前 ${mode ?? '未声明 approvalPolicy'}）`,
        });
      }
    }
    if (t.riskLevel === 'L4') {
      issues.push({
        path: `${base}.riskLevel`,
        message: `${t.toolId} 为 L4：禁区工具注册即拒，永久（D-3；写入安全域/凭据操作不属于「人工可审」范畴）`,
      });
    }
    if (t.riskLevel === 'L2') {
      const cf = t.controlledFields;
      const hasParam = cf?.paramRanges !== undefined;
      const hasWhitelist = cf?.targetWhitelist !== undefined;
      if (!cf || (!hasParam && !hasWhitelist)) {
        issues.push({
          path: `${base}.controlledFields`,
          message: 'L2 工具必须声明 paramRanges 与/或 targetWhitelist（二至少一，R-3）',
        });
      }
    }
  });

  for (const m of s.modelPolicy.allowedModels) {
    if (!deps.modelWhitelist.has(m)) {
      issues.push({ path: 'modelPolicy.allowedModels', message: `${m} 不在运行时白名单` });
    }
  }
  if (s.modelPolicy.fallbackModel && !s.modelPolicy.allowedModels.includes(s.modelPolicy.fallbackModel)) {
    issues.push({ path: 'modelPolicy.fallbackModel', message: '必须 ∈ allowedModels' });
  }

  // A2 §6 子集规则（input/output 对称）
  for (const [label, contract] of [['inputContract', s.inputContract], ['outputContract', s.outputContract]] as const) {
    const subsetViol: SubsetViolation[] = checkSubset(stripAllowEmpty(contract), label);
    for (const v of subsetViol) {
      issues.push({ path: v.path, message: `A2§6 子集违规：${v.message}` });
    }
    const top = stripAllowEmpty(contract) as Record<string, unknown>;
    if (top.type !== 'object') {
      issues.push({ path: `${label}.type`, message: '顶层必须 type:"object"' });
    }
  }

  return { ok: issues.length === 0, issues };
}

// outputContract 的 allowEmpty 扩展键（A1 §3.3）不参与 JSON Schema 语义
function stripAllowEmpty(contract: unknown): unknown {
  if (contract !== null && typeof contract === 'object' && !Array.isArray(contract)) {
    const { allowEmpty, ...rest } = contract as Record<string, unknown>;
    return rest;
  }
  return contract;
}

export function getAllowEmpty(outputContract: Record<string, unknown>): boolean {
  return outputContract.allowEmpty === true;
}

export function getContractBody(outputContract: Record<string, unknown>): Record<string, unknown> {
  return stripAllowEmpty(outputContract) as Record<string, unknown>;
}

/**
 * 任务时防御性重复校验（A1 §4 第②层）：同一校验器复跑 + 快照哈希比对 + 工具悬空引用 + 模型白名单漂移。
 * 失败 → Created → Failed: Spec(defensive_revalidation_failed)（A3 §3.1 分工表 ④）。
 */
export function validateDefensive(
  specSnapshot: unknown,
  expectedContentHash: string,
  actualContentHash: string,
  deps: ValidationDeps,
): RegistrationValidationResult {
  const issues: SpecIssue[] = [];
  if (expectedContentHash !== actualContentHash) {
    issues.push({ path: '$', message: `快照哈希不符：任务绑定 ${expectedContentHash}，库内 ${actualContentHash}` });
  }
  const revalidation = validateRegistration(specSnapshot, deps);
  // 防御性复验的哈希由调用方比对；此处结构/引用复跑
  for (const issue of revalidation.issues) {
    // 注册后风险等级只升不降（A2 附录 A），等级变更 → 悬空引用
    issues.push(issue);
  }
  return { ok: issues.length === 0, issues };
}

export function checkInputContract(input: unknown, inputContract: unknown): ContractViolation[] {
  return validateInstance(input, stripAllowEmpty(inputContract), 'input');
}

export function checkOutputContract(output: unknown, outputContract: unknown): ContractViolation[] {
  return validateInstance(output, stripAllowEmpty(outputContract), 'output');
}
