# LangChain / LangGraph 智能体渐进式重构执行计划

> 文档用途：本文件是可直接交给 Codex 逐阶段执行的实施规格，不是一次性重写方案。
>
> 执行原则：一次只执行一个阶段中的一个工作包；工作包验收通过后继续当前阶段，当前阶段全部验收通过并提交阶段报告后，才能进入下一阶段。

## 1. 最终目标

在不破坏现有智能体能力的前提下，使用 LangChain 统一模型、消息和工具接口，使用 LangGraph 承担智能体流程编排、状态推进、中断恢复和多智能体协作，并通过 Feature Flag、shadow 对照和稳定分桶逐步替换现有运行路径。

重构完成后应达到以下效果：

- Main、Planner、Explorer、Developer、Tester 的职责和调用关系可以通过 LangGraph 明确表达。
- 模型调用通过 LangChain 兼容层进入现有 Provider Gateway，不绑定单一模型供应商。
- LangChain Tool 只能通过现有工具注册中心和策略层执行，不能绕过权限、作用域、审批和证据检查。
- LangGraph 可以暂停等待审批，并能在服务重启后从任务会话恢复。
- 文件修改继续使用现有 Patch、Safe Editor、Checkpoint 和回滚能力。
- 前端继续消费现有 `AgentStep`、任务计划和任务状态协议，不直接依赖 LangChain/LangGraph 类型。
- 每个阶段都有独立自动化测试、验收命令、完成定义和紧急回退路径。
- 最终可以按 `legacy -> shadow -> internal -> 10% -> 50% -> all` 顺序灰度切换。

## 2. 当前项目事实与迁移约束

Codex 开始任何阶段前必须重新读取实际代码确认以下事实，不能仅依赖本计划中的文件名：

- 项目是 pnpm monorepo，服务端位于 `apps/server`，前端位于 `apps/web`。
- 当前已有 Main、Planner、Explorer、Developer、Tester 多智能体实现。
- 当前已有自定义 Runtime、工具注册、权限控制、任务工作流、任务会话、Patch、审批、Checkpoint、回滚、上下文预算、重规划、完成证据和观测能力。
- 当前模型入口包含 Provider Gateway、OpenAI-compatible Provider 和模型选择能力。
- 当前已有 Feature Flag、稳定分桶、shadow 对照和大量阶段验收脚本，应优先复用。
- 工作区可能存在用户未提交修改。Codex 不得覆盖、回滚或顺手重构这些修改。

重点保护的现有边界包括但不限于：

- `apps/server/src/agentRuntime.ts`
- `apps/server/src/agentTools.ts`
- `apps/server/src/agentToolRegistry.ts`
- `apps/server/src/agentModes.ts`
- `apps/server/src/runtime/`
- `apps/server/src/taskWorkflow/`
- `apps/server/src/taskSessionStore.ts`
- `apps/server/src/agentCompletionPolicy.ts`
- `apps/server/src/safeEditor/`
- `apps/server/src/checkpointStore.ts`
- `apps/server/src/providers/`
- `apps/server/src/modelGatewayClient.ts`

## 3. 跨阶段架构不变量

以下规则从阶段 0 到最终切换始终成立，任何阶段都不得以“临时实现”为理由绕过：

1. **业务状态真相不变**：`TaskSession` 仍是任务业务状态的权威来源；LangGraph checkpoint 只负责流程执行状态。
2. **文件快照不变**：现有文件 Checkpoint 继续负责修改前后内容和回滚；不能用 Graph checkpoint 代替文件快照。
3. **权限不下沉给模型**：模型选择工具不等于获得执行权限，真实权限必须由现有 Registry、Permission、Workflow 和 Scope 策略判断。
4. **写入必须可审阅**：常规修改优先生成 Patch，未经批准不得写入工作区。
5. **副作用必须幂等**：文件写入、Patch 应用和命令执行必须带稳定 action ID，恢复或重复请求不能重复执行。
6. **中断前无不可重复副作用**：LangGraph `interrupt` 恢复时可能从节点开头重新执行，因此审批中断必须与真实副作用分离为不同节点。
7. **类型不扩散**：LangChain/LangGraph 类型只允许出现在适配层和图实现中，现有业务层继续使用项目自己的契约。
8. **前端协议稳定**：前端不直接消费 LangGraph 原始事件；必须先转换为现有 `AgentStep` 和任务状态。
9. **循环必须有界**：模型循环、工具循环、重试、重规划、Developer/Tester 回路和审批恢复都必须有明确上限。
10. **可立即回退**：新执行路径必须由 Feature Flag 保护；关闭 Flag 后无需迁移数据即可继续使用 Legacy。
11. **测试不调用生产服务**：单元和集成测试使用 Fake Model、Mock Tool、临时工作区和内存 Checkpointer。
12. **完成语义不变**：LangGraph 不得自行宣布任务成功，最终结果仍需通过现有完成证据和终态策略。

## 4. Codex 阶段执行协议

用户向 Codex 下达“执行阶段 N”时，Codex必须遵循以下顺序。

### 4.1 开始前

