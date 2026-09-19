import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { uuid } from '../hash.js';
import type { CallKind, TraceEventType } from '../types.js';
import type Database from 'better-sqlite3';
import { defaultRedactionPolicy, redactEventPayload, type RedactionPolicy } from './redaction.js';

// A6 §2–§3：Trace 事件公共信封 + per-task JSONL；D-6 双写次序 = 先文件后索引。
// callNo 按 callKind 各自独立编号（A6 §2 / R2-1）；任务级事件 callNo=0 / callKind=null / attemptNo=0。
// A6 §8 v1.1（D-11）：写入时脱敏——原文不落盘；digest 由调用方在脱敏前按原文计算（跨任务对账稳定）；
// 排除表（信封/bindingSnapshot/*Digest）零改写；管道不可削（空规则集仍过管道，规则集内容可裁）。

export interface TraceEnvelope {
  eventId: string;
  timestamp: string;
  traceId: string;
  taskId: string;
  agentId: string;
  agentVersionId: string;
  specContentHash: string;
  eventType: TraceEventType;
  callNo: number;
  callKind: CallKind | null;
  attemptNo: number;
  [key: string]: unknown; // 载荷字段（A6 §3 各事件差异列）
}

export function nowNs(): string {
  const d = new Date();
  const frac = d.getMilliseconds().toString().padStart(3, '0') + process.hrtime.bigint().toString().padEnd(6, '0').slice(0, 6);
  return d.toISOString().replace(/\.\d{3}Z$/, `.${frac}Z`);
}

interface EnvelopeBase {
  taskId: string;
  agentId: string;
  agentVersionId: string;
  specContentHash: string;
}

export class TraceRecorder {
  private readonly db: Database.Database;
  private readonly tracesDir: string;
  private readonly redaction: RedactionPolicy;

  constructor(db: Database.Database, tracesDir: string, redaction: RedactionPolicy = defaultRedactionPolicy()) {
    this.db = db;
    this.tracesDir = tracesDir;
    this.redaction = redaction;
  }

  traceFile(taskId: string): string {
    return path.join(this.tracesDir, `${taskId}.jsonl`);
  }

  /** 任务级事件（callNo=0 / callKind=null / attemptNo=0） */
  recordTaskEvent(base: EnvelopeBase, eventType: TraceEventType, payload: Record<string, unknown>): TraceEnvelope {
    return this.append(base, eventType, 0, null, 0, payload);
  }

  /** attempt 级调用事件（调用键 = callNo × callKind，A2 §2.1） */
  recordCallEvent(
    base: EnvelopeBase,
    eventType: TraceEventType,
    callKind: CallKind,
    callNo: number,
    attemptNo: number,
    payload: Record<string, unknown>,
  ): TraceEnvelope {
    return this.append(base, eventType, callNo, callKind, attemptNo, payload);
  }

  private append(
    base: EnvelopeBase,
    eventType: TraceEventType,
    callNo: number,
    callKind: CallKind | null,
    attemptNo: number,
    payload: Record<string, unknown>,
  ): TraceEnvelope {
    // A6 §8：写入时脱敏（仅自由文本载荷；排除表键零改写）；留痕摘要不含原文。
    // digest 类字段（outputDigest/argsDigest/resultDigest…）由调用方按原文预先计算——排除表保证不被改写。
    const { payload: redactedPayload, redacted } = redactEventPayload(payload, this.redaction);
    const event: TraceEnvelope = {
      eventId: uuid(),
      timestamp: nowNs(),
      traceId: base.taskId,
      taskId: base.taskId,
      agentId: base.agentId,
      agentVersionId: base.agentVersionId,
      specContentHash: base.specContentHash,
      eventType,
      callNo,
      callKind,
      attemptNo,
      ...redactedPayload,
      ...(redacted.length > 0 ? { redacted } : {}),
    };
    // D-6：先 JSONL（追加 + flush）成功，后 trace_index
    appendFileSync(this.traceFile(base.taskId), JSON.stringify(event) + '\n', 'utf8');
    this.db
      .prepare(
        'INSERT INTO trace_index (eventId, taskId, agentVersionId, eventType, timestamp) VALUES (?,?,?,?,?)',
      )
      .run(event.eventId, event.taskId, event.agentVersionId, event.eventType, event.timestamp);
    return event;
  }

  readEvents(taskId: string): TraceEnvelope[] {
    const file = this.traceFile(taskId);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TraceEnvelope);
  }
}
