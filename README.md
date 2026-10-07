# 山海司（Shanhai）· Agent 工程平台 Runtime

以规格定义 Agent，以运行时执行 Agent，以证据认识 Agent，以演进治理 Agent，以本机门户操作 Agent。

核心验证链：**定义（Spec）→ 执行（Runtime）→ 证据（Trace）→ 评估（Evaluation）→ 验收（Acceptance）**，
TypeScript + SQLite（WAL）模块化单体，密钥零落盘（T3 发布安全）。

- 实现规格（唯一输入来源）：`docs/spec/A0–A6`
- 演进轨迹：第一阶段最小 Runtime → 第二阶段安全与版本治理（审批/Reviewed/灰度/记忆/演进）→ 第三阶段落盘面与发布扫描硬化 → 第四阶段 MCP 外部工具（青龙）→ 第五阶段证据存取/能力断言/洞察趋势 → 第六阶段山海门户（server + 初版 UI）→ 第七阶段门户界面重设计（现 UI）。各阶段设计与验收文档见 `docs/phase1` … `docs/phase7`。

## 快速开始

```bash
npm install
npm run build                                    # tsc 产出 dist/
cp config.example.json config.local.json         # 按需修改 baseUrl / 模型白名单（已入 .gitignore）
export SHANHAI_ANTHROPIC_AUTH_TOKEN=<你的密钥>    # T3：密钥仅环境变量注入，仓库只留占位
npm test                                         # 778 项测试，statements 覆盖率 96.36%
npm run build:portal                             # 门户 UI 产物（tsc + esbuild，直出 src/portal/public/）
```

配置文件查找次序：`SHANHAI_CONFIG` 环境变量指定路径 → `./config.local.json`（无配置即拒绝启动，`src/config.ts`）。

环境变量速查：

| 变量 | 作用 |
|---|---|
| `SHANHAI_ANTHROPIC_AUTH_TOKEN` | 模型密钥（`authTokenEnv` 声明于 config） |
| `SHANHAI_CONFIG` | 配置文件路径覆盖 |
| `SHANHAI_DATA_DIR` | 数据目录（默认 `<repo>/data`） |
| `SHANHAI_PORTAL_PORT` | 门户端口（须为 1-65535 整数，非法值拒启动） |
| `SHANHAI_PORTAL_TOKEN` | 门户 Token 显式覆盖（显式 Token 不自动拉浏览器） |

## CLI 命令表

以 `src/cli.ts` usage() 为准；未知旗标一律 fail-fast（见下节）。

