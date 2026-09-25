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
import { EvidenceStore } from './modules/evidenceStore.js';
import { CapabilityManager } from './modules/capabilityRegistry.js';
import { BUILTIN_TOOL_DEFS, BUILTIN_TOOL_VERSION, createBuiltinImpls } from './tools/builtin.js';
import { Delegation } from './runtime/delegation.js';
import { McpToolBridge } from './mcp/bridge.js';
import type { McpServerConfig, McpTransport } from './mcp/client.js';

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
  /** 批次三（§4.5-4，D-25）：dismiss 冷却窗天数（config.local.json evolution 段；缺省 7） */
  evolutionDismissCooldownDays?: number;
  /** 第四阶段批次一（§4.2）：MCP server 配置段（运行时配置平台层）；缺省 = 无外部工具 */
  mcpServers?: Record<string, McpServerConfig>;
  /** 测试注入：in-proc transport 工厂（夹具主形态，§14.2-2）；缺省 = stdio 子进程 */
  mcpTransportFactory?: (name: string, cfg: McpServerConfig) => McpTransport;
  /** 第四阶段批次二（§4.3-4 / F-10-④）：MCP 结果超长截断上限（缺省 20000） */
  mcpResultMaxChars?: number;
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
  /** 第五阶段批次一（§4.1，D-35）：Evidence Store 只读派生存取层（零写入） */
  readonly evidence: EvidenceStore;
  /** 第五阶段批次二（§4.2，D-37/D-38）：Capability/Limitation Registry */
  readonly capabilities: CapabilityManager;
  readonly toolImpls: Map<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;
  /** 第四阶段批次三（§4.4）：鲲鹏委托原语（task-delegate impl + 治理预检） */
  readonly delegation: Delegation;
  /** 第四阶段批次一（§4.2）：mcpServers 配置段（connect 流水线与调用桥共同消费） */
  readonly mcpServers: Record<string, McpServerConfig>;
  readonly mcpBridge: McpToolBridge;

  constructor(opts: RuntimeOptions) {
    const handles = openDatabase(opts.dataDir);
    this.tracesDir = handles.tracesDir;
    const redaction = opts.redaction ?? defaultRedactionPolicy();
    this.trace = new TraceRecorder(handles.db, handles.tracesDir, redaction);
    this.memories = new MemoryManager({ db: handles.db, trace: this.trace, redaction }); // 同一 redactionPolicy（前置不可削依赖）
    this.evolutions = new EvolutionManager({ db: handles.db, dismissCooldownDays: opts.evolutionDismissCooldownDays });
    this.evidence = new EvidenceStore({ db: handles.db, trace: this.trace });
    // 批次二（§4.2 DB 侧脱敏）：四落盘面（task_record.input / pause_snapshot.contextJson / notes.md /
    // failure+audit 明细）全部入库前过同一 redaction 实例——与 Trace/记忆共用（§9.1-3 双写一致性）。
    this.failures = new FailureRecorder(handles.db, redaction);
    this.audit = new AuditRecorder(handles.db, redaction);
    // 第五阶段批次二（§4.2，D-37/D-38）：Capability Registry——依赖 audit（此处已构造）与批次一 evidence
    this.capabilities = new CapabilityManager({
      db: handles.db,
      trace: this.trace,
      evidence: this.evidence,
      audit: this.audit,
    });
    this.registry = new Registry(handles.db, redaction);
    this.state = new StateManager(handles.db, this.trace, this.failures);
    this.gateway = new ModelGateway(opts.provider, opts.whitelist);
    this.toolImpls = createBuiltinImpls(opts.repoRoot, redaction);
    // 第四阶段批次一（§4.2-3 调用桥）：external 工具经同一 ToolExecutor 循环分派至 MCP client
    this.mcpServers = opts.mcpServers ?? {};
    this.mcpBridge = new McpToolBridge({ db: handles.db, servers: this.mcpServers, transportFactory: opts.mcpTransportFactory, resultMaxChars: opts.mcpResultMaxChars });
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
      externalCall: (toolId, args) => this.mcpBridge.call(toolId, args),
      audit: this.audit,
      approvals: this.approvals,
      memories: this.memories,
      dispatchRoll: opts.dispatchRoll,
      redaction,
    });
    // 第四阶段批次三（§4.4，D-30）：委托原语接线——Delegation 持有 TaskManager 引用（阻塞式嵌套执行），
    // 构造后注入以规避构造环；task-delegate 经 ToolExecutor 委托原语特殊类别分派至此。
    this.delegation = new Delegation({
      db: handles.db,
      registry: this.registry,
      trace: this.trace,
      state: this.state,
      audit: this.audit,
      redaction,
      dispatchRoll: opts.dispatchRoll,
      tasks: this.tasks,
    });
    this.tasks.useDelegate(this.delegation);
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
      evolutionDismissCooldownDays: config.evolution?.dismissCooldownDays,
      mcpServers: config.mcpServers,
      mcpResultMaxChars: config.mcp?.resultMaxChars,
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
    extra: { mcpServers?: Record<string, McpServerConfig>; mcpTransportFactory?: (name: string, cfg: McpServerConfig) => McpTransport } = {},
  ): Runtime {
    return new Runtime({
      dataDir, repoRoot, provider, whitelist: new Set(whitelist), redaction, dispatchRoll,
      mcpServers: extra.mcpServers, mcpTransportFactory: extra.mcpTransportFactory,
    });
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
    void this.mcpBridge.close(); // MCP 按需连接释放（不阻塞关闭）
    (this as unknown as { db: import('better-sqlite3').Database }).db.close();
  }
}

export function defaultDataDir(repoRoot: string): string {
  return path.join(repoRoot, 'data');
}