1. 使用 `rg --files -g AGENTS.md` 查找仓库实际存在的规则文件并完整读取；如果仓库中不存在 `AGENTS.md`，继续遵守当前对话已提供的规则，不能因为文件缺失而停止。
2. 执行 `git status --short`，识别用户已有修改。
3. 使用 `rg` 检索当前实现、测试、Feature Flag、脚本和可复用类型。
4. 阅读当前阶段直接相关的实现和测试，不凭文件名猜测接口。
5. 只有上一阶段及其验收命令实际存在时才运行；阶段 0 或仓库尚未创建迁移脚本时，运行最接近当前范围的现有测试作为起点基线。
6. 输出技术栈分析、依赖计划和本阶段文件计划后再修改代码。
7. 如果发现本阶段前置条件未满足，停止实施并报告具体缺口，不跨阶段补做大范围工作。

### 4.2 实施中

1. 修改范围只覆盖当前阶段。
2. 优先增加适配器，不直接大改现有 Runtime。
3. 新增核心代码添加必要中文注释。
4. 每完成一个契约或节点立即补测试。
5. 不手动编辑锁文件；新增依赖必须使用当前 pnpm 包管理器。
6. 不删除 Legacy 路径，不默认开启未完成的新路径。
7. 发现计划与实际代码冲突时，以实际代码为准，并在阶段报告中记录偏差和原因。

### 4.3 完成后

1. 运行本阶段专项测试。
2. 运行上一阶段累计回归。
3. 运行服务端类型检查。
4. 根据改动范围运行服务端全量测试、前端类型检查和构建。
5. 执行 `git diff --check`。
6. 更新阶段状态和阶段报告。
7. 报告实际修改文件、测试结果、已知风险、回退方式和下一阶段是否可开始。
8. 未通过完成定义时不得声称阶段完成。

### 4.4 防止 Codex 出现 `Request blocked` 的执行约束

`Request blocked` 可能来自不同层级，不能把它们混成一种错误：

- **Codex/模型请求被平台阻断**：请求过大、输入包含敏感信息、短时间提交过多大请求，或工具调用参数触发平台安全限制。
- **项目工具被策略阻断**：命令命中 `commandPolicy`、写入越权、审批缺失或工具不在当前 Registry 中。这是预期业务门禁，不等同于平台错误。
- **任务状态为 `blocked`**：缺少用户选择、权限或外部条件。这是项目终态语义，也不等同于平台错误。

为了降低第一类错误发生概率，Codex 必须遵守以下规则：

1. **一个任务只执行一个工作包**：禁止在单次 Codex 请求中实现完整阶段，更禁止一次实现多个阶段。
2. **控制变更规模**：单个工作包默认修改不超过 6 个生产文件，新增/修改代码建议不超过 600 行；超过时继续拆包。测试夹具的机械数据可单独成包。
3. **控制读取规模**：先用 `rg` 定位，再按相关片段读取；禁止一次输出整个大型目录、整个锁文件、完整日志或数千行源码。
4. **控制工具输出**：命令使用聚焦参数和合理输出上限；测试失败时先查看摘要，再读取单个失败测试的详细信息。
5. **禁止传递敏感信息**：不得读取或输出 `.env`、API Key、访问令牌、Cookie、私钥、完整请求头或用户凭证。只允许读取 `.env.example` 和脱敏配置名。
6. **禁止构造高风险命令**：不得执行包含项目 `commandPolicy` 禁止模式的命令；不得用 shell 拼接递归删除、权限提升或系统级操作。
7. **安装依赖单独成包**：依赖安装、适配器实现和业务接管不得放在同一个工作包。安装前先检查 manifest 和锁文件中的现有版本。
8. **避免超长命令链**：每次只运行一个明确验证命令；不要把全量测试、构建和多个 PowerShell 脚本拼成一条复杂 shell 命令。
9. **先专项后全量**：开发中运行单文件或单模块测试；工作包结束运行阶段专项测试；阶段结束才运行累计回归和全量测试。
10. **长任务分段等待**：测试或构建超过工具单次等待时间时，保留会话并轮询输出，不重复启动相同命令。
11. **避免重复提交相同请求**：模型、工具或命令失败后先分析错误类别，再调整输入；不得原样连续重试。
12. **不把源码放入阶段报告**：报告只记录文件路径、职责、命令、结果和指标，避免把大量 diff、Prompt 或日志重新发送给模型。

每个阶段开始时，Codex 必须先把该阶段拆成工作包，并满足下面的固定顺序：

```text
A. 契约/类型与测试夹具
B. 最小实现
C. 接入点与 Feature Flag
D. 专项验收与阶段报告
```

复杂阶段可以继续拆为 `A1/A2`、`B1/B2`，但禁止把后续阶段内容提前塞入当前工作包。

### 4.5 工作包完成定义

单个工作包只有满足以下条件才可以结束：

- 当前工作包的目标可以用一句话描述，并已经达成。
- 修改文件和实际 diff 没有超出声明范围。
- 聚焦测试和类型检查通过，或已记录与当前改动无关的既有失败证据。
- 没有遗留半接入的生产入口；未完成能力保持不可达或 Flag 关闭。
- `git diff --check` 通过。
- 已记录下一工作包所需输入，不依赖 Codex 记住大量未持久化上下文。

### 4.6 遇到 `Request blocked` 时的恢复协议

如果确实出现字面上的 `Request blocked`，Codex 不得原样重试，也不得把阶段直接标记为业务 `blocked`。应按以下顺序处理：

