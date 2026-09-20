import type Database from 'better-sqlite3';
import { uuid } from '../hash.js';
import { nowNs } from './traceRecorder.js';
import { redactString, redactValue, type RedactionPolicy } from './redaction.js';
import {
  CONTRACT_RATE_SUBCLASSES,
  type AuditEventType,
  type FailureClass,
  type FailureSubClass,
  type RejectedKind,
} from '../types.js';

// A4 §2：FailureRecord 落库 + countedInContractRate 落库时按 §1 口径物化（防报表层口径漂移）
// A6 §4–§5：审计流（版本事件 + RejectedRequest），追加 only；P3-5：通用 payload JSON 列

export interface FailureRecordInput {
  taskId: string;
  agentId: string;
  agentVersionId: string;
  attemptNo: number; // 0 = 任务级
  failureClass: FailureClass;
  subClass: FailureSubClass;
  reasonCode?: string | null;
  message: string;
  /** A4 §2：JSON {expected, actual, path?}；BudgetExceeded 终局另承载 D-2 调用构成明细 */
  expectedVsActual: unknown;
  traceRef?: string | null;
}

export class FailureRecorder {
  constructor(
    private readonly db: Database.Database,
    /** 批次二（§4.2）：message/expectedVsActual 入库前过同一 redaction 实例（*Digest/*Hash 排除表零改写） */
    private readonly redaction: RedactionPolicy,
  ) {}

  record(input: FailureRecordInput): string {
    const recordId = uuid();
    this.db
      .prepare(
        `INSERT INTO failure_record
         (recordId, taskId, agentId, agentVersionId, attemptNo, failureClass, subClass, reasonCode,
          message, expectedVsActual, countedInContractRate, occurredAt, traceRef)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        recordId,
        input.taskId,
        input.agentId,
        input.agentVersionId,
        input.attemptNo,
        input.failureClass,
        input.subClass,
        input.reasonCode ?? null,
        redactString(input.message, this.redaction),
        JSON.stringify(redactValue(input.expectedVsActual, this.redaction)),
        CONTRACT_RATE_SUBCLASSES.has(input.subClass) ? 1 : 0,
        nowNs(),
        input.traceRef ?? null,
      );
    return recordId;
  }

  forTask(taskId: string) {
    return this.db.prepare('SELECT * FROM failure_record WHERE taskId = ?').all(taskId);
  }

  /** BudgetExceeded 终局附调用构成明细（D-2 附条件落地，A2 §7） */
  recordBudgetExceeded(
    base: { taskId: string; agentId: string; agentVersionId: string; traceRef?: string | null },
    budget: { maxModelCalls: number; maxTokens: number },
    consumed: { modelCalls: number; tokens: number; estimatedTokens: number },
    attemptBreakdown: { succeeded: number; failedBySubClass: Record<string, number> },
  ): string {
    return this.record({
      ...base,
      attemptNo: 0,
      failureClass: 'Runtime',
      subClass: 'BudgetExceeded',
      message: `预算超限：modelCalls ${consumed.modelCalls}/${budget.maxModelCalls}，tokens ${consumed.tokens}/${budget.maxTokens}`,
      expectedVsActual: { budget, consumed, attemptBreakdown },
    });
  }
}

export interface AuditContext {
  db: Database.Database;
}

/** 审计流写入（A6 §4 RejectedRequest + §5 版本事件） */
export class AuditRecorder {
  constructor(
    private readonly db: Database.Database,
    /** 批次二（§4.2）：rejectReason 入库前过同一 redaction 实例（JSON 结构级——解析后过管道，不做字符串级正则） */
    private readonly redaction: RedactionPolicy,
  ) {}

  versionEvent(
    eventType: AuditEventType,
    who: string,
    target: string,
    payload: Record<string, unknown>,
    agentVersionId?: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (eventId, eventType, kind, who, whenAt, target, inputHash, rejectReason, agentVersionId, payload)
         VALUES (?,?,NULL,?,?,?,NULL,NULL,?,?)`,
      )
      .run(uuid(), eventType, who, nowNs(), target, agentVersionId ?? null, JSON.stringify(payload));
  }

  rejectedRequest(input: {
    kind: RejectedKind;
    who: string;
    target: string;
    inputHash: string;
    rejectReason: string;
    agentVersionId?: string | null; // NULL = 指针解析失败（A6 §4 P2-2 显式接受，T2 兜底单列计数）
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (eventId, eventType, kind, who, whenAt, target, inputHash, rejectReason, agentVersionId, payload)
         VALUES (?,'rejected_request',?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        uuid(),
        input.kind,
        input.who,
        nowNs(),
        input.target,
        input.inputHash,
        this.redactReason(input.rejectReason),
        input.agentVersionId ?? null,
      );
  }

  /** rejectReason 恒为 JSON（issues 数组）：解析后过管道再序列化；解析失败退化为字符串级管道 */
  private redactReason(reason: string): string {
    try {
      return JSON.stringify(redactValue(JSON.parse(reason), this.redaction));
    } catch {
      return redactString(reason, this.redaction);
    }
  }
}
