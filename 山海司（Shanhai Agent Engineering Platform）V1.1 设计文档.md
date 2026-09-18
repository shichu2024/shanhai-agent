# 山海司（Shanhai Agent Engineering Platform）V1.1 设计文档

> **文档版本：** V1.1  
> **文档状态：** 设计基线  
> **设计目标：** 从 0 构建具备自我认知、运行验证和受控自我演进能力的 Agent 工程平台  
> **平台名称：** 山海司  
> **英文名称：** Shanhai Agent Engineering Platform  
> **核心理念：** 以规格定义 Agent，以运行时执行 Agent，以证据认识 Agent，以评估约束 Agent，以受控演进改进 Agent。

---

## 1. 项目概述

### 1.1 项目背景

当前 Agent 的构建方式通常::chatgpt-content-reference{index="0"}

Memory
```

这种方式能够快速构建 Demo，但当 Agent 进入真实业务、复杂工程和长期运行场景后，会出现一系列问题：

- Agent 的职责边界不清晰；
- Agent 是否具备某项能力缺乏可靠证据；
- Agent 的工具调用不可控；
- Agent 的运行过程难以追踪；
- Agent 的错误无法系统归因；
- Agent 的版本变化缺少工程化管理；
- Agent 的能力退化无法及时发现；
- Agent 无法根据失败经验形成可验证的改进；
- 多 Agent 协作缺乏统一协议和治理机制；
- Prompt、工具、知识、记忆和模型之间缺乏版本关联；
- Agent 的“自我认知”往往只是模型生成的一段描述，而不是基于运行证据形成的能力画像。

因此，需要将 Agent 从“Prompt 驱动的智能应用”升级为：

> **规格驱动、运行时托管、证据认知、评估约束、受控演进的 Agent 工程系统。**

---

### 1.2 项目愿景

山海司希望构建一套面向 Agent 全生命周期的工程平台，使 Agent 具备以下能力：

1. **可定义**
   - 通过统一 Agent Spec 描述 Agent 的职责、能力、输入、输出、工具和安全边界。

2. **可运行**
   - 通过统一 Runtime 执行 Agent，管理上下文、模型调用、工具调用、状态和任务生命周期。

3. **可观测**
   - 记录 Agent 的完整运行轨迹、工具调用、模型调用、状态变化和异常信息。

4. **可评估**
   - 通过自动化测试、回归测试、安全测试和生产指标判断 Agent 的真实表现。

5. **可认知**
   - 基于运行证据建立 Agent 的能力、限制、风险、依赖和失败画像。

6. **可协作**
   - 支持多个 Agent 之间进行发现、通信、任务委派和结果交接。

7. **可演进**
   - 根据失败记录和评估结果生成改进候选，并通过隔离实验、回归验证和人工审批后发布。

8. **可治理**
   - 对工具、数据、模型、权限、记忆、知识、版本和变更进行统一治理。

---

### 1.3 平台定位

山海司不是单纯的：

- Prompt 管理平台；
- Agent 对话平台；
- Workflow 编排工具；
- Tool 调用网关；
- LLM 应用开发框架；
- 自动生成代码的脚手架。

山海司定位为：

> **Agent Engineering Platform：面向 Agent 设计、构建、运行、评估、认知、协作和演进的工程基础设施。**

---

## 2. V1.1 设计目标与非目标

### 2.1 V1.1 设计目标

V1.1 需要建立以下完整能力链路：

```text
需求定义
  ::chatgpt-content-reference{index="1"}

 Agent 定义模型；
- 统一 Agent 运行时；
- 统一工具注册与执行机制；
- 统一 Agent 版本管理；
- 统一任务与状态管理；
- 统一 Trace、Log、Metric 和 Event；
- 统一评估和回归机制；
- 建立白泽·灵识系统；
- 建立女娲·演进工坊；
- 支持基础多 Agent 协作；
- 建立最小可用的安全治理能力。

---

### 2.2 V1.1 非目标

V1.1 不追求一次性实现以下复杂能力：

- 完全自主修改平台核心 Runtime；
- 完全自动修改安全策略；
- 完全自动发布高风险 Agent；
- 自动重写底层模型；
- 自动构建通用人工智能；
- 自动消除所有幻觉；
- 自动替代人工架构决策；
- 自动执行未经授权的外部操作；
- 让 Agent 自主绕过评估和审批；
- 支持所有模型、工具和协议的全部高级特性。

V1.1 的原则是：

> **先建立可验证、可审计、可回滚的工程闭环，再逐步扩大自动化范围。**

