# TASK-40 F-1 闭环重验记录（反方审查官，闭环链第 3 环）

- 重验对象：`worktree-f1-fix-task40` @ `faabf68`（基于 `wp-b-runtime-task39` @ `6761b3b`，即 A3 §6 修订规格）
- 重验环境：与验收轮同机；真实模型密钥经环境变量注入（T3 口径）
- 重验范围：综合决策官裁定——CLI 分两进程路径 + 全量回归 + kill -9 三条；C2 独立重算豁免
- 重验日期：2026-09-19

## 裁定验收标准逐项结果

| 裁定标准 | 结果 | 证据 |
|---|---|---|
| ① CLI 分两进程 create→run→Succeeded（README 原样） | ✅ | 真实模型 glm-4.6：进程 A `agent register`+`agent release`+`task create` 后正常退出；进程 B（新 node 进程，触发启动恢复扫描）`task run` → `succeeded`（5 次模型调用，15456 tokens）；Trace 46 事件中 `crash_recovery_marked` **0 次**；结构化输出正确（subdirs/filesCovered/verdict 齐备） |
| ② kill -9 三条（A7/A8/A9）重跑 | ✅ | `crash-parent.mjs` 原样重跑（脚本路径适配本 worktree，逻辑零改动）：真实 SIGKILL + 索引撕裂注入（14→12 行）→ A7 重建 16=16、A8 T2 命中 `policy_denied`（undeclared-evil/not_declared_in_spec）、A9 `Runtime(CrashRecovery)` 次序成立，三项 pass 均真 |
| ③ 单测全绿 + 断言脚本重跑 | ✅ | build 干净 + **54/54**（50 原有 + 4 新增）；c3-mock 重跑：BudgetExceeded 截停（modelCallCount=1）、PolicyBlocked 归因不漂移（attributionNoDrift=true）、落库前 RejectedRequest、T1 绑定快照、T2 双拦截记录；T3 `release-scan` 仓库零命中（exit 0） |
| ④ A3 §6 修订文本入库 | ✅ | `6761b3b`（主分支 HEAD，fix 分支直接基于其上） |

## F-2/F-3/F-4 差异审查（代码级，未逐项重跑——裁定归入本批一并回归）

- **F-2**：`report.ts` 成本代理改 `attempt_started`·model 计数（A2 §7 已发起口径），归档报告加注记不改冻结数值——正确；s2×A 1.10 / s3×A 3.10 修正值与 attempt 序列推算一致。
- **F-3**：排除改样本级计数（含排除类 attempt 的任务整样本计 1），分母/分子/排除三量同单位——正确；本次运行排除数为 0，数值不变。
- **F-4**：魔数检查接通（GGUF/HDF5 首 4 字节）+ 符号链接跳过；**阳性对照实测**：无扩展名改名权重文件（GGUF 魔数 `47 47 55 46`、HDF5 魔数 `89 48 44 46`）均被命中、exit 1（拒绝发布）——防改名绕过生效。注：首验时对照组误用小写 `ggml` 字节（0x67）未命中属载体构造错误，非实现缺陷。

## 补充说明

- 执行官诚实声明的「真实模型两进程路径未跑」已由本环境补验：**通过**（上表 ①）。README 快速开始原样走通。
- 魔数清单现为 GGUF + HDF5 两族（zip 族显式注释为过宽不计）。safetensors 实际格式（8 字节头长度前缀）不在首 4 字节魔数覆盖内——建议第二阶段扩展头部长度 + ASCII JSON 头嗅探，不阻断本批。
- 修复分支尚未合回 `wp-b-runtime-task39`/main，合并节奏由综合决策官裁定。

## 重验结论

**F-1 闭环验收标准 4 条全部通过，F-2/F-3/F-4 修复经代码审查 + 阳性对照确认生效。实现侧闭环完成，无保留意见。**

重验脚本：`docs/acceptance/task40/scripts/f1-twoprocess-real.mjs`（真实模型两进程断言，本轮新增归档）。