```bash
# Agent 版本环
shanhai agent register <spec.json> [--by <who>] [--from-candidate <candidateId>]
shanhai agent release <agentId> <versionId> [--no-pointer] [--by <who>]
shanhai agent review <agentId> <versionId> [--by <who>]          # Draft→Reviewed，diff 检视清单逐项确认
shanhai agent deprecate <agentId> <versionId> [--by <who>]
shanhai agent rollback <agentId> <versionId> [--by <who>]
shanhai agent canary set <agentId> <versionId> --weight N        # 灰度目标须 Released 且 ≠ current
shanhai agent canary clear <agentId>
shanhai agent promote <agentId>                                   # canary→current + 清零；判据为建议，决定权留人
shanhai agent report <agentId> [--since <RFC3339>]               # 分组通过率 + promote 判据 + 旁挂三单列
shanhai agent list <agentId>
shanhai agent show <agentId> [<versionId>]
shanhai agent card <agentId> [versionId]                          # Agent Card 只读派生导出；缺省当前指针版本
shanhai agent insight <agentId> [versionId] [--since <RFC3339>] [--json]   # 自我认知报告（只读现算）

# 任务执行
shanhai task create <agentId> <input.json> [--by <who>] [--draft|--reviewed]
shanhai task run <taskId> [--strategy native|prompt] [--resume] [--resumed-by approve-spawn|manual-resume]
shanhai task cancel <taskId> [--by <who>] [--force]               # --force = abort 立即中止/跨进程登记
shanhai task get <taskId>

# 人工审批（L3 高风险工具）
shanhai approval list [--pending]
shanhai approval show <requestId>
shanhai approval approve <requestId> [--by <who>] [--detach]      # 只写 decision；默认前台 spawn resume
shanhai approval deny <requestId> [--by <who>] [--reason <text>]  # 任务级终局 → Cancelled(approval_denied)

# 工具登记与 MCP
shanhai tool register --file <def.json> [--by <who>]              # 登记/重登记工具；等级只升不降
shanhai tool list [--kind builtin|external] [--risk L0..L4]
shanhai tool show <toolId>
shanhai tool retire <toolId> [--by <who>]
shanhai tool mcp connect <name> [--yes] [--by <who>]              # 发现→确认清单→批量登记；--yes 全按缺省 L3

# 认知与演进
shanhai memory list [--agent <agentId>]                           # 白泽记忆；顺带惰性全量校正
shanhai evolution list                                            # 女娲演进候选；顺带惰性聚合
shanhai evolution show <candidateId>
shanhai evolution confirm <candidateId> [--proposed-change <text>]
shanhai evolution dismiss <candidateId>

# 证据与能力断言
shanhai evidence show <ref>                                       # ref=<kind>:<id>（task/trace_event/failure/memory，eval 预留位）
shanhai evidence task <taskId>                                    # 任务全链证据链（只读派生）
shanhai capability list [--agent <id>] [--kind capability|limitation] [--status candidate|active|retired]
shanhai capability add <agentId> --kind <capability|limitation> --statement <text|--statement-file <path>> [--evidence <ref,...>] [--by <who>]
shanhai capability confirm <capabilityId> [--by <who>]
shanhai capability retire <capabilityId> [--by <who>]
shanhai capability trend <agentId> [--since <RFC3339>] [--until <RFC3339>] [--bucket day|week]

# 举证查询
shanhai query t1 <taskId>                                         # T1：Trace → 生效 Spec 版本
shanhai query t2 <versionId>                                      # T2：版本 → 全部越权尝试与拦截点
shanhai query t2p <versionId>                                     # T2′：版本 → 全部 L3 审批请求及裁决

# 门户（见下节）
shanhai portal [--port N] [--host H] [--dataDir <dir>] [--no-open] [--print-url]

# 发布安全扫描
npm run release-scan                                              # 命中=1 / 干净=0 / 未扫描=2；豁免根自检加 --allow-exempted-root
```

### 未知旗标 fail-fast（两级守卫）

- **顶层命令族**（`src/cliFlags.ts`）：`--` 开头且不属于该命令已知旗标集合 → 报错退出（含旗标名与支持清单），先于 Runtime 构造——不建库不写状态，零副作用。`--by` 为全命令通用值旗标。
- **portal 子命令**（`src/portal/server.ts`）：同样 fail-fast，且 portal 无位置参数面——多余位置参数也拒绝。
- 手误形态（如 `--resum`、`--print-ur`）不会被静默忽略，直接报错而非改变语义。

## 山海门户（本机操作台）

```bash
shanhai portal                          # 常驻本机操作台；缺省 127.0.0.1:7780
shanhai portal --port 18080 --host 0.0.0.0
shanhai portal --dataDir <dir>          # 数据目录：旗标 > SHANHAI_DATA_DIR > <repo>/data
shanhai portal --no-open                # 不自动拉起浏览器
shanhai portal --print-url              # 打印带 Token 的访问 URL 后退出（不启动服务、零副作用）
```