---

## 3. 命名体系：山海经神兽 Agent 架构

### 3.1 命名原则

平台采用《山海经》神兽体系进行命名。

命名分为三层：

```text
平台级
 ::chatgpt-content-reference{index="2"}

t
山海司
├::chatgpt-content-reference{index="3"}

2 核心神兽 Agent 体系

| 神兽 | 英文模块名 | 核心职责 |
|---|---|---|
| 应龙 | Yinglong Orchestrator | 任务总控、Agent 编排、生命周期管理 |
| 麒麟 | Qilin Architect | 需求分析、规格设计、架构规划 |
| 白泽 | Baize Knowledge | 知识管理、事实认知、能力认知 |
| 青龙 | Qinglong Tool Hub | 工具注册、工具发现、工具调用 |
| 朱雀 | Zhuque Studio | 内容生成、结果组织、交互表达 |
| 玄武 | Xuanwu Guard | 安全治理、权限控制、风险拦截 |
| 白虎 | Baihu Evaluation | 测试、评估、质量验证、回归检查 |
| 九尾狐 | Jiuwei Strategy | 策略推演、方案比较、风险分析 |
| 饕餮 | Taotie Data Engine | 数据采集、信息聚合、数据处理 |
| 鲲鹏 | Kunpeng Federation | 长任务、跨 Agent 协作、远程 Agent |
| 夔牛 | Kui Observability | 运行监控、故障诊断、指标分析 |
| 女娲 | Nuwa Builder | Agent 构建、工程生成、受控演进 |

---

### 3.3 神兽职责边界

#### 3.3.1 应龙 Orchestrator

负责：

- 接收用户任务；
- 解析任务目标；
- 选择和编排 Agent；
- 管理任务生命周期；
- 维护任务状态；
- 控制 Agent 间交接；
- 触发评估和审批；
- 处理失败重试和任务恢复。

不负责：

- 直接承担所有领域知识；
- 绕过玄武执行高风险操作；
- 绕过白虎发布未经验证的变更；
- 自行修改平台核心代码。

---

#### 3.3.2 麒麟 Architect

负责：

- 需求分析；
- 任务拆解；
- Agent 角色设计；
- Agent Spec 生成；
- 输入输出契约设计；
- 工具依赖规划；
- 运行策略设计；
- 评估方案设计；
- 任务执行计划生成。

输出：

```text
需求规格
Agent 规格
任务计划
工::chatgpt-content-reference{index="4"}

ge

负责：

- 知识检索；
- 事实核验；
- 知识来源管理；
- 能力注册；
- 能力证据管理；
- 限制条件识别；
- 失败经验关联；
- 记忆可信度管理。

白泽的核心原则：

> **不以 Agent 自己的描述认定能力，而以运行证据、评估结果和人工确认形成能力判断。**

---

#### 3.3.4 青龙 Tool Hub

负责：

- 工具注册；
- 工具发现；
- 工具元数据管理；
- 工具参数校验；
- 工具权限校验；
- 工具调用；
- 超时与重试；
- 幂等控制；
- 工具审计；
- MCP 工具适配。

---

#### 3.3.5 朱雀 Studio

负责：

- 结果生成；
- 文本、结构化数据和多媒体内容组织；
- 输出格式化；
- 结果摘要；
- 用户交互表达；
- 结果解释；
- 最终交付物生成。

朱雀不负责：

- 决定高风险操作是否允许；
- 修改 Agent 核心权限；
- 直接认定结果正确；
- 替代白虎进行质量评估。

---

#### 3.3.6 玄武 Guard

负责：

- 权限控制；
- 数据访问控制；
- 工具调用风险检查；
- Prompt Injection 防护；
- 敏感数据保护；
- 沙箱执行；
- 高风险操作审批；
- 策略执行；
- 安全审计。

玄武是所有外部副作用操作的治理入口。

---

#### 3.3.7 白虎 Evaluation

负责：

- Agent 规格校验；
- 单元测试；
- 场景测试；
- 回归测试；
- 安全测试；
- 输出质量评估；
- 工具调用评估；
- 生产表现评估；
- 版本对比；
- 发布准入判断。

---

#### 3.3.8 九尾狐 Strategy

负责：

- 多方案生成；
- 策略推演；
- 方案比较；
- 风险与收益分析；
- 决策树构建；
- 复杂任务的策略选择；
- 多 Agent 结果辩论；
- 不确定性分析。

九尾狐的输出应尽量包含：

