import type Database from 'better-sqlite3';

// A5 §2 v1.1：`agent report <agentId> [--since]`——按 assignmentSource 分组契约通过率对比（C2 聚合口径复用）
// + promote 机械判据（数据不足输出 insufficient-sample，系统不假装给了答案——决定权留人）
// + 旁挂三只读单列：审批超时计数（不进 C2 失败率，但必须可见）/ 受工具升级影响的 Spec（R-5）/ stale 汇总。

export interface GroupStats {
  assignmentSource: 'stable' | 'canary' | 'explicit' | 'unattributed';
  tasks: number;
  succeeded: number;
  contractFailures: number; // 计入契约失败率的任务数（A4 §1 口径物化列）
  contractPassRate: number | null; // tasks=0 → null（无分母不假装）
}

export interface ToolUpgradeAffectedSpec {
  versionId: string;
  toolId: string;
  declared: string;
  current: string;
}

export interface ReportAnswer {
  agentId: string;
  since: string | null;
  groups: GroupStats[];
  promoteCriteria: {
    status: 'promote-recommended' | 'insufficient-sample' | 'below-threshold' | 'no-canary';
    canaryPassRate: number | null;
    stablePassRate: number | null;
    canarySample: number;
    threshold: string; // 判据文字（机械输出，人裁决）
  };
  sideColumns: {
    approvalTimeoutCount: number; // 治理惰性信号（P3-1）：不进 C2 失败率，但必须可见
    toolUpgradeAffectedSpecs: ToolUpgradeAffectedSpec[]; // R-5：Spec 声明等级 < 当前登记等级的存量引用清单
    stale: { queued: number; paused: number }; // staleQueued/stalePaused 只读汇总
  };
  /** 批次四 DoD-①（设计 §4.8，D-15）：OTel 条件监测健康面板——只读指标 + 触发判定，不做常驻接入 */
  healthPanel: OtelHealthPanel;
}

export interface OtelHealthPanel {
  /** 触发条件①（D-15 量化）：单库 Trace 事件总数 / Trace 文件数 */
  traceEventCount: number;
  traceFileCount: number;
  /** 触发条件①：T1 单查询实测耗时（ms，本面板构建时对库内任务采样；样本 <5 输出 null——不假装） */
  t1QueryP95Ms: number | null;
  /** 条件①判定：traceEventCount > 10000 或 t1QueryP95Ms > 500 */
  triggered: boolean;
  /** 未满足前的义务（§4.8）：触发指标可见 + 归档投影层设计的提示（真源单一性不变——断言永不下沉 OTel） */
  note: string;
}

/** OTel 触发条件量化（D-15）：① 单库 Trace 事件 >10,000 或 T1 单查询 P95 >500ms */
export const OTEL_TRACE_EVENT_THRESHOLD = 10000;
export const OTEL_T1_P95_MS_THRESHOLD = 500;

/** 面板构建（只读，批次四 DoD-①）：事件计数走 trace_index 单查询；
 * T1 采样实测走注入的 queryT1（每任务单文件读取——本面板即其 P95 度量对象）；未注入 → P95 null（不假装） */
