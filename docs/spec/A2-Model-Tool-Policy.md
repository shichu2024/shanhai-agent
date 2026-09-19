# A2 · Model Policy 与 Tool Policy

> **文档状态：** 已冻结（v1 经 WP-A 评审冻结；v1.1 增补经 TASK-43 三角色对抗式流程终审签字，2026-09-19）
> **作者角色：** 方案设计师
> **日期：** 2026-09-19
> **上位依据：** 定稿 §5.2/§6（C3-②③）/§7；03 号 §3.4/§3.5；05 号 备注-2（maxAttempts=3）/P1-3/P2-2/R-3；14 号 ND-2（Schema 子集交集）；**v1.1：《第二阶段设计文档》V0.3（`docs/phase2/01`）D-8/D-9/D-18 + 终审 R-3**
> **WP-B 映射：** `ModelGateway`（预算/重试/usage）、`ToolExecutor`（风险闸门/拦截协议）、`SpecValidator`（子集校验）
> **重建的基线残缺：** §6.8 Output Contract 子集规则、§6.11 Tool Policy、§7.5.3 策略先于执行、§8.2 工具调用流程、§14.2 安全控制点（风险分级）
> **v1.1 修订注记（2026-09-19，TASK-43 终审 D-8 + R-3）：** ① L3 语义由「注册即拒」改为「注册放行（须 approvalPolicy）+ 每次调用独立审批」，L4 维持永久注册即拒；② §4-2 运行期调用点按**当前登记等级**拦截的行为**显式维持**（版本固定原则保护 Spec 语义稳定性，不外推到工具本体已重判定为高风险的执行放行——安全阀，非语义锚）。推导全文：`docs/phase2/01` §4.1。

---

## 1. 设计原则（冻结重述）

1. **默认拒绝：** 未在 Spec 中声明的工具与模型一律不可用；
2. **策略先于执行：** 模型调用、工具调用先过 Policy 检查，后执行；
3. **拦截可举证：** 每次拦截产生结构化记录（T2 断言依赖）；
4. **归因不漂移：** 预算超限记 BudgetExceeded，连续拦截记 PolicyBlocked，不得互换。

## 2. Model Policy 字段表（Spec 内 `modelPolicy`）

| 字段 | 类型 | 必填 | 默认 | 约束与说明 |
|---|---|---|---|---|
| `allowedModels` | string[] | 是 | — | ≥1；⊆ 运行时配置白名单（注册准入校验）；第一位为默认模型 |
| `maxModelCalls` | integer | 是 | —（无默认，强制显式） | 任务级上限，≥1；超出 → `Failed:Runtime(BudgetExceeded)`（C3-② 确定性截停点） |
| `maxTokens` | integer | 是 | —（同上） | 任务级累计 token 上限（输入+输出），≥1；超出同上归因 |
| `maxAttempts` | integer | 否 | **3**（05 号裁定） | 调用级重试上限：**同一逻辑调用**（调用键 = `callNo × kind`，见 §2.1）的最大尝试次数；Running 内新 attempt，不离开 Running |
| `callTimeoutMs` | integer | 否 | 60000 | 单次模型调用超时；超时映射 A4：`Model(call_timeout)`，attempt 级 |
| `taskTimeoutMs` | integer | 否 | 无（不启用） | 任务级超时；启用时超时映射 A4：`Runtime(task_timeout)`，任务终局 |
| `fallbackModel` | string | 否 | — | 必须 ∈ `allowedModels`；主模型失败耗尽 attempts 后切换并记录（可选能力，非降级承诺） |

**usage 记账口径（冻结）：** 以 Provider 返回 usage 为准；缺失时本地估算并在记录上标注 `estimated: true`；预算判定使用「已记账值 + 本次预估」的保守口径。

### 2.1 attempt 计数粒度（P1-1 修订，消除与 A3 的口径矛盾）

05 号备注-2 冻结 `maxAttempts` 为**调用级**。据此钉死计数粒度：

| 计数器 | 粒度 | 存放 | 用途 |
|---|---|---|---|
| **调用级尝试计数** `attemptNo(callNo, kind)` | 每个逻辑调用独立计数（调用键 = `callNo × kind`，`callNo` 为任务内逻辑调用序号，模型/工具各自编号） | 运行期内存 + Trace 事件（A6 信封 `callNo`/`callKind`/`attemptNo`），**不落 TaskRecord** | **重试判定唯一依据**：`attemptNo(callNo, kind) < maxAttempts` 才允许新 attempt；模型重试与工具重试**不共用额度** |
| 任务级 `attemptCount` | 全任务累计尝试次数（所有逻辑调用之和） | TaskRecord（A3 §4） | **仅展示聚合**，不参与任何判定 |