```text
候选方案
适用条件
关键假设
优点
缺点::chatgpt-content-reference{index="5"}

# 3.3.9 饕餮 Data Engine

负责：

- 数据采集；
- 数据清洗；
- 数据转换；
- 多源信息聚合；
- 数据质量检查；
- 数据血缘记录；
- 数据缓存；
- 数据去重；
- 数据预处理。

---

#### 3.3.10 鲲鹏 Federation

负责：

- 跨 Agent 协作；
- 长任务执行；
- 远程 Agent 调用；
- Agent 发现；
- 任务委派；
- 子任务跟踪；
- 跨 Agent 上下文交接；
- 任务恢复；
- 分布式任务协调。

---

#### 3.3.11 夔牛 Observability

负责：

- Trace；
- Span；
- Log；
- Metric；
- Event；
- 性能监控；
- 成本监控；
- 错误聚合；
- 运行状态分析；
- 故障定位；
- 能力趋势分析。

---

#### 3.3.12 女娲 Builder

负责：

- Agent 工程生成；
- Prompt 模板生成；
- Agent Spec 生成；
- 工具接入配置；
- 测试用例生成；
- 版本构建；
- 改进候选生成；
- 受控自我演进；
- Agent 工程资产管理。

女娲不能绕过玄武和白虎直接发布高风险变更。

---

## 4. 总体架构

### 4.1 分层架构

```text
┌───────────────────::chatgpt-content-reference{index="6"}

xt
山海司
├── 山海门户 Shanhai::chatgpt-content-reference{index="7"}

 Project

表示一个 Agent 工程项目。

```text
Project
├── id
├── n::chatgpt-content-reference{index="8"}

 Agent。

```text
Agent
├── id
├── nam::chatgpt-content-reference{index="9"}



表示 Agent 的一个可运行版本。

```text
AgentVersion
├── id
::chatgpt-content-reference{index="10"}

ent 任务执行。

```text
Task
├── id
├── proj::chatgpt-content-reference{index="11"}

Agent 使用的工具。

```text
Tool
├── id
├── name::chatgpt-content-reference{index="12"}

示一次评估任务或评估结果。

```text
Evaluation
├── id
├─::chatgpt-content-reference{index="13"}

一次 Agent 改进过程。

```text
Evolution
├── id
├──::chatgpt-content-reference{index="14"}

### 6.1 设计原则

Agent Spec 是山海司的核心工程契约。

Agent Spec 需要明确：

- Agent 是谁；
- Agent 做什么；
- Agent 不做什么；
- Agent 接收什么；
- Agent 输出什么；
- Agent 可以使用哪些工具；
- Agent 可以访问哪些知识；
- Agent 如何使用记忆；
- Agent 具备哪些能力；
- Agent 存在哪些限制；
- Agent 如何被评估；
- Agent 如何演进。

---

### 6.2 Agent Spec 结构

```text
AgentSpec
├── Iden::chatgpt-content-reference{index="15"}

述 Agent 的身份信息：

- 名称；
- 唯一标识；
- 版本；
- 所属项目；
- 领域；
- 责任人；
- 生命周期状态。

---

### 6.4 Mission

描述 Agent 的核心使命。

示例：

```text
负责将用户需求转换为可执行的 A::chatgpt-content-reference{index="16"}

ilities

明确 Agent 必须负责的事情。

示例：

```text
- 分析用户需求；
- 识别::chatgpt-content-reference{index="17"}

onsibilities

明确 Agent 不允许负责的事情。

示例：

```text
- 不直接执行高风险外部::chatgpt-content-reference{index="18"}

 Contract

定义输入格式：

- 输入字段；
- 字段类型；
- 是否必填；
- 数据来源；
- 约束条件；
- 敏感等级；
- 缺失字段处理方式。

---

### 6.8 Output Contract

定义输出格式：

- 输出结构；
- 必填字段；
- 数据类型；
- 证据要求；
- 置信度；
- 错误格式；
- 不确定性表达；
- 是否允许空结果。

---

### 6.9 Workflow

描述 Agent 的执行流程：

```text
接收输入
  ↓
输入校::chatgpt-content-reference{index="19"}

l Policy

定义：

- 允许使用的模型；
- 模型选择策略；
- 上下文窗口要求；
- 温度和采样策略；
- 最大调用次数；
- 成本预算；
- 降级策略；
- 超时策略；
- 模型故障切换策略。

---

### 6.11 Tool Policy

定义：

- 可用工具列表；
- 工具权限；
- 工具风险等级；
- 工具调用次数；
- 参数校验；
- 超时；
- 重试；
- 幂等；
- 审计；
- 人工审批条件。

