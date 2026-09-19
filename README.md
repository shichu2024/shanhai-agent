# 山海司（Shanhai）· 第一阶段最小 Runtime

以规格定义 Agent，以运行时执行 Agent，以证据认识 Agent。第一阶段交付可亲身运行、端到端跑通的验证链：
**定义（Spec）→ 执行（Runtime）→ 证据（Trace）→ 评估（Evaluation）→ 验收（Acceptance）**。

- 设计定稿：`docs/phase1/第一阶段设计文档-定稿.md`
- 实现规格（唯一输入来源）：`docs/spec/A1–A6`
- 本工作包：WP-B（TASK-39），模块化单体八模块，TypeScript + SQLite（WAL）

## 快速开始

```bash
npm install
npm run build
cp config.example.json config.local.json   # 按需修改 baseUrl / 模型白名单
export SHANHAI_ANTHROPIC_AUTH_TOKEN=<你的密钥>   # T3：密钥仅环境变量注入，仓库只留占位
npm test                                    # 82 项测试（第一阶段 54 存量零回退 + 批次一 28 新增：审批流/Reviewed/abort/迁移）
```

## CLI（A5 §2 命令表）

```bash
npm run cli -- agent register <spec.json>          # 注册快照（draft）→ versionId
npm run cli -- agent release <agentId> <versionId> # 发布 + 指针移动
npm run cli -- agent rollback <agentId> <versionId># 指针回滚（不产生新版本）
npm run cli -- task create <agentId> <input.json>  # 创建任务（落库前校验失败 → RejectedRequest）
npm run cli -- task run <taskId>                   # 执行（Queued→Running→终态）
npm run cli -- query t1 <taskId>                   # T1：Trace → 生效 Spec 版本 + Prompt/工具版本
npm run cli -- query t2 <versionId>                # T2：版本 → 全部越权尝试与拦截点
npm run release-scan                               # T3：发布产物密钥/模型权重扫描（零命中通过）
```

## CLI · 第二阶段批次一（安全与版本核心）

```bash
# 人工审批完整流（L3 高风险工具，spec 声明 approvalPolicy.mode=onHighRisk）
npm run cli -- approval list [--pending]           # 审批队列（顺带惰性超时判定）
npm run cli -- approval approve <requestId>        # 只写 decision；默认前台 spawn resume（--detach 可选）
npm run cli -- approval deny <requestId>           # 任务级终局 → Cancelled(approval_denied)
npm run cli -- task run --resume <taskId>          # 续跑挂起任务（持有 Paused→Running 迁移权，D-18/R-1）

# Reviewed 版本环（可选质量门，直发保留）
npm run cli -- agent review <agentId> <versionId>  # Draft→Reviewed：diff 检视清单 5 项逐项确认
npm run cli -- agent release <a> <v> --no-pointer  # 发布不移指针（canary 入口）

# 任务立即中止（abort：放弃等待，不回滚已发生副作用）
npm run cli -- task cancel <taskId> --force        # 本进程立即 / 跨进程登记 abortRequested

npm run cli -- query t2p <versionId>               # T2′：版本 → 全部 L3 审批请求及裁决（审批可举证）
```

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

## 发布安全（T3，用户硬性规则）

线上/发布产物不得包含任何模型与密钥：配置一律 `config.example.json` 模板 + 环境变量注入；
`ModelGateway` 无配置即拒绝启动；`npm run release-scan` 零命中方为通过。

## 假设 #4 实验

```bash
npm run experiment   # 3 类 Spec × 10 任务 × 策略 A/B，报告输出至 experiments/reports/
```

制品（Specs + 任务集）冻结于启动前 Git 哈希（11 号 §2.2 制品冻结裁定）。
