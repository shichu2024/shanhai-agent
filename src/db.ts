import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// SQLite 结构化存储（定稿 §4.2）：WAL 单写者；AgentVersion 不可变（触发器双保险，A1 §5）
export interface DbHandles {
  db: Database.Database;
  dataDir: string;
  tracesDir: string;
}

export function openDatabase(dataDir: string): DbHandles {
  mkdirSync(dataDir, { recursive: true });
  const tracesDir = path.join(dataDir, 'traces');
  mkdirSync(tracesDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'shanhai.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // 「先持久化后继续」的崩溃一致性（A3 §8-2）
  migrate(db);
  return { db, dataDir, tracesDir };
}

function migrate(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS agent (
    agentId            TEXT PRIMARY KEY,
    currentVersionId   TEXT,
    updatedAt          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_version (
    versionId          TEXT PRIMARY KEY,
    agentId            TEXT NOT NULL,
    version            INTEGER NOT NULL,
    specSnapshot       TEXT NOT NULL,
    contentHash        TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('draft','released','deprecated')),
    registeredAt       TEXT NOT NULL,
    registeredBy       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_version_agent ON agent_version(agentId, registeredAt);

  -- A1 §5 不可变双保险：除 status（A5 状态机唯一合法写入口）外拒绝 UPDATE；禁止 DELETE
  CREATE TRIGGER IF NOT EXISTS trg_agent_version_no_update
  BEFORE UPDATE OF versionId, agentId, version, specSnapshot, contentHash, registeredAt, registeredBy
  ON agent_version BEGIN
    SELECT RAISE(ABORT, 'AgentVersion is immutable (A1 §5)');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_agent_version_no_delete
  BEFORE DELETE ON agent_version BEGIN
    SELECT RAISE(ABORT, 'AgentVersion is immutable (A1 §5)');
  END;

  CREATE TABLE IF NOT EXISTS tool_registry (
    toolId                   TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    kind                     TEXT NOT NULL CHECK (kind IN ('builtin','external')),
    riskLevel                TEXT NOT NULL CHECK (riskLevel IN ('L0','L1','L2','L3','L4')),
    implVersion              TEXT NOT NULL,
    paramSchema              TEXT NOT NULL,
    controlledFieldsSchema   TEXT,
    status                   TEXT NOT NULL CHECK (status IN ('active','retired')),
    registeredAt             TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_record (
    taskId                  TEXT PRIMARY KEY,
    agentId                 TEXT NOT NULL,
    agentVersionId          TEXT NOT NULL,
    specContentHash         TEXT NOT NULL,
    input                   TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('created','queued','running','paused','succeeded','failed','cancelled')),
    attemptCount            INTEGER NOT NULL DEFAULT 0,
    modelCallCount          INTEGER NOT NULL DEFAULT 0,
    tokensUsed              INTEGER NOT NULL DEFAULT 0,
    consecutiveDenialCount  INTEGER NOT NULL DEFAULT 0,
    createdAt               TEXT NOT NULL,
    startedAt               TEXT,
    endedAt                 TEXT,
    traceFile               TEXT NOT NULL,
    terminalFailureClass    TEXT,
    evaluationId            TEXT,
    evolutionCandidateId    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_status ON task_record(status);
  CREATE INDEX IF NOT EXISTS idx_task_version ON task_record(agentVersionId);

  CREATE TABLE IF NOT EXISTS failure_record (
    recordId                TEXT PRIMARY KEY,
    taskId                  TEXT NOT NULL,
    agentId                 TEXT NOT NULL,
    agentVersionId          TEXT NOT NULL,
    attemptNo               INTEGER NOT NULL,
    failureClass            TEXT NOT NULL,
    subClass                TEXT NOT NULL,
    reasonCode              TEXT,
    message                 TEXT NOT NULL,
    expectedVsActual        TEXT NOT NULL,
    countedInContractRate   INTEGER NOT NULL CHECK (countedInContractRate IN (0,1)),
    occurredAt              TEXT NOT NULL,
    traceRef                TEXT,
    evaluationId            TEXT,
    evolutionCandidateId    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_failure_task ON failure_record(taskId);
  CREATE INDEX IF NOT EXISTS idx_failure_version ON failure_record(agentVersionId);

  -- 审计流（A6 §4–§5）：追加 only；P3-5 终审裁决：通用 payload JSON 列承载差异化载荷
  CREATE TABLE IF NOT EXISTS audit_events (
    eventId          TEXT PRIMARY KEY,
    eventType        TEXT NOT NULL,
    kind             TEXT,
    who              TEXT NOT NULL,
    whenAt           TEXT NOT NULL,
    target           TEXT,
    inputHash        TEXT,
    rejectReason     TEXT,
    agentVersionId   TEXT,
    payload          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_version ON audit_events(agentVersionId, kind);

  -- A6 §6 支撑索引：JSONL 主存储 + SQLite 索引（T1/T2 库内单查询）
  CREATE TABLE IF NOT EXISTS trace_index (
    eventId          TEXT PRIMARY KEY,
    taskId           TEXT NOT NULL,
    agentVersionId   TEXT NOT NULL,
    eventType        TEXT NOT NULL,
    timestamp        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trace_task ON trace_index(taskId);
  CREATE INDEX IF NOT EXISTS idx_trace_query ON trace_index(agentVersionId, eventType);
  `);
}
