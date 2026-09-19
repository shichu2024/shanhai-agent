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
npm test                                    # 129 项测试（54 第一阶段存量 + 批次一 34 + 批次二 24 + 批次三 17：记忆/Evolution/脱敏加固/迁移）
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

## CLI · 第二阶段批次二（数据与发布治理）

```bash
# Trace 脱敏（A6 §8，D-11）：写入时脱敏、原文不落盘；redactionPolicy 为运行时配置（config.local.json 可选段，缺省 = 默认规则集）
#   排除表（信封/bindingSnapshot/*Digest）零改写；digest 脱敏前按原文计算（跨任务对账稳定）；命中留痕 redacted 摘要

# 灰度发布（A5 §3a/§4a，D-12）：release --no-pointer → canary set → report 判据 → promote
npm run cli -- agent canary set <agentId> <versionId> --weight N   # 目标须 Released 且 ≠ current
npm run cli -- agent canary clear <agentId>                        # 灰度归零（回退，立即审计）
npm run cli -- agent promote <agentId>                             # canary→current + 清零（判据为建议，决定权留人）
npm run cli -- agent report <agentId> [--since <RFC3339>]          # 分组通过率 + promote 判据（insufficient-sample 显式）
                                                                   #   旁挂三单列：审批超时计数 / 受工具升级影响的 Spec(R-5) / stale 汇总
```

## CLI · 第二阶段批次三（认知与演进）

```bash
# 持久化记忆（A1 §2.1 memoryPolicy.persistent，D-13）：content 过同一 redactionPolicy 管道；
#   candidate→active（≥2 独立 taskId）→ degraded（注入且 Failed）→ 恢复边（evidence − baseline ≥ 2）；
#   injection 缺省 off（默认零注入攻击面）；惰性全量校正幂等
npm run cli -- memory list [--agent <agentId>]           # 记忆清单（顺带惰性校正）

# 演进候选（A1 §2.3 evolutionPolicy，D-14）：agentId 聚类、阈值触发、evidenceRefs 回链；
#   人工确认制——系统永不自动注册/发布；requireReviewed 强制 true 不可关闭
npm run cli -- evolution list                            # 候选清单（顺带惰性聚合）
npm run cli -- evolution confirm <candidateId> [--proposed-change <text>]
# 产物路径（人工起草）：register → review（检视门）→ release --no-pointer → canary set → promote
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
