import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { sha256Hex } from '../hash.js';
import type { TraceRecorder } from './traceRecorder.js';

// WP-5B 批次一（第五阶段设计 §4.1，D-35）：Evidence Store 只读派生存取层。
// 统一证据引用格式：封闭枚举 5 种 <kind>:<id>（task / trace_event / failure / memory / eval）；
// eval 为预留位（D-36 成文载体）——格式合法但执行层返回 not_implemented 结构化错误，不静默、不猜测。
//
// 纯只读派生（零表、零迁移、零新事件、零写入）：全操作不产生任何 INSERT/UPDATE/DELETE；
// 证据回读 = 读已脱敏落盘体，payload 逐字节一致返回、不二次脱敏（§9-1 冻结：
// 二次处理破坏 digest 对账且暗示存在未脱敏面；落盘即脱敏是写侧不可削依赖，读侧零加工）。
//
// 状态口径（成文）：task = task_record.status；trace_event = eventType（事件自身形态）；
// failure = countedInContractRate 落盘标志映射 counted-in-contract-rate / excluded-from-contract-rate；
// memory = memory_record.status（可信度状态机）。
// digest 口径（成文）：sha256(payload)（按存储原文计算——读侧对账锚点，统一四 kind）；
// memory 行自身的 contentDigest 是脱敏前原文去重键（写侧口径），与本读侧 digest 用途不同、不混用。
// failure payload 口径（成文）：message + '\n' + expectedVsActual（两存储文本列按序拼接）。

/** 统一引用格式封闭枚举（D-35；eval = 预留位，D-36） */
export const EVIDENCE_REF_KINDS = ['task', 'trace_event', 'failure', 'memory', 'eval'] as const;
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];

export interface ParsedEvidenceRef {
  kind: EvidenceRefKind;
  id: string;
}

/** 引用格式非法（无冒号 / 未知 kind / 空 id / 多余冒号）——结构化 code=invalid_ref */
export class EvidenceRefError extends Error {
  constructor(message: string, public readonly code: 'invalid_ref' = 'invalid_ref', public readonly ref: string = '') {
    super(message);
    this.name = 'EvidenceRefError';
  }
}

/** 解析 `<kind>:<id>`（恰一个冒号；kind 必须在封闭枚举内） */
export function parseEvidenceRef(ref: string): ParsedEvidenceRef {
  const parts = ref.split(':');
  if (parts.length !== 2) {
    throw new EvidenceRefError(`证据引用格式非法（须 <kind>:<id>，恰一个冒号）：${ref}`, 'invalid_ref', ref);
  }
  const [kind, id] = parts as [string, string];
  if (!(EVIDENCE_REF_KINDS as readonly string[]).includes(kind)) {
    throw new EvidenceRefError(`证据引用 kind 未知（封闭枚举 ${EVIDENCE_REF_KINDS.join('/')}）：${ref}`, 'invalid_ref', ref);
  }
  if (id.length === 0) {
    throw new EvidenceRefError(`证据引用 id 为空：${ref}`, 'invalid_ref', ref);
  }
  return { kind: kind as EvidenceRefKind, id };
}

/** 信封四字段（traceRecorder.EnvelopeBase 同款口径：任何证据面都能回答「谁的任务、哪个版本、哪份 Spec」） */
export interface EvidenceEnvelope {
  taskId: string;
  agentId: string;
  agentVersionId: string;
  specContentHash: string;
}

/** 单条解析成功形态（字段集冻结：ref/kind/envelope/digest/status/occurredAt/payload） */
export interface EvidenceShow {
  ok: true;
  ref: string;
  kind: Exclude<EvidenceRefKind, 'eval'>;
  envelope: EvidenceEnvelope;
  /** sha256(payload)——按存储原文计算的读侧对账摘要 */
  digest: string;
  status: string;
  occurredAt: string;
  /** 已脱敏落盘体原文（逐字节一致返回，不二次脱敏——§9-1） */
  payload: string;
}

export type EvidenceShowResult =
  | EvidenceShow
  | { ok: false; code: 'not_found'; ref: string; kind: EvidenceRefKind; message: string }
  | { ok: false; code: 'not_implemented'; ref: string; kind: 'eval'; message: string };

/** 任务全链证据链（evidence task <taskId>） */
export interface TaskEvidenceChain {
  ok: true;
  taskId: string;
  envelope: EvidenceEnvelope;
  status: string;
  parentTaskId: string | null;
  delegationDepth: number;
  /** trace 双存储对账：trace_index 行数 = JSONL 事件数（分叉时 consistent=false，两侧计数如实返回） */
  trace: {
    traceIndexRows: number;
    jsonlEvents: number;
    consistent: boolean;
    eventIds: string[];
  };
  failures: { recordId: string; subClass: string; occurredAt: string }[];
  memories: { memoryId: string; status: string; createdAt: string }[];
  /** 委托树（单查询沿树回放）：ancestors = 沿 parentTaskId 上溯（近→远）；descendants = 子树层序展开（BFS） */
  delegationChain: {
    ancestors: { taskId: string; agentId: string; delegationDepth: number }[];
    descendants: { taskId: string; agentId: string; delegationDepth: number; status: string }[];
  };
}