1. 停止当前请求，不启动新的写入或命令。
2. 使用只读检查确认最后一次成功修改和当前 `git status --short`。
3. 将错误分类为平台请求阻断、项目策略阻断或任务业务阻断。
4. 如果是平台请求阻断，将当前工作包缩小为原来的一半，减少读取文件和输出内容，并移除任何敏感配置、长日志或大段源码。
5. 如果是项目策略阻断，读取对应 Policy 的 reason，使用允许的项目 API、审批流程或安全命令解决；不得绕过 Policy。
6. 如果是业务阻断，只在确实缺少用户选择、权限或外部状态时记录 `blocked`。
7. 把恢复点写入当前阶段报告，包括已完成文件、未完成项、最后通过的测试和下一条安全命令。
8. 从最小未完成工作包继续，不重复已成功的依赖安装、文件写入或迁移操作。

以下行为明确禁止：

- 连续原样重试同一个被阻断请求。
- 为绕过阻断而关闭权限、安全编辑、命令策略或审批。
- 把 `Request blocked` 当成测试通过或阶段完成。
- 在不确认磁盘状态的情况下重新应用同一 Patch。
- 将真实密钥或完整 `.env` 放进提示词寻求诊断。

## 5. 阶段依赖关系

```text
阶段 0：基线与迁移骨架
  └─ 阶段 1：LangChain 契约适配
      └─ 阶段 2：只读 LangChain Agent
          └─ 阶段 3：Planner / Explorer LangGraph 子图
              └─ 阶段 4：持久化、事件和 Interrupt
                  └─ 阶段 5：Developer Patch-only 子图
                      └─ 阶段 6：审批后写入与幂等恢复
                          └─ 阶段 7：Tester、重规划与完成闭环
                              └─ 阶段 8：Main Graph 与前端兼容
                                  └─ 阶段 9：Shadow、灰度和全量切换
                                      └─ 阶段 10：Legacy 收敛与清理
```

除非本计划明确说明可并行，否则阶段之间是硬依赖关系。测试补充、文档更新和观测代码属于各阶段内部工作，不能推迟到最后统一处理。

### 5.1 各阶段默认工作包

为避免单次 Codex 请求过大，各阶段默认拆分如下。执行时可进一步拆小，不能合并成更大的单次请求。

| 阶段 | 工作包 | 单次交付效果 |
|---|---|---|
| 0 | 0A | 初始化迁移状态、基线场景契约、Fake Model 和结果归一化 |
| 0 | 0B | Legacy 基线 Runner 与聚焦测试 |
| 0 | 0C | 关闭状态 Flag、验收脚本和阶段报告 |
| 1 | 1A | 依赖审计；确有缺失时单独安装依赖 |
| 1 | 1B | 消息与响应适配器及契约测试 |
| 1 | 1C | 模型适配器及取消、usage、fallback 测试 |
| 1 | 1D | Tool/schema 适配器、阶段验收和报告 |
| 2 | 2A | 只读 Agent 状态和受限 Tool Registry |
| 2 | 2B | 最小只读 Agent Loop 和聚焦测试 |
| 2 | 2C | runtime selector、shadow/internal Flag |
| 2 | 2D | 安全与只读验收、阶段报告 |
| 3 | 3A | Graph State、节点输入输出契约和 reducers |
| 3 | 3B | Planner 节点、计划校验和条件边 |
| 3 | 3C | Explorer fan-out/fan-in 和并发限制 |
| 3 | 3D | bounded replan、Graph 集成验收和报告 |
| 4 | 4A | thread identity 和 Checkpointer 契约 |
| 4 | 4B | 只读图持久化与重启恢复 |
| 4 | 4C | Graph event 到 AgentStep 的转换 |
| 4 | 4D | 模拟 Interrupt/resume、幂等测试和报告 |
| 5 | 5A | Developer State 与证据门禁节点 |
| 5 | 5B | 修改计划与 write scope 校验 |
| 5 | 5C | Patch-only 生成、来源追踪和验证 |
| 5 | 5D | Safe Editor/Diff 契约验收和报告 |
| 6 | 6A | 审批决策和稳定 action ID |
| 6 | 6B | 独立 Patch 应用副作用节点 |
| 6 | 6C | 文件 Checkpoint、重启与重复 resume 恢复 |
| 6 | 6D | 写入安全、回滚验收和报告 |
| 7 | 7A | Tester State、验证计划和命令边界 |
| 7 | 7B | 测试执行与失败分类 |
| 7 | 7C | Developer/Tester/Replan 有界循环 |
| 7 | 7D | 完成证据、终态验收和报告 |
| 8 | 8A | Main Graph 路由和子图组合 |
| 8 | 8B | API/TaskSession 接入和 internal selector |
| 8 | 8C | 流式事件、审批和刷新恢复兼容 |
| 8 | 8D | 双端端到端验收和报告 |
| 9 | 9A | Shadow 对照器和脱敏指标 |
| 9 | 9B | 稳定分桶和只读灰度 |
| 9 | 9C | 写任务灰度与自动回退门禁 |
| 9 | 9D | 全量观察、回退演练和报告 |
| 10 | 10A | Legacy 调用方审计和待删除清单 |
| 10 | 10B | 分模块删除重复编排代码 |
| 10 | 10C | 测试、文档和运维手册收敛 |
| 10 | 10D | 最终全量验收和报告 |

工作包状态必须写入 `docs/langchain-langgraph/migration-status.md`。该文件由工作包 0A 创建；在它尚不存在时，Codex 直接选择 0A，并以本计划的工作包表初始化状态。后续 Codex 才根据状态文件选择第一个状态为 `pending` 且前置工作包均为 `completed` 的工作包。

### 5.2 文件存在性与初始化规则

计划中提到的文件分为三类，Codex 必须先检查再决定读取或创建：