---

### 6.12 Memory Policy

定义：

- 允许读取哪些记忆；
- 允许写入哪些记忆；
- 记忆有效期；
- 记忆可信度；
- 记忆更新条件；
- 记忆冲突处理；
- 记忆删除条件；
- 敏感记忆处理规则。

---

### 6.13 Evaluation Policy

定义：

- 必须通过的测试；
- 质量指标；
- 安全指标；
- 回归阈值；
- 成本阈值；
- 延迟阈值；
- 生产监控要求；
- 发布准入条件。

---

### 6.14 Evolution Policy

定义：

- 允许演进的范围；
- 禁止自动修改的内容；
- 改进触发条件；
- 实验规模；
- 审批要求；
- 灰度策略；
- 回滚策略。

---

## 7. 应龙 Runtime 设计

### 7.1 Runtime 职责

应龙 Runtime 是所有 Agent 的统一运行基础设施。

负责：

- 任务创建；
- Agent 版本加载；
- 策略加载；
- 上下文初始化；
- 模型调用；
- 工具调用；
- 状态管理；
- Checkpoint；
- 失败恢复；
- 输出校验；
- 评估触发；
- 运行事件记录。

---

### 7.2 Runtime 核心模块

```text
应龙 Runtime::chatgpt-content-reference{index="20"}

命周期

```text
Create Tas::chatgpt-content-reference{index="21"}

态

```text
Created
Qu::chatgpt-content-reference{index="22"}

time 设计原则

#### 7.5.1 版本固定

一次任务执行必须绑定明确的：

- Agent 版本；
- Prompt 版本；
- 模型版本；
- 工具版本；
- 知识版本；
- 策略版本。

避免同一任务中关键依赖发生不可追踪变化。

---

#### 7.5.2 状态可恢复

长任务需要支持：

- Checkpoint；
- 断点恢复；
- 子任务恢复；
- 工具调用结果缓存；
- 幂等重试；
- 超时恢复；
- 人工审批后继续。

---

#### 7.5.3 策略先于执行

任何模型调用和工具调用都需要经过对应策略检查：

```text
任务请求
  ↓
策::chatgpt-content-reference{index="23"}

ol Hub 设计

### 8.1 工具注册

工具注册信息包括：

- 工具名称；
- 工具描述；
- 输入 Schema；
- 输出 Schema；
- 工具提供方；
- 工具协议；
- 工具版本；
- 权限要求；
- 风险等级；
- 运行环境；
- 超时策略；
- 重试策略；
- 审计要求。

---

### 8.2 工具调用流程

```text
Agent 请求工具::chatgpt-content-reference{index="24"}

险等级

| 等级 | 类型 | 示例 | 默认策略 |
|---|---|---|---|
| L0 | 只读、低风险 | 查询静态知识 | 自动执行 |
| L1 | 只读外部数据 | 查询公开 API | 自动执行并审计 |
| L2 | 有限副作用 | 创建临时文件、提交草稿 | 受策略控制 |
| L3 | 业务副作用 | 修改业务数据、发送消息 | 人工审批 |
| L4 | 高风险操作 | 删除数据、发布生产、资金操作 | 强制审批或禁止 |

---

### 8.4 MCP 适配

青龙 Tool Hub 应支持对 MCP 工具进行统一适配：

- MCP Server 注册；
- Tool Discovery；
- Resource Discovery；
- Tool Schema 转换；
- 权限映射；
- 调用超时；
- 结果标准化；
- 审计记录；
- 服务健康检查。

MCP 作为工具、资源和上下文互操作的重要接入协议，但平台内部仍需保留统一的工具治理模型。

---

## 9. 白泽·灵识系统

### 9.1 系统定位

白泽·灵识系统是山海司的自我认知系统。

英文名称：

> **Baize Capability Registry**

它不只是一个能力清单，而是一个基于证据构建的 Agent 认知系统。

核心问题包括：

- Agent 当前具备什么能力？
- 哪些能力已经被验证？
- 哪些能力只在实验环境中表现良好？
- Agent 在什么条件下容易失败？
- Agent 依赖哪些模型、工具和知识？
- Agent 的能力是否发生退化？
- Agent 是否知道自己的限制？
- Agent 的自我描述与实际表现是否一致？

---

### 9.2 灵识系统组成

```text
白泽·灵识系统
├── Capability Reg::chatgpt-content-reference{index="25"}

text
Capability
├── capabilityI::chatgpt-content-reference{index="26"}

