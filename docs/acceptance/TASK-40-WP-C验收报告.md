# WP-C 验收报告（TASK-40）

- **验收对象**：WP-B 最小 Runtime 八模块（TASK-39 交付，commit `17f267a`，分支 `wp-b-runtime-task39` / PR #1）
- **验收依据**：《山海司核心规格 V1》（`docs/spec/`，commit `1aef9e3`）+ 定稿 §6（commit `1413e66`）
- **验收执行**：反方审查官（2026-09-19）；裁定：综合决策官
- **环境**：Windows 11 / Node 22；真实模型 glm-4.6（bigmodel Anthropic 兼容端点，密钥仅环境变量注入）；确定性用例使用脚本化 MockProvider
- **方法**：不信任交付报告自述——C2 从 60 份原始 Trace JSONL 独立重算（不复用交付方聚合代码）；负向与崩溃用例走真实进程与真实 SIGKILL

## 结论总表

| 项 | 结果 | 证据 |
|---|---|---|
| 基线 | ✅ build 干净 + 50/50 测试全绿 | `evidence/baseline-t3.txt` |
| C1 端到端 | ✅ 通过（单进程链路；CLI 两进程路径存在缺陷 F-1，不影响本体判定，见发现清单） | `evidence/evidence-c1-f1.json` → `c1` |
| C2 契约通过率 | ✅ 六层全部 ≥80% 决策线；独立重算与归档报告逐层一致 | `evidence/c2-recompute-out.json` |
| C3-① 越权 Spec 注册即拒 | ✅ L4 声明拒 + 未注册工具拒，错误指名字段路径（D-1） | `evidence/evidence-c3-1-register-reject.txt` |
| C3-② maxModelCalls=1 确定性截停 | ✅ `Failed:Runtime(BudgetExceeded)`，modelCallCount=1，附 D-2 调用构成明细 | `evidence/c3-out.json` → `c3_2` |
| C3-③ 连续拦截 ≥2 → PolicyBlocked | ✅ 归因不漂移（无 BudgetExceeded 记录），consecutiveDenialCount=2 | `evidence/c3-out.json` → `c3_3` |
| T1 证据可用 | ✅ Failed 任务单一查询返回生效 Spec 版本 + promptHash + 工具版本绑定 | `evidence/c3-out.json` → `t1_onFailed`（CLI 路径同验） |
| T2 拦截可举证 | ✅ 单一查询返回该版本全部 policy_denied（含 reasonCode/计数）+ RejectedRequest（task_creation 切片） | `evidence/c3-out.json` → `t2` |
| T3 发布安全 | ✅ 仓库扫描零命中（exit 0）；阳性对照命中（非空转）；无密钥/无配置双路径 fail-fast；config.local.json 未入库 | `evidence/baseline-t3.txt` |
| A7 kill -9 索引重建 | ✅ 真实 SIGKILL（delay 调用窗口）→ 注入索引撕裂（14→12 行）→ 重启自动重建：索引 16 行 = 文件 16 行 | `evidence/evidence-kill9.json` |
| A8 T2 复查 | ✅ kill -9 前的 policy_denied（undeclared-evil）重启后经 T2 单一查询命中 | 同上 → `a8_t2_recheck` |
| A9 CrashRecovery 次序 | ✅ 对账先于崩溃标记：`crash_recovery_marked` 位于全部 14 条崩溃前事件之后（第 15 行），崩溃追加事件入索引后索引=文件行数（16=16） | 同上 → `a9_ordering` |

**T1/T2 断言真实成立，非「功能演示正常」替代：空心地基判定不触发。**

## 逐项要点

### C1 端到端演示（真实业务只读任务）

单进程 `register → release → task create（含 Input Contract 校验）→ task run → Trace 落盘 → Succeeded`。
真实模型调用 5 次、26,568 tokens、7 次工具尝试；Agent 使用 `docs-list`/`docs-read` 对本仓库 `docs/` 做只读分析，产出符合 outputContract 的结构化摘要（25 文件、phase1/spec 两个子目录、keyFinding 与实际文档内容吻合）。Trace 37 事件完整覆盖 `task_created → contract_checked → task_queued → task_started →（模型/工具交替）→ task_succeeded`。T1 对该任务返回完整绑定（modelId=glm-4.6、promptHash、工具 implVersion 0.1.0）。