| 类型 | 处理规则 | 示例 |
|---|---|---|
| 必需输入 | 必须已经存在；缺失才是真正的前置条件失败 | 本计划文件、当前阶段涉及的现有源码 |
| 可选输入 | 存在则读取，不存在则跳过并记录，不得因此停止 | 仓库内 `AGENTS.md`、上一阶段报告、尚未创建的验收脚本 |
| 阶段产物 | 由指定工作包创建；创建前不应被当作输入读取 | `migration-status.md`、`stage-N-report.md`、`check-langgraph-stageN.ps1` |

首次执行 0A 时，初始化目录和状态文件：

```text
docs/langchain-langgraph/
  migration-status.md
  stage-0-report.md
```

`migration-status.md` 至少记录：

```md
# LangChain / LangGraph 迁移状态

- 当前阶段：0
- 当前工作包：0A
- 总体状态：in_progress

| 工作包 | 状态 | 前置工作包 | 最近验证 | 备注 |
|---|---|---|---|---|
| 0A | in_progress | 无 | 未运行 | 初始化 |
| 0B | pending | 0A | 未运行 | |
```

初始化时应按本计划列出全部工作包，示例只展示最小字段和前两行。工作包状态只使用 `pending`、`in_progress`、`completed`、`incomplete`，平台请求失败另记“中断类别”，不要误写为业务 `blocked`。

## 6. 统一目录建议

实际执行时可根据现有结构微调，但职责边界应保持：

```text
apps/server/src/langchain/
  contracts.ts
  model/
  tools/
  agents/

apps/server/src/langgraph/
  state/
  nodes/
  graphs/
  adapters/
  persistence/
  events/
  interrupts/
  rollout/
  testing/

apps/server/src/acceptance/
  langGraphStage*.test.ts

scripts/
  check-langgraph-stage*.ps1

docs/langchain-langgraph/
  migration-status.md
  stage-*-report.md
```

禁止创建一个包含完整实现的超大 `langgraph.ts`、`common.ts` 或 `utils.ts`。

## 7. 统一验证策略

每个阶段使用四层测试：

1. **单元测试**：消息转换、状态 reducer、节点、条件边、权限适配和错误转换。
2. **契约测试**：Legacy 与新实现消费/返回相同项目契约。
3. **集成测试**：使用 Fake Model、真实图、Mock Tool、MemorySaver 和临时工作区执行完整链路。
4. **验收测试**：通过项目 API、TaskSession、审批和恢复接口验证用户可见行为。

比较结果时不要求自然语言逐字相同，统一比较：

- 路由意图、复杂度和所需能力。
- 计划任务类型、依赖、读写范围和验收条件。
- Agent 与工具调用序列的关键约束。
- Patch、实际变更文件和 Checkpoint。
- 命令、退出状态和验证证据。
- 任务终态、blocker 和完成证据。
- 步骤数、重试数、重规划数、token 和耗时。
- 是否出现未授权或重复副作用。

## 8. 阶段 0：冻结基线并建立迁移骨架

### 8.1 前置条件

- 当前服务端测试可运行。
- 已确认工作区用户修改，不覆盖已有开发内容。
- 不要求已经安装 LangChain。

### 8.2 要达成的效果

- 获得可以重复运行的 Legacy 行为基线。
- 建立 LangGraph 迁移专用 Feature Flag、测试入口、状态文档和阶段脚本命名规范。
- 此阶段生产执行行为必须保持完全不变。

### 8.3 功能边界

允许：新增测试夹具、Fake Model、结果归一化、指标快照和关闭状态的 Feature Flag。

禁止：接管模型调用、运行 LangGraph、改变工具暴露、改变任务状态和修改前端。

### 8.4 预期文件

- 工作包 0A 创建 `docs/langchain-langgraph/migration-status.md` 和 `docs/langchain-langgraph/stage-0-report.md`；首次执行前它们不存在是正常状态。
- `apps/server/src/langgraph/testing/baselineScenarios.ts`
- `apps/server/src/langgraph/testing/legacyBaselineRunner.ts`
- `apps/server/src/langgraph/testing/resultNormalizer.ts`
- `apps/server/src/acceptance/langGraphStage0Acceptance.test.ts`
- `scripts/check-langgraph-stage0.ps1`
- 现有 Feature Flag、配置、环境变量示例和 package scripts 的最小修改。

### 8.5 基线场景

至少覆盖：普通问答、只读分析、单文件修改、新建文件、多文件修改、越权写入、Patch 审批/拒绝、命令执行、测试失败、工具失败恢复、重复工具调用、步数耗尽、服务重启恢复、完成证据不足。

### 8.6 验收要求

- 所有场景使用 Fake Model 或固定响应，不调用收费接口。
- 结果归一化后可以生成稳定结构化快照。
- `LANGGRAPH_*` 开关默认关闭。
- 现有测试结果无回归。

建议新增统一命令：

```bash
pnpm verify:langgraph-stage0
```

### 8.7 完成定义

- 基线测试连续运行两次结果一致。
- 新增 Flag 关闭时没有任何 LangGraph 生产路径。
- 阶段报告记录场景、命令、结果和遗留风险。

### 8.8 回退方式

仅删除迁移测试骨架和关闭状态 Flag；不涉及业务数据迁移。

## 9. 阶段 1：LangChain 模型、消息和工具适配

### 9.1 依赖

依赖阶段 0。