wn
Experimental
Obser::chatgpt-content-reference{index="27"}

nknown | 尚无足够证据 |
| Experimental | 实验中，表现不稳定 |
| Observed | 曾经成功执行过 |
| Supported | 在指定范围内可使用 |
| Verified | 已通过明确评估 |
| Degraded | 能力发生退化 |
| Deprecated | 能力已废弃 |
| NotSupported | 明确不支持 |

---

### 9.5 能力证据来源

能力证据可以来自：

- 单元测试；
- 场景测试；
- 回归测试；
- 生产任务；
- 人工确认；
- 工具调用成功记录；
- 结构化输出校验；
- 安全评估；
- 失败分析；
- 用户反馈；
- 版本对比实验。

证据必须具备：

```text
Evidence
├── sourceType
├── sourceId::chatgpt-content-reference{index="28"}

还应被系统化记录。

示例：

```text
Limitation
├── limitationId
├── de::chatgpt-content-reference{index="29"}

特定参数下容易失败；
- 对缺失字段缺乏可靠推断；
- 只能读取数据，不能修改数据；
- 无法对未经验证的事实做确定性判断。

---

### 9.7 自我认知输出

白泽可以为 Agent 生成结构化能力画像：

```text
当前能力：
- 已验证能力 A；
- 已支持能力 B；
- 实验能力::chatgpt-content-reference{index="30"}

进工坊是山海司的 Agent 工程生成与受控演进系统。

英文名称：

> **Nuwa Evolution Workshop**

负责将：

```text
失败记录
  +
评估结果
  +
用户反馈
  +
能力退化
::chatgpt-content-reference{index="31"}

0.2 演进原则::chatgpt-content-reference{index="32"}

须有明确目标；
3. 改进必须有基线；
4. 改进必须可隔离实验；
5. 改进必须经过回归测试；
6. 改进必须经过安全检查；
7. 高风险变更必须人工审批；
8. 所有变更必须可追踪；
9. 所有发布必须可回滚；
10. 不允许通过修改评估规则来制造“能力提升”。

---

### 10.3 演进闭环

```text
问题发现
  ↓
根因分析
  ↓
改进假设
  ↓
候选变更生::chatgpt-content-reference{index="33"}


- Prompt 模板；
- Prompt 参数；
- Agent 工作流；
- 工具选择策略；
- 工具调用顺序；
- 检索策略；
- 记忆写入策略；
- 输出格式；
- 任务拆解方式；
- 评估数据集；
- 低风险配置；
- Agent Spec 中的非安全关键字段。

---

### 10.5 V1.1 禁止自动演进内容

以下内容不得由 Agent 自动直接修改并发布：

- Runtime 核心执行逻辑；
- 权限系统；
- 安全策略；
- 审批机制；
- 审计逻辑；
- 评估基线；
- 核心数据访问规则；
- 生产发布策略；
- 关键工具的权限范围；
- 回滚机制；
- 平台自身的治理边界。

---

### 10.6 演进候选结构

```text
EvolutionCandidate
├── candidate::chatgpt-content-reference{index="34"}

司支持以下记忆类型：

| 类型 | 说明 |
|---|---|
| 工作记忆 | 当前任务上下文 |
| 情景记忆 | 历史任务与执行过程 |
| 语义记忆 | 已确认的知识与事实 |
| 程序记忆 | 操作流程、策略和经验 |
| 工程记忆 | Agent Spec、版本、变更和评估结果 |

---

### 11.2 记忆可信度状态

```text
Unverified
Observed
Validated
HumanConfirm::chatgpt-content-reference{index="35"}

写入需要考虑：

- 来源；
- 任务上下文；
- 是否经过验证；
- 是否与现有知识冲突；
- 是否包含敏感信息；
- 是否具备长期价值；
- 是否存在过期时间；
- 是否需要人工确认。

---

### 11.4 记忆污染防护

需要防止：

- 错误结果被长期记忆；
- Prompt Injection 被写入记忆；
- 用户临时指令污染长期知识；
- 未验证推测被当作事实；
- 低质量工具结果进入知识库；
- 不同项目之间发生越权记忆共享。

---

## 12. 鲲鹏 Federation：多 Agent 协作

### 12.1 支持的协作模式

#### Single Agent

```text
用户 → 单个 Agent → 结果
```

#### Supervisor-::chatgpt-content-reference{index="36"}

A
 ├── Agent B
 └── Agent ::chatgpt-content-reference{index="37"}

nt C
```

#### Pa::chatgpt-content-reference{index="38"}