⚠️ 执行中触发 **F-1（P1）**：按 README「快速开始」用 CLI 分两进程执行 `task create` + `task run` 时，`task run` 进程启动即执行 A3 §6 崩溃恢复扫描，把仍在 Queued 的任务迁移 `Failed:Runtime(CrashRecovery)`（Trace 序列：`task_queued → crash_recovery_marked(lastKnownStatus=queued) → task_failed`，见 `evidence/evidence-c1-f1.json` → `f1_cli_defect`）。核心生命周期本体在单进程路径判定通过，但 **documented CLI 工作流按现状不可走通**。

### C2 契约通过率（独立重算）

对冻结实验运行 `hyp4-2026-09-19T07-44-53`（60 份 Trace = 3 Spec × 10 任务 × 策略 A/B）独立重算（Wilson 区间独立实现）：

| 分层 | N | 首次通过率 | Wilson 95% CI | 含重试 | 判定 |
|---|---|---|---|---|---|
| s1-summary × A | 10 | 100.0% | [72.2%, 100.0%] | 100% | ≥80% ✅ |
| s1-summary × B | 10 | 90.0% | [59.6%, 98.2%] | 90% | ≥80% ✅ |
| s2-extraction × A | 10 | 90.0% | [59.6%, 98.2%] | 100% | ≥80% ✅ |
| s2-extraction × B | 10 | 100.0% | [72.2%, 100.0%] | 100% | ≥80% ✅ |
| s3-decision-report × A | 10 | 90.0% | [59.6%, 98.2%] | 100% | ≥80% ✅ |
| s3-decision-report × B | 10 | 80.0% | [49.0%, 94.3%] | 100% | ≥80%（压线）✅ |

- 与归档报告 `experiments/reports/hypothesis4-2026-09-19T07-44-53.md` **逐层数字完全一致**——交付报告无粉饰。
- A4 失败分类分布吻合：A 类仅 2×call_timeout；B 类 schema_violation×4、truncation×1、终局 schema_violation×1。
- 排除计数：provider_infra=0、provider_rejected_schema=0（无排除样本，口径仍按规格单列）。
- N≥10 满足（每层 10；定稿 §6 括注认可实验设计 3 类 Spec × 10）。
- 注意：s3×B 恰在 80% 决策线上、Wilson 下界 49%——11 号 §2.1 小样本不确定性声明如实成立，不构成否决，但第二阶段扩样前不得引用该层作更强结论。

### C3 反向验收

- ①（CLI 真实入口）：L4 声明 → 拒（「L3/L4 声明注册即拒（D-3 裁决）」+ 等级不一致双证据）；未注册工具 `shell-exec` → 拒（引用完整性）。均 exit 1、指名字段路径、写 RejectedRequest 审计。
- ②（确定性 mock）：预算 1 次、脚本要求 2 次 → 第 2 次调用前置检查即终局 `Runtime(BudgetExceeded)`，实际发起 modelCallCount=1，FailureRecord 附预算/消耗/attempt 明细（D-2）。
- ③（确定性 mock）：连续 2 次 `not_declared_in_spec` 拦截 → `Policy(PolicyBlocked)`；FailureRecord 仅 Policy 类，**无 BudgetExceeded 记录（归因不漂移验证通过）**。

### T1 / T2

- T1：对 C3-② 的 Failed 任务（无任何人工标注）执行 `query t1`，单一查询返回 agentVersionId、specContentHash、Spec 快照、bindingSnapshot（promptHash + 工具 implVersion + modelId）。两级答案形态（无 task_started → 信封级）由单测覆盖。
- T2：对 C3-③ 版本执行 `query t2`，返回 2 条 policy_denied（含 reasonCode、consecutiveDenialCount 递增）+ 1 条 RejectedRequest（无效输入任务创建，字段级拒绝原因）。kind 并集与 NULL 兜底口径符合 A6 §4 P2-3。

### T3 发布安全

- `npm run release-scan`（仓库根）：**零命中，exit 0**。
- 阳性对照：植入密钥样例 + `model.gguf` → 命中 secret×2 + model_weight×1（扫描器非空转）。
- fail-fast：缺密钥环境变量 → ConfigError；缺配置文件 → ConfigError（无配置即拒绝启动）。
- `config.local.json` 被 .gitignore 覆盖且未入库；仓库只留 `config.example` 占位。

### 增补用例 A（kill -9 真实进程）

子进程执行中（第 3 次模型调用 delay 窗口）被父进程 **SIGKILL**（Windows TerminateProcess）。kill 前已落盘 14 事件（含 1 条 policy_denied）。人为注入 D-6 崩溃窗口（索引删 2 行：14→12，文件 14 行）。重启进程（独立 Node 进程触发 `startup → recover()`）后：