开始前检查 `apps/server/package.json`。如果当前工作区已经存在 `langchain`、`@langchain/core`、`@langchain/langgraph`，不得重复安装或擅自升级。只有代码直接导入 Zod 且项目没有直接依赖时，才执行：

```bash
pnpm --filter @mini-ai-web-editor/server add zod
```

### 9.2 要达成的效果

- 现有 Provider Gateway 可以通过 LangChain 标准模型接口调用。
- 项目消息、tool call、usage、reasoning 和错误可以与 LangChain 消息双向转换。
- 现有 `AgentToolDefinition` 可以包装成 LangChain Tool，但真实执行仍返回现有工具注册中心。
- 生产流量仍然全部走 Legacy。

### 9.3 功能边界

允许：新增纯适配层和契约测试。

禁止：直接使用 `ChatOpenAI` 绕过 Provider Gateway；禁止让 LangChain Tool 直接读写文件；禁止修改 Main/Planner 行为。

### 9.4 预期文件

- `apps/server/src/langchain/contracts.ts`
- `apps/server/src/langchain/model/modelAdapter.ts`
- `apps/server/src/langchain/model/messageAdapter.ts`
- `apps/server/src/langchain/model/responseAdapter.ts`
- `apps/server/src/langchain/tools/toolAdapter.ts`
- `apps/server/src/langchain/tools/schemaAdapter.ts`
- 对应 `*.test.ts`
- `apps/server/src/acceptance/langGraphStage1Acceptance.test.ts`
- `scripts/check-langgraph-stage1.ps1`

### 9.5 必测行为

- system/user/assistant/tool 消息往返不丢失语义。
- 单个和多个 tool call 的 ID、名称和参数保持一致。
- 文本、空内容、reasoning 和 token usage 正确转换。
- JSON 参数异常返回项目统一错误。
- Provider 不支持特定 tool choice 时仍保留现有 fallback。
- `AbortSignal` 能取消模型和工具调用。
- Tool 异常不会把第三方内部错误直接暴露给用户。

### 9.6 完成定义

- 适配层契约测试全部通过。
- Legacy 基线零差异。
- 除适配层和测试外，没有业务文件依赖 LangChain 消息类型。
- 新路径仍不可从生产配置启用。

## 10. 阶段 2：只读 LangChain Agent

### 10.1 依赖

依赖阶段 1。

### 10.2 要达成的效果

- 使用 LangChain Agent Loop 完成项目分析和代码问答。
- 只开放搜索、读取、定义提取、存在性检查、影响分析等无副作用工具。
- 支持 `off`、`shadow` 和 `internal` 三种初始模式。

### 10.3 功能边界

允许的工具以当前只读 Registry 为准。

明确禁止 `writeFile`、`replaceInFile`、`proposePatch`、`applyPatch`、`deleteFile`、`runCommand` 及其他副作用工具。即使模型伪造调用，也必须在服务端阻断。

### 10.4 预期文件

- `apps/server/src/langchain/agents/readOnlyAgent.ts`
- `apps/server/src/langchain/agents/readOnlyAgentState.ts`
- `apps/server/src/langgraph/rollout/runtimeSelector.ts`
- `apps/server/src/langgraph/rollout/featureFlags.ts`
- 对应单元测试和 Stage 2 验收测试。

### 10.5 必测行为

- 只读任务能完成 inspect/search/read/final answer 循环。
- 写工具在模型可见列表中不存在。
- 伪造写工具调用被拒绝且工作区不改变。
- 重复工具调用、读取预算、最大步骤和取消信号生效。
- shadow 结果只记录对照，不影响用户收到的 Legacy 结果。
- shadow 日志不记录源码正文、Prompt 和敏感信息。

### 10.6 完成定义

- 权限违规和文件变更数量均为 0。
- 只读基线场景通过率不低于 Legacy。
- 关闭 Flag 可立即恢复纯 Legacy。
- 真实模型验证仅作为补充，不替代确定性测试。

## 11. 阶段 3：Planner / Explorer LangGraph 只读子图

### 11.1 依赖

依赖阶段 2。

### 11.2 要达成的效果

- 使用 LangGraph 表达“路由 -> 规划 -> 缺少上下文 -> Explorer -> 合并证据 -> 重规划”的只读循环。
- 输出继续使用现有 `Plan`、`PlannerResult` 和 `ExplorerArtifact` 契约。
- 支持多个独立 Explorer 并行，但并发数必须受现有稳定性策略限制。

### 11.3 功能边界

允许：规划、只读探索、并行证据收集、计划校验。

禁止：Developer、Tester、Patch、写入、命令执行、审批 Interrupt 和生产持久化。

### 11.4 预期节点

- route/planning decision
- planner
- explorer fan-out
- exploration merge
- plan validation
- bounded replan
- blocked/final result

### 11.5 状态边界

Graph State 只保存目标、约束、事实、计划、artifact 引用、重规划计数和状态，不保存完整文件正文或大型工具输出。

### 11.6 必测行为

- 节点可单独测试。
- 条件边覆盖 ready、missing_context、failed、blocked。
- 并行 Explorer 结果不互相污染。
- `validatePlan()` 仍是计划合法性的最终校验。
- 重规划次数达到上限后明确 blocked。
- Graph Plan 与 Legacy Plan 比较任务类型、依赖、作用域和验收条件。

### 11.7 完成定义

- Stage 0～3 累计测试通过。
- Graph 输出无需修改现有下游 Runtime 即可消费。
- Planner/Explorer 仍然没有写权限。
- Graph 子图仅在 `shadow` 或 `internal` 模式运行。