任务 ───┼── Agent ::chatgpt-content-reference{index="39"}


反驳 Agent
  ↓
汇::chatgpt-content-reference{index="40"}


  ↓
人工审批
  ↓
继续执行
```

--::chatgpt-content-reference{index="41"}

t Card：

```text
AgentCard
├── identity
├── description
├::chatgpt-content-reference{index="42"}

务 ID；
- 父任务 ID；
- 子任务 ID；
- 发起 Agent；
- 接收 Agent；
- 输入数据；
- 输出契约；
- 当前状态；
- 证据；
- 风险；
- 截止时间；
- 取消条件。

---

## 13. 白虎 Evaluation 设计

### 13.1 评估层级

```text
Spec Evaluation
Engineering Evaluation
R::chatgpt-content-reference{index="43"}

ec 是否完整；
- 职责是否清晰；
- 输入输出是否明确；
- 是否存在职责冲突；
- 工具权限是否合理；
- 是否配置评估策略；
- 是否配置演进边界。

---

### 13.3 Engineering Evaluation

检查：

- 工程结构；
- 配置合法性；
- 依赖完整性；
- 构建结果；
- 类型和 Schema；
- 版本一致性；
- 测试覆盖；
- 部署配置。

---

### 13.4 Runtime Evaluation

检查：

- 任务成功率；
- 工具调用成功率；
- 超时率；
- 重试率；
- 取消成功率；
- 状态恢复成功率；
- 平均延迟；
- Token 消耗；
- 成本；
- 资源使用。

---

### 13.5 Task Evaluation

检查：

- 任务是否完成；
- 输出是否符合契约；
- 结果是否正确；
- 证据是否完整；
- 是否出现幻觉；
- 是否发生越权；
- 是否需要人工修正；
- 是否满足用户目标。

---

### 13.6 Regression Evaluation

用于比较版本变化：

```text
Baseline Version
       vs
Candidate Ver::chatgpt-content-reference{index="44"}

- 延迟；
- 成本；
- 安全事件；
- 人工修正率；
- 已有能力是否退化。

---

### 13.7 核心指标

| 指标 | 说明 |
|---|---|
| Task Success Rate | 任务成功率 |
| Output Validity | 输出契约通过率 |
| Factual Accuracy | 事实准确率 |
| Evidence Completeness | 证据完整度 |
| Hallucination Rate | 幻觉率 |
| Tool Success Rate | 工具调用成功率 |
| Unauthorized Action Rate | 未授权操作率 |
| Human Correction Rate | 人工修正率 |
| Recovery Success Rate | 故障恢复成功率 |
| P50/P95 Latency | 延迟分位数 |
| Token Cost | Token 消耗 |
| Task Cost | 单任务成本 |
| Capability Regression | 能力退化情况 |

---

## 14. 玄武 Guard 安全治理

### 14.1 安全原则

- 最小权限；
- 默认拒绝；
- 显式授权；
- 高风险人工审批；
- 工具调用审计；
- 数据隔离；
- 运行沙箱；
- Prompt Injection 防护；
- 敏感数据保护；
- 全链路可追踪；
- 可回滚。

---

### 14.2 安全控制点

```text
用户输入
  ↓
输入安全检查
  ↓
任务规划
  ↓
工具权限检查
  ↓
参数检查
  ↓
风::chatgpt-content-reference{index="45"}

；
- 工具返回结果中的伪指令；
- 网页内容诱导；
- 恶意知识条目；
- 跨 Agent 指令污染；
- 通过记忆持久化的攻击内容；
- 诱导 Agent 泄露系统提示词；
- 诱导 Agent 绕过权限策略。

---

### 14.4 沙箱机制

高风险执行环境应支持：

- 文件系统隔离；
- 网络访问限制；
- 进程限制；
- 资源配额；
- 执行超时；
- 临时目录；
- 命令白名单；
- 结果审计；
- 执行环境销毁。

---

## 15. 夔牛 Observability 设计

### 15.1 可观测对象

需要观测：

- Task；
- Agent；
- Agent Version；
- Model Call；
- Tool Call；
- Memory Read；
- Memory Write；
- Knowledge Retrieval；
- Approval；
- Evaluation；
- Evolution；
- Error；
- Rollback。

---

### 15.2 Trace 结构

```text
Trace
└── Task Span
    ├── Planning Span
    ├── ::chatgpt-content-reference{index="46"}

tLoaded
ModelCalled
To::chatgpt-content-reference{index="47"}

