# A2 · Model Policy 与 Tool Policy

> **文档状态：** WP-A 交付物 A2（待三角色评审）
> **作者角色：** 方案设计师
> **日期：** 2026-09-19
> **上位依据：** 定稿 §5.2/§6（C3-②③）/§7；03 号 §3.4/§3.5；05 号 备注-2（maxAttempts=3）/P1-3/P2-2/R-3；14 号 ND-2（Schema 子集交集）
> **WP-B 映射：** `ModelGateway`（预算/重试/usage）、`ToolExecutor`（风险闸门/拦截协议）、`SpecValidator`（子集校验）
> **重建的基线残缺：** §6.8 Output Contract 子集规则、§6.11 Tool Policy、§7.5.3 策略先于执行、§8.2 工具调用流程、§14.2 安全控制点（风险分级）

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
| `maxAttempts` | integer | 否 | **3**（05 号裁定） | 调用级重试上限：同一逻辑调用的最大尝试次数；Running 内新 attempt，不离开 Running |
| `callTimeoutMs` | integer | 否 | 60000 | 单次模型调用超时；超时映射 A4：`Model(call_timeout)`，attempt 级 |
| `taskTimeoutMs` | integer | 否 | 无（不启用） | 任务级超时；启用时超时映射 A4：`Runtime(task_timeout)`，任务终局 |
| `fallbackModel` | string | 否 | — | 必须 ∈ `allowedModels`；主模型失败耗尽 attempts 后切换并记录（可选能力，非降级承诺） |

**usage 记账口径（冻结）：** 以 Provider 返回 usage 为准；缺失时本地估算并在记录上标注 `estimated: true`；预算判定使用「已记账值 + 本次预估」的保守口径。

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
| L3 | 高风险、不可逆 | **拦截**（policy_denied） |
| L4 | 禁区（写入安全域、凭据操作等） | **拦截**（policy_denied） |

**规则细化：** 声明 L3/L4 工具的 Spec **注册可通过**（引用完整性成立即可，第二阶段审批流的预留语义），但运行期任何对该工具的调用请求**一律拦截**——「拦截即成功」，不是系统故障。反方可挑战此选择（备选：注册即拒）；当前依据是 01 号 §3.2-4「L3/L4 仅定义枚举与拦截逻辑」。

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
| `budget_exhausted` | 预算判定拒绝的前置拦截（注意：终局归因仍为 Runtime(BudgetExceeded)，见 §7） |

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

## 8. 工具调用流程（ToolExecutor，正常/异常）

```text
模型请求工具 → toolId 在 Spec 声明？否 → policy_denied(not_declared_in_spec)
            → 风险等级 L3/L4？是 → policy_denied(risk_level_blocked)
            → L2 受控字段校验（paramRanges / targetWhitelist）失败 → policy_denied(param_out_of_range | target_not_whitelisted)
            → 放行：执行（L1/L2 写审计记录）→ ToolCall 事件（A6）
            → 拦截：policy_denied 返回模型 + consecutiveDenialCount+1
            → 计数达 maxConsecutiveDenials → Failed:Policy(PolicyBlocked) 终局
```

异常：工具执行自身失败/超时 → attempt 级 `Tool(...)` 记录（A4），按 `maxAttempts` 逻辑处理。

## 9. 关键假设 / 风险 / 待验证

| # | 内容 | 属性 |
|---|---|---|
| 1 | Schema 交集表与两家实际支持集一致 | 待验证（WP-B 探针实测，只收紧不放松） |
| 2 | `maxModelCalls` 计数口径 = 「已发起的模型调用次数」（含失败 attempt） | 设计假设（防恶意重试绕预算；欢迎挑战） |
| 3 | L3/L4 注册放行、运行拦截（vs 注册即拒） | 设计决策点（§4 已列反方挑战入口） |
| 4 | 本地 token 估算误差可能造成预算判定偏差 | 已知接受（estimated 标注 + 保守口径缓解） |
| 5 | `format` 白名单过窄可能抬高 Spec 编写成本 | 已知取舍（可移植性优先；enum 可替代多数 format 场景） |

## 10. WP-B 实现输入映射

| WP-B 模块 | 消费本文内容 |
|---|---|
| `ModelGateway` | §2 字段表 → 预算/重试/超时配置结构；§7 流程 |
| `ToolExecutor` | §3–§5、§8 → 闸门顺序、policy_denied 构造、连续拦截计数 |
| `SpecValidator` | §6 子集表 → 契约校验器（注册准入）+ 任务时防御性重复 |
| WP-C（验收） | C3-② ← §2/§7；C3-③ ← §5/§8；实验（11 号 §2.2 策略 A/B）← §6 |