## 12. 阶段 4：Graph 持久化、事件转换和审批 Interrupt 基础

### 12.1 依赖

依赖阶段 3。

### 12.2 要达成的效果

- 将 `taskSession.id` 稳定映射为 LangGraph thread ID。
- Graph 可以保存流程状态、服务重启后恢复，并将事件转换成现有 `AgentStep`。
- 建立通用审批 Interrupt 和 resume 协议，但此阶段不执行真实写入。

### 12.3 功能边界

允许：流程 checkpoint、只读图恢复、模拟审批、中断事件和前端协议转换。

禁止：用 Graph checkpoint 保存文件正文；禁止在 Interrupt 前后执行真实写操作；禁止改变现有 TaskSession 对外结构的语义。

### 12.4 预期文件

- `apps/server/src/langgraph/persistence/threadIdentity.ts`
- `apps/server/src/langgraph/persistence/taskSessionCheckpointer.ts`
- `apps/server/src/langgraph/events/agentStepAdapter.ts`
- `apps/server/src/langgraph/events/graphEventStream.ts`
- `apps/server/src/langgraph/interrupts/approvalInterrupt.ts`
- `apps/server/src/langgraph/interrupts/resumeGraph.ts`
- 对应持久化、事件和恢复测试。

### 12.5 必测行为

- 相同任务在重试、审批恢复和服务重启后使用相同 thread ID。
- 不同任务状态完全隔离。
- 旧 TaskSession 仍可读取。
- 只读子图中断后可从 checkpoint 继续。
- 同一个 resume 请求重复提交不会重复推进业务副作用。
- Graph 的 node/task/update/interrupt/final 事件能够映射到现有步骤流。
- 事件中不泄漏完整 Prompt、源码和敏感配置。

### 12.6 完成定义

- 进程重启恢复验收通过。
- 重复 resume 的业务副作用次数为 0。
- 前端无需修改即可显示转换后的只读执行步骤；如协议确需扩展，只允许向后兼容扩展。
- Legacy TaskSession 和 Graph 状态不会相互覆盖。

## 13. 阶段 5：Developer Patch-only 子图

### 13.1 依赖

依赖阶段 4。

### 13.2 要达成的效果

- LangGraph 能调度 Developer 完成上下文准备、存在性检查、相似模式检查、影响分析、修改计划和候选 Patch 生成。
- 最终仅产生待审批 Patch，绝不应用到工作区。

### 13.3 功能边界

允许：只读分析、结构化修改计划、`proposePatch`。

禁止：`applyPatch`、`writeFile`、`replaceInFile`、`deleteFile` 和命令执行；禁止子图自行完成整个任务。

### 13.4 预期节点

- prepare context
- existence/reference checks
- pattern search
- impact analysis
- modification plan
- propose patch
- patch validation
- approval request

### 13.5 必测行为

- 未完成必要证据时不能生成 Patch。
- Patch 文件必须包含在结构化修改计划和 write scope 中。
- 新建文件、修改文件和删除文件意图正确区分。
- Patch 来源、task ID、graph run ID 和 action ID 可追踪。
- 多次执行相同输入不会产生相互冲突的重复 Patch。
- 生成 Patch 后工作区内容保持不变。

### 13.6 完成定义

- Patch 与现有 Safe Editor、Diff UI、Patch Store 契约兼容。
- 未审批写入数量为 0。
- Stage 0～5 累计验收通过。
- 新路径仍只允许 internal/shadow，不对普通用户执行写入。

## 14. 阶段 6：审批后写入、Checkpoint 与幂等恢复

### 14.1 依赖

依赖阶段 5。

### 14.2 要达成的效果

- 用户批准后，Graph 通过独立副作用节点调用现有 Patch 应用能力。
- 写入前后继续创建现有文件 Checkpoint。
- 审批拒绝、超时、重复 resume、服务重启和写入失败都有确定行为。

### 14.3 功能边界

允许：已批准 Patch 的应用和现有回滚。

禁止：Graph 直接使用 `fs` 写文件；禁止未批准的 direct edit；禁止把 checkpoint 创建失败当作写入成功。

### 14.4 节点拆分要求

审批节点和写入节点必须分离：

```text
propose patch -> interrupt -> approval decision -> idempotency check -> apply existing patch -> create/record checkpoint -> result
```

### 14.5 必测行为

- 未批准时工作区不变化。
- 批准后文件内容与已审 Patch 完全一致。
- 拒绝后记录状态但不写入。
- 同一 approval/resume 重放两次只应用一次。
- 应用成功但状态持久化失败时能够诊断和恢复，不能盲目重写。
- 新建、修改、删除和二进制文件回滚行为保持现有语义。
- write scope 在执行前和执行结果后各校验一次。

### 14.6 完成定义

- 未审批写入、越权写入、重复写入均为 0。
- Patch 与工作区差异为 0。
- Checkpoint 和回滚专项测试全部通过。
- 关闭 LangGraph Flag 后，现有审批中的 Legacy 任务仍可继续处理。

## 15. 阶段 7：Tester、失败分类、重规划与完成闭环

### 15.1 依赖

依赖阶段 6。

### 15.2 要达成的效果

- LangGraph 在写入后调用现有验证规划和 Tester。
- 根据失败分类进入 Developer 修复、Planner 重规划、blocked 或完成证据判断。
- 最终终态继续由现有完成策略决定。

### 15.3 功能边界