项目维度；
- 工具维度；
- 模型维度；
- 环境维度；
- 用户任务类型维度；
- 时间维度；
- 错误类型维度；
- 风险等级维度。

---

## 16. 失败分析系统

### 16.1 失败分类

```text
Input Failure
Planning Failure
Model Failure
Tool ::chatgpt-content-reference{index="48"}

failureId
├── taskId
├── agentId::chatgpt-content-reference{index="49"}


- 是任务拆解错误；
- 是模型推理错误；
- 是工具选择错误；
- 是工具参数错误；
- 是知识过期；
- 是记忆污染；
- 是权限策略阻断；
- 是 Runtime 状态丢失；
- 是评估规则不合理；
- 是 Agent Spec 本身设计错误。

---

## 17. 端到端核心闭环

### 17.1 Agent 构建闭环

```text
用户提出需求
  ↓
麒麟 Architect 分析需求
  ↓
白泽 Knowledge 提供知识::chatgpt-content-reference{index="50"}

 Agent Version
  ↓
加载白泽能力画像
::chatgpt-content-reference{index="51"}

白泽关联历史失败
  ↓
九尾狐生成改进策略
  ↓
女::chatgpt-content-reference{index="52"}

onsole/
│   ├── api-se::chatgpt-content-reference{index="53"}

；
- 资源访问；
- 上下文接入；
- 外部能力互操作。

平台内部需要在 MCP 之上增加：

- 工具风险等级；
- 统一权限模型；
- 工具版本管理；
- 调用审计；
- 超时和重试；
- 业务级审批。

---

### 19.2 A2A

用于：

- Agent 发现；
- Agent Card；
- Agent 间通信；
- 任务委派；
- 跨 Agent 协作；
- 远程 Agent 调用。

平台内部需要补充：

- 任务状态管理；
- 责任链；
- 证据交接；
- 风险交接；
- 取消与恢复；
- 跨 Agent 审计。

---

### 19.3 OpenTelemetry

用于：

- Trace；
- Span；
- Metric；
- Log；
- Event；
- 跨服务追踪；
- 性能分析；
- 故障诊断。

---

### 19.4 NIST AI RMF

可用于指导：

- Govern；
- Map；
- Measure；
- Manage。

在山海司中的对应关系：

| NIST AI RMF | 山海司模块 |
|---|---|
| Govern | 玄武 Guard、平台治理 |
| Map | 麒麟 Architect、风险建模 |
| Measure | 白虎 Evaluation、夔牛 Observability |
| Manage | 应龙 Runtime、女娲 Evolution、玄武 Guard |

---

### 19.5 OWASP Agentic AI 安全方向

重点关注：

- Prompt Injection；
- 工具滥用；
- 权限提升；
- 数据泄露；
- 不安全输出处理；
- 记忆污染；
- Agent 间信任边界；
- 过度自主；
- 供应链风险；
- 审计缺失。

---

## 20. 版本与发布管理

### 20.1 Agent 版本组成

一个 Agent 版本不仅包括 Prompt，还包括：