export function buildOtelHealthPanel(db: Database.Database, t1?: (taskId: string) => unknown): OtelHealthPanel {
  const traceEventCount = (db.prepare(`SELECT COUNT(*) AS c FROM trace_index`).get() as { c: number }).c;
  const traceFileCount = (db.prepare(`SELECT COUNT(DISTINCT taskId) AS c FROM trace_index`).get() as { c: number }).c;
  const sampleTasks = db.prepare(`SELECT taskId FROM task_record ORDER BY createdAt DESC LIMIT 10`).all() as { taskId: string }[];
  const latencies: number[] = [];
  if (t1 !== undefined) {
    for (const { taskId } of sampleTasks) {
      const t0 = process.hrtime.bigint();
      t1(taskId);
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  latencies.sort((a, b) => a - b);
  // P95（小样本按次序取整；样本 <5 → null——数据不足不假装）
  const t1QueryP95Ms = latencies.length >= 5 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;
  const triggered = traceEventCount > OTEL_TRACE_EVENT_THRESHOLD || (t1QueryP95Ms !== null && t1QueryP95Ms > OTEL_T1_P95_MS_THRESHOLD);
  return {
    traceEventCount,
    traceFileCount,
    t1QueryP95Ms,
    triggered,
    note: triggered
      ? 'OTel 触发条件①已满足——按 §4.8 投影层设计实施（JSONL+SQLite 永为真源，断言永不下沉 OTel 后端）'
      : '触发指标未达（条件①：Trace 事件 >10000 或 T1 P95 >500ms；条件②/③：多实例/外部 APM 需求——单机库内不可测，显式留位）。满足前义务：本面板只读监测，无后台进程',
  };
}

/** promote 建议判据（阈值可配；样本 <20 → insufficient-sample 显式输出，单机量级常不可达） */
export const PROMOTE_SAMPLE_MIN = 20;
export const PROMOTE_DROP_TOLERANCE = 0.05; // canary ≥ stable − 5pp

export function buildAgentReport(
  db: Database.Database,
  agentId: string,
  opts: { since?: string; t1?: (taskId: string) => unknown } = {},
): ReportAnswer {
  const since = opts.since ?? null;
  const healthPanelRef = buildOtelHealthPanel(db, opts.t1);

  const groups: GroupStats[] = [];
  for (const source of ['stable', 'canary', 'explicit'] as const) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS tasks,
                SUM(CASE WHEN t.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
         FROM task_record t WHERE t.agentId = ? AND t.assignmentSource = ? ${since ? 'AND t.createdAt >= ?' : ''}`,
      )
      .get(...(since ? [agentId, source, since] : [agentId, source])) as { tasks: number; succeeded: number | null };
    const contractFailures = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT f.taskId) AS c FROM failure_record f
           JOIN task_record t ON t.taskId = f.taskId
           WHERE t.agentId = ? AND t.assignmentSource = ? AND f.countedInContractRate = 1 ${since ? 'AND t.createdAt >= ?' : ''}`,
        )
        .get(...(since ? [agentId, source, since] : [agentId, source])) as { c: number }
    ).c;
    const tasks = row.tasks ?? 0;
    groups.push({
      assignmentSource: source,
      tasks,
      succeeded: row.succeeded ?? 0,
      contractFailures,
      contractPassRate: tasks > 0 ? (tasks - contractFailures) / tasks : null,
    });
  }

  const stable = groups.find((g) => g.assignmentSource === 'stable')!;
  const canary = groups.find((g) => g.assignmentSource === 'canary')!;
  const canaryPointer = (
    db.prepare('SELECT canaryVersionId FROM agent WHERE agentId = ?').get(agentId) as { canaryVersionId: string | null } | undefined
  )?.canaryVersionId ?? null;

  let criteria: ReportAnswer['promoteCriteria'];
  if (!canaryPointer) {
    criteria = { status: 'no-canary', canaryPassRate: canary.contractPassRate, stablePassRate: stable.contractPassRate, canarySample: canary.tasks, threshold: `无灰度进行中（canary 指针为空）` };
  } else if (canary.tasks < PROMOTE_SAMPLE_MIN) {
    criteria = {
      status: 'insufficient-sample',
      canaryPassRate: canary.contractPassRate,
      stablePassRate: stable.contractPassRate,
      canarySample: canary.tasks,
      threshold: `金丝雀样本 ${canary.tasks} < ${PROMOTE_SAMPLE_MIN}——数据不足，系统不假装给了答案`,
    };
  } else if (stable.tasks === 0 || stable.contractPassRate === null) {
    criteria = {
      status: 'insufficient-sample',
      canaryPassRate: canary.contractPassRate,
      stablePassRate: null,
      canarySample: canary.tasks,
      threshold: `stable 基线样本为 0——无对照组数据，系统不假装给了答案（先在 stable 组积累任务）`,
    };
  } else {
    const ok = canary.contractPassRate! >= stable.contractPassRate! - PROMOTE_DROP_TOLERANCE;
    criteria = {
      status: ok ? 'promote-recommended' : 'below-threshold',
      canaryPassRate: canary.contractPassRate,
      stablePassRate: stable.contractPassRate,
      canarySample: canary.tasks,
      threshold: `判据：金丝雀契约通过率 ≥ stable − ${PROMOTE_DROP_TOLERANCE * 100}pp 且样本 ≥ ${PROMOTE_SAMPLE_MIN}（机械输出，决定权留人）`,
    };
  }

  // 旁挂三只读单列
  const approvalTimeoutCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM task_record
         WHERE agentId = ? AND (cancelReason = 'approval_timeout' OR terminalFailureClass = 'Policy(ApprovalTimeout)')`,
      )
      .get(agentId) as { c: number }
  ).c;

  const toolUpgradeAffectedSpecs = collectToolUpgradeAffected(db, agentId);

  // P3-②（批次二反方遗留）：stale 比较锚点与 createdAt/timeoutAt 同为亚秒精度——锚点毫秒位抬到 .999999999Z，消字符串比较亚秒漏判
  const staleQueued = since
    ? 0 // --since 口径下 stale 宽限窗无意义，只统计全局态
    : (db.prepare(`SELECT COUNT(*) AS c FROM task_record WHERE status='queued' AND createdAt < ?`).get(new Date(Date.now() - 7 * 24 * 3600 * 1000 - 1).toISOString().replace(/\.\d{3}Z$/, '.999999999Z')) as { c: number }).c;
  const stalePaused = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT t.taskId) AS c FROM task_record t JOIN approval_request a ON a.taskId = t.taskId
         WHERE t.status = 'paused' AND a.decision = 'pending' AND a.timeoutAt < ?`,
      )
      .get(new Date(Date.now() + 1000).toISOString().replace(/\.\d{3}Z$/, '.999999999Z')) as { c: number }
  ).c;

  return {
    agentId,
    since,
    groups,
    promoteCriteria: criteria,
    sideColumns: {
      approvalTimeoutCount,
      toolUpgradeAffectedSpecs,
      stale: { queued: staleQueued, paused: stalePaused },
    },
    healthPanel: healthPanelRef,
  };
}