允许：现有验证命令、Tester artifact、有限 Developer/Tester 循环和有限重规划。

禁止：执行验证计划之外的命令；禁止测试失败时直接完成；禁止无限修复循环；禁止 Graph 绕过 `completeTask` 证据。

### 15.4 预期节点

- verification planning
- execute validation
- failure classification
- developer retry decision
- replan decision
- completion evidence collection
- completion policy
- completed/blocked/incomplete/failed

### 15.5 必测行为

- 验证通过进入完成检查。
- 实现问题回到 Developer。
- 计划问题回到 Planner。
- 环境问题返回明确 blocker，不进行无意义代码修改。
- 同类失败达到阈值后停止。
- 没有真实文件变更或验证证据时不能成功。
- 达到预算后返回 `incomplete` 或 `blocked`，不能伪造成功。

### 15.6 完成定义

- 现有 Runtime Phase 6～8、任务完成、新文件和 Safe Editor 验收全部通过。
- Legacy 与 Graph 的终态语义一致。
- 所有循环都有配置上限和指标。
- 失败任务被错误标记成功的数量为 0。

## 16. 阶段 8：Main Graph 接管与前端兼容

### 16.1 依赖

依赖阶段 7。

### 16.2 要达成的效果

- 建立完整 Main Graph，统一路由 direct、main_loop 和 planned 请求。
- 组合 Planning、Developer、Tester 等子图。
- API、SSE/WebSocket、TaskSession、审批和 Diff UI 对外行为保持兼容。

### 16.3 功能边界

允许：通过 Feature Flag 让 internal 流量完整走 Main Graph；允许向后兼容增加观测字段。

禁止：删除 Legacy；禁止前端直接依赖 Graph node 名称；禁止默认全量开启。

### 16.4 Main Graph 必须覆盖

- 问答 direct 路径。
- 只读分析路径。
- 简单修改 main loop。
- 复杂任务 planned 路径。
- 用户补充信息。
- 审批等待和恢复。
- 取消、超时和服务重启。
- Developer/Tester 修复闭环。
- 最终总结和任务终态。

### 16.5 前端兼容验证

- 聊天消息顺序正确。
- Agent Steps 可读且不会重复。
- Task Plan 状态与 Runtime 实际状态一致。
- 审批弹窗、Diff、命令状态和完成状态保持可用。
- 刷新页面后能够恢复 Graph 任务显示。
- Legacy 和 Graph 任务可以同时出现在历史列表中。

### 16.6 完成定义

- internal 模式完整端到端验收通过。
- 前端类型检查和生产构建通过。
- 所有对外 API 保持兼容，或提供明确版本化迁移。
- 仍未向普通任务默认开放。

## 17. 阶段 9：Shadow 对照、灰度和全量切换

### 17.1 依赖

依赖阶段 8。

### 17.2 要达成的效果

- 建立可量化的新旧路径对照。
- 按稳定任务分桶逐步让 LangGraph 接管真实任务。
- 达到安全、正确性、成本和性能门槛后切换为默认路径。

### 17.3 Rollout 模式

统一支持：

- `off`：只运行 Legacy。
- `shadow`：Legacy 返回，Graph 只做安全对照。
- `internal`：仅内部或明确标记任务走 Graph。
- `10`：10% 稳定分桶。
- `50`：50% 稳定分桶。
- `all`：全部走 Graph，Legacy 保留回退。

### 17.4 Shadow 安全规则

- 写任务不能让两套 Runtime 同时修改真实工作区。
- Graph shadow 使用只读模式、临时工作区或仅生成候选 Patch。
- 命令执行默认不在 shadow 重复运行。
- 真实模型 shadow 必须采样并设置成本上限。
- 只记录脱敏后的结构化差异。

### 17.5 灰度顺序

1. internal 固定场景。
2. 只读任务 10%。
3. 只读任务 50%。
4. 只读任务 all。
5. 单文件 Patch 任务 10%。
6. 单文件 Patch 任务 50%。
7. 复杂修改任务 10%。
8. 复杂修改任务 50%。
9. 全量。

每次升级分桶前必须形成观察报告，不能仅凭“测试通过”升级。

### 17.6 核心指标

- 任务成功率和错误终态率。
- 未审批、越权和重复副作用数量。
- Patch 审批率、应用成功率和回滚率。
- 验证成功率和错误完成率。
- 平均/P95 步骤数、耗时和 token。
- 工具失败恢复率和重复调用率。
- 重规划次数和循环耗尽率。
- 审批恢复成功率和状态损坏数量。
- 用户取消率和 blocker 分类。

### 17.7 强制回退条件

出现任意一项立即切回 Legacy：

- 未审批写入。
- write scope 越权。
- 重复执行文件写入或命令。
- Checkpoint 或 TaskSession 状态损坏。
- 失败任务被标记成功。
- 服务重启后无法恢复且可能产生重复副作用。
- 成功率、P95 延迟或 token 成本超过团队预先批准的阈值。

### 17.8 完成定义

- `all` 模式稳定运行至少两个完整发布观察周期。
- 无 P0/P1 安全和数据一致性问题。
- 核心指标不劣于约定基线。
- 关闭 Flag 的回退演练通过。

## 18. 阶段 10：Legacy 收敛与清理

### 18.1 依赖

依赖阶段 9 全量稳定，不能提前执行。

### 18.2 要达成的效果

