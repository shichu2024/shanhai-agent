import path from 'node:path';
import { openDatabase } from './db.js';
import { TraceRecorder } from './modules/traceRecorder.js';
import { FailureRecorder, AuditRecorder } from './modules/recorders.js';
import { Registry } from './modules/registry.js';
import { StateManager } from './modules/stateManager.js';
import { ModelGateway } from './modules/modelGateway.js';
import { TaskManager } from './modules/taskManager.js';
import { ApprovalManager } from './modules/approval.js';
import { MemoryManager } from './modules/memory.js';
import { EvolutionManager } from './modules/evolution.js';
import { BUILTIN_TOOL_DEFS, BUILTIN_TOOL_VERSION, createBuiltinImpls } from './tools/builtin.js';
import type { ModelProvider } from './providers/types.js';
import { loadRuntimeConfig, buildProviderFromConfig, modelWhitelistOf } from './config.js';
import { defaultRedactionPolicy, type RedactionPolicy } from './modules/redaction.js';

// 模块化单体组合根（WP-B 八模块：Registry / SpecValidator / ToolExecutor / TaskManager /
// ModelGateway / StateManager / TraceRecorder / FailureRecorder）
// SpecValidator 以纯函数形态被 Registry 与 TaskManager 消费（A1 §9 映射）。

export interface RuntimeOptions {
  dataDir: string;
  repoRoot: string;
  provider: ModelProvider;
  whitelist: ReadonlySet<string>;
  /** v1.1（A6 §8，D-11）：运行时配置（平台层）；缺省 = 默认规则集（管道不可削） */
  redaction?: RedactionPolicy;
  /** v1.1（A5 §4a）：灰度分派随机源（测试注入确定性；缺省 = 随机） */
  dispatchRoll?: () => number;
}

export class Runtime {
  readonly tracesDir: string;
  readonly trace: TraceRecorder;
  readonly failures: FailureRecorder;
  readonly audit: AuditRecorder;
  readonly registry: Registry;
  readonly state: StateManager;
  readonly gateway: ModelGateway;
  readonly tasks: TaskManager;
  readonly approvals: ApprovalManager;
  readonly memories: MemoryManager;
  readonly evolutions: EvolutionManager;
  readonly toolImpls: Map<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;

  constructor(opts: RuntimeOptions) {
    const handles = openDatabase(opts.dataDir);
    this.tracesDir = handles.tracesDir;
    const redaction = opts.redaction ?? defaultRedactionPolicy();
    this.trace = new TraceRecorder(handles.db, handles.tracesDir, redaction);
    this.memories = new MemoryManager({ db: handles.db, trace: this.trace, redaction }); // 同一 redactionPolicy（前置不可削依赖）
    this.evolutions = new EvolutionManager({ db: handles.db });
    this.failures = new FailureRecorder(handles.db);
    this.audit = new AuditRecorder(handles.db);
    this.registry = new Registry(handles.db);
    this.state = new StateManager(handles.db, this.trace, this.failures);
    this.gateway = new ModelGateway(opts.provider, opts.whitelist);
    this.toolImpls = createBuiltinImpls(opts.repoRoot);
    this.approvals = new ApprovalManager({
      db: handles.db,
      trace: this.trace,
      failures: this.failures,
      state: this.state,
    });
    this.tasks = new TaskManager({
      db: handles.db,
      registry: this.registry,
      trace: this.trace,
      failures: this.failures,
      state: this.state,
      gateway: this.gateway,
      toolImpls: this.toolImpls,
      audit: this.audit,
      approvals: this.approvals,
      memories: this.memories,
      dispatchRoll: opts.dispatchRoll,
    });
    Object.defineProperty(this, 'db', { value: handles.db });
  }

  /** 生产构造：配置驱动（T3：无配置即拒绝启动） */
  static fromConfig(dataDir: string, repoRoot: string): Runtime {
    const config = loadRuntimeConfig();
    return new Runtime({
      dataDir,
      repoRoot,
      provider: buildProviderFromConfig(config),
      whitelist: modelWhitelistOf(config),
      redaction: config.redaction,
    });
  }

  /** 测试构造：注入 Provider 与白名单（redaction/dispatchRoll 可选注入；redaction 缺省 = 默认规则集——即脱敏开启库） */
  static withProvider(
    provider: ModelProvider,
    whitelist: Iterable<string>,
    dataDir: string,
    repoRoot: string,
    redaction?: RedactionPolicy,
    dispatchRoll?: () => number,
  ): Runtime {
    return new Runtime({ dataDir, repoRoot, provider, whitelist: new Set(whitelist), redaction, dispatchRoll });
  }

  /** 启动：内置工具登记 + 崩溃恢复（索引对账先于崩溃标记，A6 §6.1 次序约束） */
  startup(who = 'runtime'): ReturnType<StateManager['recover']> {
    for (const def of BUILTIN_TOOL_DEFS) {
      const existing = this.registry.getTool(def.toolId);
      if (!existing) {
        this.registry.registerTool(
          {
            toolId: def.toolId, name: def.name, kind: 'builtin', riskLevel: def.riskLevel,
            implVersion: def.implVersion, paramSchema: def.paramSchema,
            controlledFieldsSchema: def.controlledFieldsSchema, status: 'active',
          },
          who,
        );
      } else if (existing.implVersion !== BUILTIN_TOOL_VERSION) {
        this.registry.registerTool(
          {
            toolId: def.toolId, name: def.name, kind: 'builtin', riskLevel: def.riskLevel,
            implVersion: BUILTIN_TOOL_VERSION, paramSchema: def.paramSchema,
            controlledFieldsSchema: def.controlledFieldsSchema, status: 'active',
          },
          who,
        );
      }
    }
    return this.state.recover();
  }

  close(): void {
    (this as unknown as { db: import('better-sqlite3').Database }).db.close();
  }
}

export function defaultDataDir(repoRoot: string): string {
  return path.join(repoRoot, 'data');
}