**规则：** ① 判定一律用调用级计数器；② 新逻辑调用（`callNo` 递增）从 `attemptNo=1` 重新起算；③ 任务级 `attemptCount` 在 TaskRecord 中单调递增，供报表与人工检视。

## 3. Tool Policy 字段表（Spec 内 `toolPolicy`）

| 字段 | 类型 | 必填 | 默认 | 约束与说明 |
|---|---|---|---|---|
| `tools` | object[] | 是 | ≥1 | 工具声明数组，元素见下表 |
| `maxConsecutiveDenials` | integer | 否 | **2**（03 号 P1-3） | 连续被拒上限，≥1；超出 → `Failed:Policy(PolicyBlocked)` |

**`tools[]` 元素：**

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `toolId` | string | 是 | 必须已在 Tool Registry 注册（注册准入校验；C3-① 拒绝点） |
| `riskLevel` | string | 是 | `L0–L4`，且与 Tool Registry 登记等级一致（不一致 → 注册拒绝） |
| `controlledFields` | object | L2 必填 | R-3 裁定：L2 工具必须声明 `paramRanges`（参数范围）与/或 `targetWhitelist`（目标白名单），二至少一 |
| `notes` | string | 否 | 声明理由，供审计阅读 |

## 4. 风险闸门（L0–L4）

| 等级 | 语义 | 第一阶段处置 |
|---|---|---|
| L0 | 纯只读、无副作用 | 放行，不额外审计（正常 ToolCall 事件即记录） |
| L1 | 低风险、可逆副作用 | 放行 + 强制审计 |
| L2 | 受控副作用 | 放行 + 强制审计 + **必须声明受控字段**（缺声明 → 注册拒绝） |
| L3 | 高风险、不可逆 | **注册即拒**（D-3 裁决落地，见下） |
| L4 | 禁区（写入安全域、凭据操作等） | **注册即拒**（同上） |

**规则细化（D-3 修订：接受决策官初裁与反方立场，注册即拒；v1.1 修订见第 3 条）：**

1. **注册时（v1 行为，L4 永久维持）：** Spec 声明 L4 工具 → 注册拒绝，写 `RejectedRequest(kind='spec_registration')`，错误信息指名 `toolPolicy.tools[n].toolId` 与其登记等级——不允许「永不能兑现的声明」进入正式 Spec（与底线 1「Spec 必须被强制执行」对齐）；
2. **运行期防御纵深（v1 行为维持；§4-2 v1.1 修订注记——TASK-43 终审 R-3 裁定显式维持本条，防实现漂移）：** 若工具在 Spec 注册后被 Tool Registry 重新登记为更高等级，任务时防御性复验（A1 §4）按快照与当前登记不一致 → `Created → Failed: Spec(defensive_revalidation_failed)`，**不改道转 ApprovalRequest**（隐式改道违反默认拒绝；工具等级升级的正确路径 = 重登记 + Spec 新版本显式声明 approvalPolicy）；若等级变更发生在任务时复验之后、调用之前的窗口，`ToolExecutor` 在调用点按**当前登记等级**闸门拦截（`risk_level_blocked` 可达）——**v1.1 显式维持此第一阶段行为**：版本固定原则保护的是 Spec 语义稳定性，不外推到「工具本体已被重判定为高风险不可逆仍在飞任务按旧等级执行」；与「等级只能升不能降」登记原则同向。**可见性（v1.1，终审 R-5）：** report 旁挂「受工具升级影响的 Spec」只读单列（Spec 声明等级 < 当前登记等级的存量引用清单）；
3. **【v1.1 修订注记，2026-09-19，TASK-43 终审 D-8/D-9/D-18】第二阶段语义落地：**
   - **L3 注册放行**：仅当 Spec 声明 `approvalPolicy.mode=onHighRisk`（A1 §2.2）；未声明而引用 L3 工具 → **仍注册拒绝**（防「声明了却无审批路径」的死声明）；
   - **L3 运行期审批闸门**：每次 L3 调用独立审批——写 ApprovalRequest + PauseSnapshot（A3 §5/§5a）→ `Running → Paused`；approve 只写 decision（任务保持 Paused），`Paused → Running` 迁移权归 `task run --resume` 进程（D-18）；deny / 超时-deny 均为任务级终局 Cancelled；
   - **L4 维持注册即拒，永久**（写入安全域、凭据操作不属于「人工可审」范畴）。

## 5. 拦截反馈协议（policy_denied，03 号 §3.5 冻结）

返回给模型的结构化结果：

```json
{ "result": "policy_denied", "toolId": "...", "reasonCode": "...", "message": "..." }
```