- LangGraph 成为默认运行时。
- 移除确认不再使用的重复编排代码。
- 保留业务安全层、文件能力、Provider Gateway、TaskSession、Patch、Checkpoint 和完成策略。
- 形成最终架构、运维、故障恢复和回退文档。

### 18.3 功能边界

允许删除的仅是已经被 Graph 覆盖且无调用方的重复 Agent Loop/Orchestrator 代码。

禁止删除：业务工具、安全策略、权限、作用域、审批、文件 Checkpoint、任务证据、Provider Gateway 和前端稳定协议。

### 18.4 删除前置检查

- 使用 `rg` 和 TypeScript 类型检查确认无生产调用方。
- 对应测试已迁移到 Graph 路径，而不是直接删除。
- 有可恢复的 Git 版本和迁移报告。
- 团队确认无需继续双运行。

### 18.5 完成定义

- 全量测试、双端类型检查和前端构建通过。
- 删除后验收结果与阶段 9 一致。
- README、环境变量示例和架构文档已更新。
- Legacy 回退从运行时 Flag 转为版本级回退，并有明确操作手册。

## 19. 阶段报告模板

每阶段完成后创建或更新 `docs/langchain-langgraph/stage-N-report.md`：

```md
# Stage N 实施报告

## 结果

- 状态：completed / incomplete / blocked
- 当前工作包：
- 中断类别：none / platform_request_blocked / project_policy_blocked / business_blocked
- 开始提交：
- 完成提交：
- 执行日期：

## 实际修改

- 文件：职责

## 与计划的偏差

- 偏差：
- 原因：
- 影响：

## 验证证据

- 命令：
- 结果：
- 测试数量：

## 指标对比

- Legacy：
- LangGraph：
- 差异：

## 已知问题和风险

- 问题：
- 是否阻止下一阶段：

## 回退方式

- Feature Flag：
- 数据兼容性：
- 操作步骤：

## 下一阶段准入结论

- allowed / denied
- 依据：
```

## 20. Codex 可直接使用的阶段指令模板

优先使用“执行下一个工作包”指令，避免让 Codex 在一次请求中尝试完成整个阶段：

```text
请继续执行 docs/langchain-langgraph-refactor-execution-plan.md 中阶段 N 的下一个未完成工作包。

要求：
1. 先确认计划中引用的文件是否真实存在，不得假定计划产物已经创建。
2. 如果 docs/langchain-langgraph/migration-status.md 存在，从中选择阶段 N 第一个满足依赖的 pending/incomplete 工作包；如果它不存在，只允许执行 0A，并由 0A 初始化状态文件。
3. 使用 rg --files -g AGENTS.md 查找并读取实际存在的规则文件；仓库中没有 AGENTS.md 时，继续遵守当前对话规则，不得因此停止。
4. 读取本计划、实际存在的迁移状态、实际存在的当前/上一阶段报告和相关现有代码；不存在的可选报告直接跳过并记录。
5. 只有前置验收脚本实际存在时才运行；尚未创建时使用相关现有测试建立基线，不得因为计划中的未来脚本不存在而阻塞。
6. 一次只实施选中的一个工作包。
7. 先输出技术栈分析、依赖计划和文件计划，再开始修改。
8. 保留用户已有未提交修改，不覆盖、不回滚无关文件。
9. 复用现有 Provider Gateway、工具 Registry、权限、TaskSession、Safe Editor、Patch、Checkpoint 和完成策略。
10. 新增核心代码添加必要中文注释，并为节点、条件边、适配器和失败路径补测试。
11. 新路径必须由 Feature Flag 保护，默认启用范围遵守该阶段规定。
12. 遵守 4.4 的 Request blocked 防护约束，限制读取、diff、命令输出和修改规模。
13. 完成后运行当前工作包聚焦测试和类型检查；仅在阶段最后一个工作包运行阶段累计验收。
14. 创建或更新 migration-status.md；stage-N-report.md 不存在时创建，存在时更新，并记录恢复点。
15. 如果工作包完成定义未全部满足，标记为 incomplete；只有缺少用户选择、权限或外部状态时才标记为 business_blocked。
16. 如果出现字面上的 Request blocked，遵守 4.6 恢复协议，不原样重试、不绕过安全策略。
```

## 21. 最终发布验收建议

最终阶段至少执行现有高风险回归：

```bash
pnpm --dir apps/server typecheck
pnpm --dir apps/server test
pnpm --dir apps/server verify:runtime-phase8
pnpm --dir apps/web typecheck
pnpm --dir apps/web build
pnpm verify:agent-new-file-stage7
pnpm verify:task-completion-stage8
pnpm verify:safe-editor-stage6
pnpm verify:state-storage-integrity
```

此外应提供累计命令：

```bash
pnpm verify:langgraph-stage10
```

该命令必须串联阶段 0～10 的关键契约、恢复、安全编辑、任务完成、状态存储和双端构建验收。

## 22. 全局完成标准

只有同时满足以下条件，整个重构才算完成：

- LangChain 模型和工具适配不绕过现有业务层。
- Main/Planner/Explorer/Developer/Tester 的主要流程由 LangGraph 表达。
- 审批、服务重启和重复恢复不会产生重复副作用。
- 未审批写入、越权写入和错误完成数量为 0。
- 现有 Patch、Diff、Checkpoint、回滚和任务历史保持可用。
- 前端协议和用户操作链路完成兼容验收。
- 全量灰度指标达到约定门槛，并通过回退演练。
- Legacy 仅在稳定观察期结束后清理。
- 所有阶段报告、测试、环境变量和运维文档完整。