export type TaskEvidenceResult =
  | TaskEvidenceChain
  | { ok: false; code: 'not_found'; ref: string; kind: 'task'; message: string };

interface TaskRow {
  taskId: string; agentId: string; agentVersionId: string; specContentHash: string;
  status: string; createdAt: string; input: string; parentTaskId: string | null; delegationDepth: number;
}

interface TreeRow {
  taskId: string; agentId: string; parentTaskId: string | null; delegationDepth: number; status: string;
}

export interface EvidenceStoreDeps {
  db: Database.Database;
  trace: TraceRecorder;
}

export class EvidenceStore {
  constructor(private readonly deps: EvidenceStoreDeps) {}

  /** 单条解析：任一合法 ref → 信封四字段 + digest + 状态 + 落盘体原文（A-23） */
  show(ref: string): EvidenceShowResult {
    const parsed = parseEvidenceRef(ref);
    switch (parsed.kind) {
      case 'eval':
        return {
          ok: false, code: 'not_implemented', ref, kind: 'eval',
          message: 'eval 证据源为预留位（D-36：evaluationPolicy schema 接受但零执行，本期不新增评估落盘面）——不静默、不猜测',
        };
      case 'task':
        return this.showTask(ref, parsed.id);
      case 'trace_event':
        return this.showTraceEvent(ref, parsed.id);
      case 'failure':
        return this.showFailure(ref, parsed.id);
      case 'memory':
        return this.showMemory(ref, parsed.id);
    }
  }

  /** 任务全链证据链：trace 对账 + failure/memory 关联 + 委托父子链（A-24） */
  taskEvidence(taskId: string): TaskEvidenceResult {
    const row = this.deps.db
      .prepare('SELECT taskId, agentId, agentVersionId, specContentHash, status, createdAt, input, parentTaskId, delegationDepth FROM task_record WHERE taskId = ?')
      .get(taskId) as TaskRow | undefined;
    if (!row) {
      return { ok: false, code: 'not_found', ref: `task:${taskId}`, kind: 'task', message: `任务不存在：${taskId}` };
    }
    const indexRows = this.deps.db
      .prepare('SELECT eventId FROM trace_index WHERE taskId = ? ORDER BY timestamp')
      .all(taskId) as { eventId: string }[];
    const events = this.readJsonl(taskId);
    const failures = this.deps.db
      .prepare('SELECT recordId, subClass, occurredAt FROM failure_record WHERE taskId = ? ORDER BY occurredAt')
      .all(taskId) as { recordId: string; subClass: string; occurredAt: string }[];
    const memories = this.deps.db
      .prepare('SELECT memoryId, status, createdAt FROM memory_record WHERE taskId = ? ORDER BY createdAt')
      .all(taskId) as { memoryId: string; status: string; createdAt: string }[];
    return {
      ok: true,
      taskId,
      envelope: { taskId: row.taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash },
      status: row.status,
      parentTaskId: row.parentTaskId,
      delegationDepth: row.delegationDepth,
      trace: {
        traceIndexRows: indexRows.length,
        jsonlEvents: events.length,
        consistent: indexRows.length === events.length,
        eventIds: events.map((e) => e.eventId),
      },
      failures,
      memories,
      delegationChain: { ancestors: this.ancestorsOf(row), descendants: this.descendantsOf(taskId) },
    };
  }

  private showTask(ref: string, taskId: string): EvidenceShowResult {
    const row = this.deps.db
      .prepare('SELECT taskId, agentId, agentVersionId, specContentHash, status, createdAt, input FROM task_record WHERE taskId = ?')
      .get(taskId) as
      | { taskId: string; agentId: string; agentVersionId: string; specContentHash: string; status: string; createdAt: string; input: string }
      | undefined;
    if (!row) return { ok: false, code: 'not_found', ref, kind: 'task', message: `任务不存在：${taskId}` };
    return {
      ok: true, ref, kind: 'task',
      envelope: { taskId: row.taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash },
      digest: sha256Hex(row.input),
      status: row.status,
      occurredAt: row.createdAt,
      payload: row.input,
    };
  }

  private showTraceEvent(ref: string, eventId: string): EvidenceShowResult {
    const indexed = this.deps.db
      .prepare('SELECT taskId FROM trace_index WHERE eventId = ?')
      .get(eventId) as { taskId: string } | undefined;
    if (!indexed) return { ok: false, code: 'not_found', ref, kind: 'trace_event', message: `Trace 事件不存在（trace_index 零命中）：${eventId}` };
    const hit = this.readRawLine(indexed.taskId, eventId);
    if (!hit) return { ok: false, code: 'not_found', ref, kind: 'trace_event', message: `Trace 事件不存在（JSONL 零命中，索引与文件分叉）：${eventId}` };
    const event = JSON.parse(hit.line) as {
      taskId: string; agentId: string; agentVersionId: string; specContentHash: string; eventType: string; timestamp: string;
    };
    return {
      ok: true, ref, kind: 'trace_event',
      envelope: { taskId: event.taskId, agentId: event.agentId, agentVersionId: event.agentVersionId, specContentHash: event.specContentHash },
      digest: sha256Hex(hit.line),
      status: event.eventType,
      occurredAt: event.timestamp,
      payload: hit.line,
    };
  }