- **页面**：任务（列表/详情）、审批（队列/详情）、观测（总控/能力矩阵/演进/证据）、Agent 目录与详情——hash 路由（`src/portal/ui/routes.ts`）。
- **Token 自动送达**：首次启动自动生成 Token（`data/portal/token`，POSIX 0600）；每次启动自动拉起默认浏览器，Token 经 URL fragment 带外注入，前端读取后即从地址栏抹除（`src/portal/browser.ts`）。显式 config/env Token 不拉起浏览器；`--no-open` 为逃生口。
- **新浏览器会话再取**：`shanhai portal --print-url` 只读解析既有 Token 构造访问 URL，打印后退出——粘贴到浏览器打开即自动保存并从地址栏抹除。从未首启（无 Token）时报错并指引先完成首启。
- **通配绑定与私网访问**：`--host 0.0.0.0`（或 `::`）时 Host 头校验放行回环形态与私网/链路本地字面 IP（10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10），公网域名与公网字面 IP 仍拒绝（防 DNS rebinding，`src/portal/auth.ts`）。
- **认证与写面**：所有 `/api/*` 要求 Bearer Token；POST 强制 `application/json`（违者 415），请求体上限 1 MiB（超限 413）。写操作全部经既有 Manager（零旁路），resume 走 detached 子进程。
- **崩溃恢复**：`GET /api/portal/crash-recovery` 只读查看恢复报告；门户启动时若检测到 Running 任务则跳过崩溃恢复扫描并警示（避免误杀活进程执行）。
- **冒烟脚本**：`node scripts/smoke-portal.mjs --form dist|tsx`（门户全链路端到端自证，含审批→resume→终态）。

## 模块地图（src/）

| 模块 | 文件 | 规格 |
|---|---|---|
| SpecValidator | `modules/specValidator.ts` + `modules/contractSchema.ts` | A1 §4 两层校验、A2 §6 子集 |
| Registry（Agent + Tool） | `modules/registry.ts` | A1 §5/§7、A5 §1–§2、A2 附录 A |
| TaskManager | `modules/taskManager.ts` | A3 状态机 + 审计边界 |
| ModelGateway | `modules/modelGateway.ts` + `providers/` | A2 §2/§7 预算/attempt/usage |
| ToolExecutor | `modules/toolExecutor.ts` | A2 §3–§5/§8 闸门与拦截 |
| StateManager | `modules/stateManager.ts` | A3 §6 崩溃恢复 + A6 §6.1 索引对账 |
| TraceRecorder | `modules/traceRecorder.ts` | A6 §2–§3 信封与 JSONL |
| FailureRecorder | `modules/recorders.ts` | A4 §1–§2 封闭分类与物化口径 |
| Approval | `modules/approval.ts` | L3 人工审批与超时判定 |
| Memory / Evolution | `modules/memory.ts` + `modules/evolution.ts` | A1 §2.1/§2.3 持久化记忆与演进治理 |
| EvidenceStore | `modules/evidenceStore.ts` | 证据只读派生存取 |
| CapabilityRegistry | `modules/capabilityRegistry.ts` + `modules/trend.ts` + `modules/insight.ts` | 能力/限制断言、趋势、自我认知 |
| Redaction | `modules/redaction.ts` | A6 §8 Trace 写入时脱敏 |
| MCP 接入 | `mcp/client.ts` + `mcp/connect.ts` + `mcp/bridge.ts` | 第四阶段外部工具 |
| Portal | `portal/server.ts` + `portal/api.ts` + `portal/ui/` | 第六/七阶段本机操作台 |

## 发布安全（T3，用户硬性规则）

线上/发布产物不得包含任何模型与密钥：配置一律 `config.example.json` 模板 + 环境变量注入；
MCP server 凭据唯一通道为 `envRefs` 环境变量引用占位（`${VAR}`），值永不落配置/库/Trace；
`ModelGateway` 无配置即拒绝启动；`npm run release-scan` 零命中方为通过。

## 质量门（当前基线）

| 项 | 基线 | 口径 |
|---|---|---|
| 测试 | 778/778 全绿 | `npm test`（vitest run） |
| 覆盖率 | statements 96.36% | vitest v8 text 报表；口径见 `vitest.config.ts`（include `src/**/*.ts`，排除 cli/config/experiment/providers 适配层） |
| 类型 | `tsc` 0 错 | `npm run build` |
| T3 扫描 | 零命中 | `npm run release-scan` |

## 假设 #4 实验

```bash
npm run experiment   # 3 类 Spec × 10 任务 × 策略 A/B，报告输出至 experiments/reports/
```

制品（Specs + 任务集）冻结于启动前 Git 哈希（11 号 §2.2 制品冻结裁定）。