**`reasonCode` 枚举（封闭集）：**

| reasonCode | 触发 |
|---|---|
| `risk_level_blocked` | L3/L4 工具请求 |
| `not_declared_in_spec` | 工具存在但未在该 Spec 声明（默认拒绝） |
| `param_out_of_range` | L2 受控字段：参数越界 |
| `target_not_whitelisted` | L2 受控字段：目标不在白名单 |

> **P2-1 修订：** 原 `budget_exhausted` reasonCode 已删除——预算超限在模型调用**前置检查**即任务终局（§7），不存在「向前置检查点之前的模型返回 policy_denied」的窗口，属死枚举。预算终局归因唯一为 `Runtime(BudgetExceeded)`。

**计数规则：** `consecutiveDenialCount` 从任务 Running 起累计，任一次成功工具调用清零；达到 `maxConsecutiveDenials` → `Running → Failed`，failureClass = `Policy(PolicyBlocked)`，**归因不漂移**（C3-③ 验收点）。

## 6. 输出契约 Schema 子集规则（14 号 ND-2，冻结为 Spec 设计规则）

**背景：** OpenAI strict mode 与 Anthropic 严格校验各自只支持 JSON Schema 的不同子集；Provider 侧合规 ≠ 本地校验通过。A2 规定契约 Schema 使用**两家支持子集的交集**。

| 类别 | 内容 |
|---|---|
| **允许关键字** | `type`、`properties`、`required`、`items`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`minItems`、`maxItems`、`title`、`description`、`additionalProperties: false`（仅允许 false 字面值）、顶层 `$schema`/`$defs`+`$ref`（同文档内引用，禁止递归） |
| **禁止关键字** | `patternProperties`、`if`/`then`/`else`、`not`、`unevaluatedProperties`、`unevaluatedItems`、`allOf`、`oneOf`、`pattern`（正则）、`multipleOf`、`dependentSchemas` 等条件逻辑类；`additionalProperties: true` 或缺省（要求显式 false，保证闭合对象） |
| **format 白名单** | 仅 `date-time`、`date`、`time`、`email`、`uuid`（两家文档明示支持集的交集；其余 format 一律禁止） |
| **强制规则** | 顶层 `type: "object"`；对象节点必须显式 `additionalProperties: false`；字符串长度必须同时给 `minLength`（≥0）与 `maxLength`（防截断不可判定） |
| **校验位置** | 注册时（准入）由 SpecValidator 执行子集校验，越子集即拒绝注册 |
| **效力范围** | `inputContract` 与 `outputContract` 同时受约束（对称，防输入侧同样不可移植） |

> **待验证【设计假设】：** 上述交集为依据两家 2026-09 公开文档的整理；WP-B 接入真实 Provider 后须以探针用例实测校准，若实测收窄则收紧本表（只许更严，不许放松）。

## 7. 预算检查流程（ModelGateway，正常/异常）

```text
调用请求 → 前置检查（callNo+1 > maxModelCalls？→ Failed:Runtime(BudgetExceeded) 终局）
        → 预估 token + 已记账 > maxTokens？→ 同上终局
        → 执行调用（callTimeoutMs）
        → 成功：记账 usage（缺失则估算标 estimated）
        → 失败/超时：attempt < maxAttempts？→ 新 attempt（A3 Running 自环）
                    → 耗尽：Failed:Model(...)（A4 子类）
```

**边界：** 预算终局发生在「调用前检查」时记 `Runtime(BudgetExceeded)`；若 Provider 侧因超额报错，则按 A4 `Model(provider_infra)` 归因——两者以检查点位置区分，不混记。

**D-2 附条件落地（反方条件 + 决策官裁决）：** `BudgetExceeded` 终局必须附**调用构成明细**，写入 FailureRecord.`expectedVsActual`：

```json
{ "budget": {"maxModelCalls": 10, "maxTokens": 50000},
  "consumed": {"modelCalls": 10, "tokens": 41230, "estimatedTokens": 1200},
  "attemptBreakdown": {"succeeded": 6, "failedBySubClass": {"provider_infra": 3, "call_timeout": 1}} }
```

作用：若明细显示失败 attempt 集中于 `provider_infra`（infra 风暴），归因虽仍机械记 BudgetExceeded（触发路径决定），但明细使「预算被 infra 消耗」一眼可辨——归因不漂移与归因可解释同时成立。

## 8. 工具调用流程（ToolExecutor，正常/异常）