- **A7**：`reconciledTasks` 含该任务；索引 16 行 = 文件 16 行（14 崩溃前 + 2 崩溃标记追加），自动重建、无人工干预。
- **A8**：T2 单一查询仍命中崩溃前 `policy_denied`（undeclared-evil / not_declared_in_spec / 计数 1）——索引重建不丢越权记录。
- **A9**：`crash_recovery_marked` 为文件第 15 行（全部崩溃前事件之后），任务终态 `Failed:Runtime(CrashRecovery)`；崩溃追加事件入索引后索引与文件完全一致——CrashRecovery 的 Trace 追加发生在完整索引之上（次序约束成立；`recover()` 先对账后标记的代码次序另有单测 `recovery.test.ts` 覆盖）。

## 发现清单（缺陷与建议，非阻断项）

| # | 等级 | 发现 | 影响 | 建议处置 |
|---|---|---|---|---|
| F-1 | **P1** | CLI 两进程 `task create` → `task run`：后一进程启动扫描按 A3 §6 将 **Queued** 任务判为 CrashRecovery，任务永不可经 CLI 执行。根因 = A3 §6（Queued/Running 无差别迁移，无归属/租约概念）× A5 §2 CLI 命令表（create 与 run 分进程）的规格内冲突。单测/实验均单进程，未暴露 | README 快速开始不可走通；任何「入队后等执行」的真实使用形态被自杀；演示只能单进程 | 规格澄清（[@方案设计师]）+ 实现修复（[@执行官]）：如恢复扫描仅针对 Running（Queued 需配 lease/时间戳防真丢失），或 CLI 同进程 create+run 子命令。修复后重验 CLI 路径 |
| F-2 | P3 | 实验报告「平均模型调用/任务（成本代理）」只计 `model_call_completed`，漏计失败 attempt（如 s2×A 实际发起 2 次仅计 1）；与 A2 §7 modelCallsIssued「已发起口径」不一致 | 成本被低估；不影响通过率结论（通过率口径正确） | 报告口径改为计 `attempt_started(model)` 或补注口径 |
| F-3 | P3 | `report.ts` 分母 = 任务级 total − attempt 级排除数（单位混用）。本次排除数全为 0 未实际出错，但出现排除样本时分母会算错 | 未来实验数据失真风险 | 排除口径改为任务级（含排除 attempt 的任务整单剔除或按样本定义重述） |
| F-4 | P3 | `releaseScan.ts` 的 `hasWeightMagic`/`WEIGHT_MAGICS` 定义后未使用（魔数检查实际未执行，仅扩展名生效）；zip 族魔法数故意置空 | 死代码；权重检测弱于注释宣称 | 删除或接通魔数检查 |

## 特别要求回答（反方审查官立场）

1. **最可能失败环节**：曾是「Trace 落盘 ≠ 可用证据」的空心地基——本次 T1/T2 实测答出，该风险已消除；当前最薄弱处转为 F-1（CLI 可用性）：核心机制全对，但按文档首次上手即失败。
2. **最脆弱假设**：「崩溃恢复扫描发现的非终态任务 = 崩溃遗留」。F-1 证明该假设在正常交接窗口不成立。
3. **无明确责任人的环节**：CLI 端到端可用性（A5 命令表 × A3 恢复规则的交互）在 WP-A/WP-B 切分中无人 owning。
4. **理论可行、落地打折**：报告成本代理列（F-2）；权重魔数检查（F-4）。
5. **不必要复杂度**：无重大项。`crash-restart` 场景的对账+标记双钩子设计简洁且被 A7–A9 实测支撑。
6. **只保留一半功能**：保 Spec 验证 + 状态机 + Trace 证据链（T1/T2）+ 预算/策略终局；可牺牲 CLI 全命令面（换最小 create+run 同进程入口）。
7. **如何证明修订后更好**：F-1 修复的机械验收 = CLI 分进程 create → run 成功执行且任务 Succeeded；回归 = 50/50 单测 + 本报告全部断言脚本（`scripts/`）重跑全过。

## 裁定建议

- C1/C2/C3、T1/T2/T3、增补 A7/A8/A9：**全部通过**（证据可复现，脚本随报告归档于 `scripts/`）。
- F-1（P1）不否定核心机制验收结论，但属「文档化工作流不可用」的真实缺陷：建议裁定为**有条件通过**——WP-C 验收通过、P-4 可启动，F-1 派发方案设计师（规格澄清）+ 执行官（修复），修复后按上节第 7 条重验 CLI 路径即闭环；F-2/F-3/F-4 随下个迭代顺手处理。

---

*执行制品：`evidence/`（6 份原始输出）+ `scripts/`（可重跑脚本与 Spec 制品）。运行数据目录 `data/acceptance-task40/`（gitignored）。*
