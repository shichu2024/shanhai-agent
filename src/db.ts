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
    updatedAt          TEXT NOT NULL,
    canaryVersionId    TEXT,
    canaryWeight       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_version (
    versionId          TEXT PRIMARY KEY,
    agentId            TEXT NOT NULL,
    version            INTEGER NOT NULL,
    specSnapshot       TEXT NOT NULL,
    contentHash        TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('draft','reviewed','released','deprecated')),
    registeredAt       TEXT NOT NULL,
    registeredBy       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_version_agent ON agent_version(agentId, registeredAt);
  `);

  // v1.1 迁移（A5 D-10）：存量 agent_version 的 CHECK 不含 'reviewed' → 原地重建（单事务 + 临时表兜底清理，无数据回填）
  const tableSql = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_version'`).get() as { sql: string } | undefined
  )?.sql ?? '';
  if (tableSql !== '' && !tableSql.includes("'reviewed'")) {
    const rebuild = db.transaction(() => {
      db.exec(`
      DROP TABLE IF EXISTS agent_version_v11; -- 上次迁移中途崩溃的残留兜底
      CREATE TABLE agent_version_v11 (
        versionId          TEXT PRIMARY KEY,
        agentId            TEXT NOT NULL,
        version            INTEGER NOT NULL,
        specSnapshot       TEXT NOT NULL,
        contentHash        TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('draft','reviewed','released','deprecated')),
        registeredAt       TEXT NOT NULL,
        registeredBy       TEXT NOT NULL
      );
      INSERT INTO agent_version_v11 SELECT * FROM agent_version;
      DROP TABLE agent_version;
      ALTER TABLE agent_version_v11 RENAME TO agent_version;
      CREATE INDEX IF NOT EXISTS idx_agent_version_agent ON agent_version(agentId, registeredAt);
      `);
    });
    rebuild();
  }

  db.exec(`
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
  `);

  // v1.1 增列（A3 §4 + §2）：全部 ADD COLUMN 原地支持，无数据回填——新列默认值即第一阶段语义
  addColumn(db, 'task_record', 'abortRequested', `INTEGER NOT NULL DEFAULT 0`); // 跨进程 abort 持久化标志
  addColumn(db, 'task_record', 'pausedDurationMs', `INTEGER NOT NULL DEFAULT 0`); // Paused 累计（任务级超时挂起期间暂停计时）
  addColumn(db, 'task_record', 'cancelReason', `TEXT`); // v1.1 封闭枚举（user/approval_denied/approval_timeout/abort/superseded）
  addColumn(db, 'task_record', 'assignmentSource', `TEXT`); // v1.1（A5 §4a）：stable/canary/explicit 灰度分派留痕
  addColumn(db, 'agent', 'canaryVersionId', `TEXT`); // v1.1（A5 §3a，D-12）：灰度指针（只能指向 Released 且 ≠ current）
  addColumn(db, 'agent', 'canaryWeight', `INTEGER NOT NULL DEFAULT 0`); // v1.1：0-100；0 = 无灰度（缺省 = 第一阶段行为）

  db.exec(`
  -- A3 §5 v1.1：ApprovalRequest（D-4 8 字段 + timeoutAt/callRef；decision 含 superseded）
  CREATE TABLE IF NOT EXISTS approval_request (
    requestId          TEXT PRIMARY KEY,
    taskId             TEXT NOT NULL,
    agentVersionId     TEXT NOT NULL,
    toolId             TEXT NOT NULL,
    riskLevel          TEXT NOT NULL,
    requestedAt        TEXT NOT NULL,
    decision           TEXT NOT NULL CHECK (decision IN ('pending','approved','denied','superseded')),
    decidedAt          TEXT,
    timeoutAt          TEXT NOT NULL,
    callRef            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_approval_version ON approval_request(agentVersionId); -- T2′ 表级索引
  CREATE INDEX IF NOT EXISTS idx_approval_task ON approval_request(taskId);

  -- 设计 §4.4-2 v1.1（D-13）：MemoryRecord——作用域 = agentId 级（跨版本共享）；
  -- 内容列不可变（仅状态/计数列可更新）；contentDigest 去重键（原文口径，脱敏管道前计算）
  CREATE TABLE IF NOT EXISTS memory_record (
    memoryId                          TEXT PRIMARY KEY,
    agentId                           TEXT NOT NULL,
    agentVersionId                    TEXT NOT NULL, -- 写入时绑定版本（仅溯源锚点，不限定注入作用域）
    taskId                            TEXT NOT NULL, -- 证据回链（必填——无证据不记忆）
    kind                              TEXT NOT NULL CHECK (kind IN ('episodic')),
    content                           TEXT NOT NULL, -- 已过 redactionPolicy 管道（前置不可削依赖）
    contentDigest                     TEXT NOT NULL, -- SHA-256 去重键（脱敏前按原文计算——跨任务对账/去重稳定）
    evidenceCount                     INTEGER NOT NULL DEFAULT 0,
    evidenceCountAtLastTransition     INTEGER NOT NULL DEFAULT 0, -- R-2：状态迁移基线快照（与状态变更同事务）
    contradictionCount                INTEGER NOT NULL DEFAULT 0,
    status                            TEXT NOT NULL CHECK (status IN ('candidate','active','degraded','retired')),
    createdAt                         TEXT NOT NULL,
    lastUpdatedAt                     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_record(agentId, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dedup ON memory_record(agentId, contentDigest);

  -- 设计 §4.5 v1.1（D-14）：EvolutionCandidate——人工确认制，系统永不自动注册/发布
  CREATE TABLE IF NOT EXISTS evolution_candidate (
    candidateId         TEXT PRIMARY KEY,
    agentId             TEXT NOT NULL, -- 聚合键 = agentId（跨版本——失败模式是 Agent 级资产）
    trigger             TEXT NOT NULL CHECK (trigger IN ('repeated_failure','capability_degradation')),
    evidenceRefs        TEXT NOT NULL, -- JSON [{taskId, agentVersionId, subClass, occurredAt}]
    status              TEXT NOT NULL CHECK (status IN ('open','confirmed','dismissed')),
    proposedChange      TEXT,
    createdAt           TEXT NOT NULL,
    decidedAt           TEXT,
    decidedBy           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_evolution_agent ON evolution_candidate(agentId, status);

  -- A3 §5a v1.1：PauseSnapshot（审批挂起点专用最小检查点；非审计对象，离开 Paused 即删）
  CREATE TABLE IF NOT EXISTS pause_snapshot (
    taskId             TEXT PRIMARY KEY,
    contextJson        TEXT NOT NULL,
    callCounters       TEXT NOT NULL,
    nextCallRef        TEXT NOT NULL,
    savedAt            TEXT NOT NULL
  );

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

  // 批次三（§4.4-3 / §4.5-4，D-22/D-25）：evolution_candidate 增列——ALTER TABLE 原地支持，零数据回填
  addColumn(db, 'evolution_candidate', 'derivedVersionIds', `TEXT NOT NULL DEFAULT '[]'`); // 候选↔版本关联（--from-candidate 显式回填）
  addColumn(db, 'evolution_candidate', 'dismissedAt', `TEXT`); // dismiss 冷却窗起算点（NULL = 未驳回）

  // 第四阶段批次一（§4.1）：tool_registry 元数据增列 ×3——ADD COLUMN 原地支持，零数据回填
  addColumn(db, 'tool_registry', 'source', `TEXT`); // builtin / mcp:<serverName>（来源可追溯）
  addColumn(db, 'tool_registry', 'registeredBy', `TEXT`); // 登记人（external 评级断言的留痕落点——P3-3 辅助留痕，非强证据）
  addColumn(db, 'tool_registry', 'description', `TEXT`); // 人类可读描述（discovery 时从 MCP server 取得）
}

/** 幂等 ADD COLUMN（存量库原地升级，零回填） */
function addColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }
}