```text
模型请求工具 → toolId 在 Spec 声明？否 → policy_denied(not_declared_in_spec)
            → 风险等级 L4，或 L3 而未声明 approvalPolicy？是 → policy_denied(risk_level_blocked)
            → L3 且 approvalPolicy=onHighRisk（v1.1）→ 写 ApprovalRequest + PauseSnapshot
                → Running → Paused（run 进程退出；approve 只写 decision，
                   Paused→Running 迁移权归 --resume 进程，D-18）
                → deny/超时-deny → Paused → Cancelled（任务级终局，无 approval_denied reasonCode）
            → L2 受控字段校验（paramRanges / targetWhitelist）失败 → policy_denied(param_out_of_range | target_not_whitelisted)
            → 放行：执行（L1/L2 写审计记录）→ ToolCall 事件（A6）
            → 拦截：policy_denied 返回模型 + consecutiveDenialCount+1
            → 计数达 maxConsecutiveDenials → Failed:Policy(PolicyBlocked) 终局
```

**reasonCode 封闭集（v1.1 注记）：维持 §4 原四值不变**（`risk_level_blocked / not_declared_in_spec / param_out_of_range / target_not_whitelisted`）——审批路径终局走 Cancelled/Failed 状态迁移，不经 policy_denied 反馈（deny 后模型不再获得执行机会，`approval_denied` 为死枚举，显式不设）。

异常：工具执行自身失败/超时 → attempt 级 `Tool(...)` 记录（A4），按 `maxAttempts` 逻辑处理。

## 9. 关键假设 / 风险 / 待验证

| # | 内容 | 属性 |
|---|---|---|
| 1 | Schema 交集表与两家实际支持集一致 | 待验证（WP-B 探针实测，只收紧不放松） |
| 2 | `maxModelCalls` 计数口径 = 「已发起的模型调用次数」（含失败 attempt） | 设计假设（D-2 已裁决维持；调用构成明细见 §7） |
| 3 | 本地 token 估算误差可能造成预算判定偏差 | 已知接受（estimated 标注 + 保守口径缓解） |
| 4 | `format` 白名单过窄可能抬高 Spec 编写成本 | 已知取舍（可移植性优先；enum 可替代多数 format 场景） |

## 10. WP-B 实现输入映射

| WP-B 模块 | 消费本文内容 |
|---|---|
| `ModelGateway` | §2 字段表 → 预算/重试/超时配置结构；§2.1 调用级计数器；§7 流程 |
| `ToolExecutor` | §3–§5、§8 → 闸门顺序、policy_denied 构造、连续拦截计数 |
| `SpecValidator` | §6 子集表 → 契约校验器（注册准入）+ 任务时防御性重复 |
| `Registry` | 附录 A Tool Registry 表结构 + 注册/登记流程 |
| WP-C（验收） | C3-② ← §2/§7；C3-③ ← §5/§8；实验（11 号 §2.2 策略 A/B）← §6 |

---

## 附录 A · Tool Registry 最小字段表（P1-4 修订）

**WP-B 模块挂靠：Tool Registry 不是独立模块，挂靠 `Registry`（与 Agent Registry 同模块内的独立表 + 独立登记命令）。** 四处依赖方（A1 注册校验 / A2 §3 闸门 / A6 bindingSnapshot / C3-①）全部经 `Registry` 读写。

| 字段 | 类型 | 约束 |
|---|---|---|
| `toolId` | TEXT PK | `^[a-z][a-z0-9-]{1,63}$` |
| `name` | TEXT | 展示名 |
| `kind` | TEXT | `builtin / external`（第一阶段仅 builtin：进程内函数，经 ToolExecutor 注册表调用） |
| `riskLevel` | TEXT | `L0–L4`；**等级只能升不能降**（防降级洗白：重登记低等级须走人工库维护，不在 CLI 语义内） |
| `implVersion` | TEXT | 实现版本号（semver）；每次工具实现变更必须重新登记，`implVersion` 递增——A6 `bindingSnapshot.toolVersions` 的数据源（T1 工具版本关联依赖） |
| `paramSchema` | TEXT | 参数 JSON Schema（受 A2 §6 同一子集规则约束） |
| `controlledFieldsSchema` | TEXT NULL | L2 工具必填：声明其支持的 `paramRanges`/`targetWhitelist` 语法位（Spec 声明须与此匹配） |
| `status` | TEXT | `active / retired`；retired 后 Spec 注册引用 → 拒绝（悬空引用防线），存量任务防御性复验 → `Created → Failed: Spec(defensive_revalidation_failed)` |
| `registeredAt` | TEXT | RFC3339 |

**登记与变更流程：** 内置工具随 Runtime 代码库登记（`implVersion` 与代码 commit 关联）；登记/重登记均为追加审计事件（A6 §5 扩展：`tool_registered` / `tool_reregistered`），等级与 implVersion 变更即触发存量 Spec 的防御性复验条件（A1 §4）。