```text
Agent Version
├── Agent Spec
├── Prompt
├── Model Policy
├──::chatgpt-content-reference{index="54"}

ingApproval
Approved
C::chatgpt-content-reference{index="55"}

 回归测试通过；
- 安全测试通过；
- 工具权限明确；
- 风险等级明确；
- 监控已配置；
- 回滚方案已准备；
- 审批记录完整。

---

## 21. 实施路线图

### Phase 0：抽象设计

目标：

- 确定领域模型；
- 确定 Agent Spec；
- 确定命名体系；
- 确定 Runtime 生命周期；
- 确定评估模型；
- 确定安全边界。

---

### Phase 1：最小 Runtime

实现：

- Agent Registry；
- Agent Version；
- Task Manager；
- Model Gateway；
- 基础 Tool Executor；
- State Manager；
- 基础 Trace；
- 基础错误处理。

---

### Phase 2：女娲 Builder

实现：

- Agent Spec 编辑；
- Prompt 模板；
- Agent 工程生成；
- 工具配置；
- 运行配置；
- 版本构建；
- 基础模板市场。

---

### Phase 3：白虎 Evaluation

实现：

- 测试用例；
- 场景测试；
- 输出校验；
- 回归测试；
- 指标计算；
- 评估报告；
- 发布准入。

---

### Phase 4：青龙 Tool Hub 与鲲鹏 Federation

实现：

- 工具注册；
- MCP 接入；
- 工具权限；
- Agent Card；
- 多 Agent 编排；
- 子任务管理；
- 跨 Agent 交接。

---

### Phase 5：白泽·灵识系统

实现：

- Capability Registry；
- Limitation Registry；
- Evidence Store；
- Failure Memory；
- Dependency Profile；
- 能力趋势；
- 自我认知报告。

---

### Phase 6：女娲·演进工坊

实现：

- 失败驱动改进；
- 根因分析；
- 改进假设；
- 候选变更；
- 隔离实验；
- 基线比较；
- 人工审批；
- 灰度发布；
- 回滚。

---

## 22. V1.1 MVP 范围

### 22.1 必须实现

- [ ] Agent Spec；
- [ ] Agent Registry；
- [ ] Agent Version；
- [ ] Task Runtime；
- [ ] Model Gateway；
- [ ] Tool Registry；
- [ ] 基础权限控制；
- [ ] 基础 Memory；
- [ ] Trace；
- [ ] Log；
- [ ] 基础 Evaluation；
- [ ] Capability Profile；
- [ ] Failure Record；
- [ ] 人工审批；
- [ ] 版本发布与回滚。

---

### 22.2 可以延后

- [ ] 复杂多 Agent 辩论；
- [ ] 跨组织 Agent 联邦；
- [ ] 全自动演进；
- [ ] 高级知识图谱；
- [ ] 自动生成复杂 UI；
- [ ] 自动修改 Runtime；
- [ ] 自动调整安全策略；
- [ ] 复杂多模态 Agent；
- [ ] 全量生产数据自动学习。

---

## 23. 关键设计决策

### 23.1 Agent 必须有明确边界

每个 Agent 都必须定义：

```text
负责什么
不负责什么
能使用什么
不能使用什么
什么情况下必须停止
什么情况下必须请求人工审批
```

---

##::chatgpt-content-reference{index="56"}

 用户主观认为可以；

就认定 Agent 已经具备稳定能力。

能力认定应基于：

```text
任务记录
+
评估结果
+
回归结果
+
生产表现
+
人工确认
```

---

### 23.3 自我认知不等::chatgpt-content-reference{index="57"}

生成。

```text
Agent 自述
   ↓
白泽收集证据
   ↓
白虎执行评估
   ↓
夔牛分析运行表现
   ↓
形成能力::chatgpt-content-reference{index="58"}

t
提出改进
  ≠
直接发布改进
```

完整流程必须经过：

```text
证据
→ 假设
→ 实验
→ 回::chatgpt-content-reference{index="59"}



---

### 23::chatgpt-content-reference{index="60"}

过；
- 哪些失败可以忽略；
- 哪些指标可以修改；
- 是否允许发布。

白虎 Evaluation 应尽可能与被评估 Agent 解耦。

---

## 24. 最终产品结构

```text
山海司
│
├── 山海门户
│   ├── Agent 工作台
│   ├── 任务中心
│   ├── 运行::chatgpt-content-reference{index="61"}

程平台，通过规格定义、统一运行时、证据认知、自动评估和受控演进，让 Agent 从一次性 Demo 走向可运行、可验证、可治理、可持续进化的工程系统。**

---

### 25.2 产品介绍

山海司以中国古代神兽体系构建 Agent 工程架构：

- **应龙**负责总控与编排；
- **麒麟**负责需求分析与架构设计；
- **白泽**负责知识与自我认知；
- **青龙**负责工具接入与执行；
- **朱雀**负责结果表达；
- **玄武**负责安全与权限；
- **白虎**负责测试与评估；
- **九尾狐**负责策略推演；
- **饕餮**负责数据处理；
- **鲲鹏**负责跨 Agent 协作；
- **夔牛**负责运行观测；
- **女娲**负责 Agent 构建与受控演进。

最终形成：

```text
麒麟定其形
白泽知其能
应龙统其行
青龙行其事
玄武守其界
白虎验其果
夔牛观其变
女娲促其进
```

---::chatgpt-content-reference{index="62"}

t 工程闭环：

```text
规格定义
  ↓
工程构建
  ↓
统一运行
  ↓
工具执行
  ↓
安全治理
  ↓
运行观测
  ↓
质量::chatgpt-content-reference{index="63"}

可验证

知道自己哪些能力已经被测试和证据支持。

### 可治理

知道自己能做什么、不能做什么，以及何时必须请求人工审批。

### 可演进

能够基于真实失败和评估结果提出改进，并通过实验、验证、审批和回滚完成安全演进。

> **山海司不是让 Agent 无限制地自主进化，而是让 Agent 在明确规格、可靠证据、严格治理和持续评估下，获得可控的工程化成长能力。**