/** R-5：该 agent 全部版本快照中，Spec 声明等级 < Tool Registry 当前登记等级的引用清单 */
function collectToolUpgradeAffected(db: Database.Database, agentId: string): ToolUpgradeAffectedSpec[] {
  const order = ['L0', 'L1', 'L2', 'L3', 'L4'];
  const versions = db
    .prepare(`SELECT versionId, specSnapshot FROM agent_version WHERE agentId = ?`)
    .all(agentId) as { versionId: string; specSnapshot: string }[];
  const tools = new Map(
    (db.prepare('SELECT toolId, riskLevel FROM tool_registry').all() as { toolId: string; riskLevel: string }[]).map((t) => [t.toolId, t.riskLevel]),
  );
  const affected: ToolUpgradeAffectedSpec[] = [];
  for (const v of versions) {
    try {
      const spec = JSON.parse(v.specSnapshot) as { toolPolicy?: { tools?: { toolId: string; riskLevel: string }[] } };
      for (const t of spec.toolPolicy?.tools ?? []) {
        const current = tools.get(t.toolId);
        if (current && order.indexOf(current) > order.indexOf(t.riskLevel)) {
          affected.push({ versionId: v.versionId, toolId: t.toolId, declared: t.riskLevel, current });
        }
      }
    } catch {
      // 快照损坏不进单列（AgentVersion 不可变——实际不可达，防御）
    }
  }
  return affected;
}