  private showFailure(ref: string, recordId: string): EvidenceShowResult {
    const row = this.deps.db
      .prepare(
        `SELECT f.taskId, f.agentId, f.agentVersionId, t.specContentHash, f.countedInContractRate, f.occurredAt, f.message, f.expectedVsActual
         FROM failure_record f LEFT JOIN task_record t ON f.taskId = t.taskId
         WHERE f.recordId = ?`,
      )
      .get(recordId) as
      | { taskId: string; agentId: string; agentVersionId: string; specContentHash: string | null; countedInContractRate: number; occurredAt: string; message: string; expectedVsActual: string }
      | undefined;
    if (!row) return { ok: false, code: 'not_found', ref, kind: 'failure', message: `失败记录不存在：${recordId}` };
    const payload = `${row.message}\n${row.expectedVsActual}`;
    return {
      ok: true, ref, kind: 'failure',
      envelope: { taskId: row.taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash ?? '' },
      digest: sha256Hex(payload),
      status: row.countedInContractRate === 1 ? 'counted-in-contract-rate' : 'excluded-from-contract-rate',
      occurredAt: row.occurredAt,
      payload,
    };
  }

  private showMemory(ref: string, memoryId: string): EvidenceShowResult {
    const row = this.deps.db
      .prepare(
        `SELECT m.taskId, m.agentId, m.agentVersionId, t.specContentHash, m.status, m.createdAt, m.content
         FROM memory_record m LEFT JOIN task_record t ON m.taskId = t.taskId
         WHERE m.memoryId = ?`,
      )
      .get(memoryId) as
      | { taskId: string; agentId: string; agentVersionId: string; specContentHash: string | null; status: string; createdAt: string; content: string }
      | undefined;
    if (!row) return { ok: false, code: 'not_found', ref, kind: 'memory', message: `记忆行不存在：${memoryId}` };
    return {
      ok: true, ref, kind: 'memory',
      envelope: { taskId: row.taskId, agentId: row.agentId, agentVersionId: row.agentVersionId, specContentHash: row.specContentHash ?? '' },
      digest: sha256Hex(row.content),
      status: row.status,
      occurredAt: row.createdAt,
      payload: row.content,
    };
  }

  /** 沿 parentTaskId 上溯（近→远；环形防御：步数上限 = 表行数 + 1） */
  private ancestorsOf(root: TaskRow): { taskId: string; agentId: string; delegationDepth: number }[] {
    const stmt = this.deps.db.prepare('SELECT taskId, agentId, parentTaskId, delegationDepth FROM task_record WHERE taskId = ?');
    const ancestors: { taskId: string; agentId: string; delegationDepth: number }[] = [];
    const seen = new Set<string>([root.taskId]);
    let cursor = root.parentTaskId;
    while (cursor !== null) {
      if (seen.has(cursor)) break; // 环形防御（正常数据不出现；只读层不猜测、不发散）
      seen.add(cursor);
      const row = stmt.get(cursor) as { taskId: string; agentId: string; delegationDepth: number; parentTaskId: string | null } | undefined;
      if (!row) break;
      ancestors.push({ taskId: row.taskId, agentId: row.agentId, delegationDepth: row.delegationDepth });
      cursor = row.parentTaskId;
    }
    return ancestors;
  }

  /** 子树层序展开（BFS：逐层按 parentTaskId 取层，单查询沿树） */
  private descendantsOf(taskId: string): { taskId: string; agentId: string; delegationDepth: number; status: string }[] {
    const stmt = this.deps.db.prepare('SELECT taskId, agentId, delegationDepth, status FROM task_record WHERE parentTaskId = ? ORDER BY createdAt');
    const out: { taskId: string; agentId: string; delegationDepth: number; status: string }[] = [];
    const queue: string[] = [taskId];
    const seen = new Set<string>([taskId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = stmt.all(current) as { taskId: string; agentId: string; delegationDepth: number; status: string }[];
      for (const child of children) {
        if (seen.has(child.taskId)) continue; // 环形防御
        seen.add(child.taskId);
        out.push(child);
        queue.push(child.taskId);
      }
    }
    return out;
  }

  /** 定向读取任务的 JSONL 原始行（不整库扫描——trace_index 定位 + 单文件读取） */
  private readRawLine(taskId: string, eventId: string): { line: string } | null {
    const file = this.deps.trace.traceFile(taskId);
    if (!existsSync(file)) return null;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      if ((JSON.parse(line) as { eventId: string }).eventId === eventId) return { line };
    }
    return null;
  }

  private readJsonl(taskId: string): { eventId: string }[] {
    const file = this.deps.trace.traceFile(taskId);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { eventId: string });
  }
}
