# LangChain / LangGraph 当前实现

## 架构边界

- LangChain `BaseChatModel` 已接入非流式模型入口，底层继续复用 Provider Gateway、任务预算、重试和指标。
- LangChain Tool 适配器只持有工具描述与 `RuntimeContext.callTool` 委托，不持有真实执行器，不绕过 Registry、权限和作用域检查。
- LangChain 只读 Agent 已具备有界消息/工具循环、重复调用抑制、取消处理和只读工具白名单；模型伪造写工具时会返回受控错误，不会触发 Runtime 写入。
- Planner / Explorer 的只读控制流已由 LangGraph `StateGraph` 表达：包含路由、计划、缺少上下文、受限并行探索、证据合并、计划校验和有界重规划。
- Explorer 使用 `Send` 动态分发，同一批结果通过 reducer 汇聚并回写唯一 Plan；并发批次上限继续复用现有 Runtime 稳定性策略。
- Graph checkpoint 使用独立的原子 JSON 命名空间；TaskSession ID 稳定映射为 thread ID，服务重启后可恢复，且不会覆盖旧 TaskSession。
- Graph node/task/update/interrupt/final 事件可转换为现有 AgentStep；稳定步骤 ID 会抑制恢复重放造成的重复展示。
- 已建立无副作用审批 interrupt/resume 协议，重复 resume 不会重复推进决定节点；批准后由 Graph 节点委托现有 Patch Apply 和 Checkpoint 安全边界。
- Developer Patch-only 子图已具备四类证据门禁、结构化修改计划、read/write scope 校验、稳定 Patch 来源和基础内容哈希校验；只生成与现有 Safe Editor、Patch Store、Diff UI 兼容的待审批 Patch。
- 相同 task、Graph Run 和候选内容会复用同一 Pending Patch；Graph checkpoint 只保存 Patch 引用，不保存完整源码，未审批时不会调用文件写入或命令能力。
- 只读入口支持 `off`、`shadow`、`internal`、`10`、`50`、`all`；百分比模式使用 TaskSession ID 稳定分桶。任一模式只要为本次请求选中 Graph，缺少执行器或 Graph 异常都会显式失败，不会隐式转到 Legacy。
- 已批准写任务支持独立的 `off`、`shadow`、`internal`、`10`、`50`、`all` 灰度；`shadow` 只运行 Legacy，避免两套 Runtime 重复修改真实工作区。
- 写路径 Graph 异常会触发脱敏的进程内熔断；`internal`、`10`、`50`、`all` 任一模式一旦选中 Graph，无论是否已产生副作用都不会在同一请求中改走 Legacy。
- 阶段 9 观察门禁只接收发布周期级聚合指标，不接收 Prompt、源码、命令输出或错误正文；连续两个唯一 `all` 周期满足样本量、成功率、错误率、P95 耗时和 token 阈值后，才允许提出 Legacy 清理。
- 未授权写入、范围违规、重复副作用、状态损坏、错误完成或重启恢复失败采用零容忍策略；任一周期出现即建议立即回退，重复/损坏周期和样本不足只保持观察，不会放行阶段 10。
- 新生成的运行指标包含 `runtimeControlPlane` 和 `runtimeRolloutMode` 固定枚举；只读双运行、写路径 Graph 和明确选择的 Legacy 直行均通过并发隔离上下文标记。历史指标缺少字段时视为 `unknown`，不得混入阶段 9 发布周期。
- LangGraph 已实现批准后任务的兼容入口判断与执行分支，但生产默认关闭；TaskSession 仍是业务状态真相来源。
- Main、Planner、Explorer、Developer、Tester 的现有实现、Patch、Safe Editor、Checkpoint、完成策略和前端协议保持不变。

## 运行与回退

默认关闭：

```env
AGENT_LANGGRAPH_RUNTIME_ENABLED=false
AGENT_LANGGRAPH_READ_ONLY_MODE=off
AGENT_LANGGRAPH_WRITE_MODE=off
```

`AGENT_LANGGRAPH_READ_ONLY_MODE` 可在受控环境设置为 `shadow`、`internal`、`10`、`50` 或 `all`。`shadow` 会同时执行新旧路径用于脱敏对照，但用户结果仍来自 Legacy；`internal` 还要求请求被显式标记为内部任务；`10`、`50` 按稳定任务键灰度接管。只要请求已选中 Graph，执行器缺失或 Graph 失败都会直接返回错误。`all` 会接管 direct、main_loop 和规划只读路径，生产 Main Graph 执行器由编排服务默认装配。需要紧急切换时只能显式将该变量恢复为 `off` 并重启服务，不会在运行中的请求内自动降级。

`AGENT_LANGGRAPH_RUNTIME_ENABLED` 仅在受控验证环境设置为 `true`。需要回退时恢复为 `false` 并重启服务；回退仅切换批准后任务的控制面，不迁移或删除 TaskSession 数据。

`AGENT_LANGGRAPH_WRITE_MODE` 用于已批准写任务的细分灰度。总开关关闭、`off` 或 `shadow` 都是在请求开始前明确选择 Legacy；`10`、`50` 使用 TaskSession ID 稳定分桶。任何模式一旦选中 Graph，Graph 异常会熔断新路径并让当前请求直接失败，绝不自动改走 Legacy；后续本应命中 Graph 的请求遇到熔断器也会直接失败。`all` 模式缺少稳定任务键同样会显式失败。

自动化回退演练已验证：只读模式从 `all` 切换到 `off` 后，新请求立即采用 Legacy；关闭写路径总开关后，已存在的 TaskSession 无需迁移即可由 Legacy 继续处理。生产切换仍需重启服务以加载环境配置。

真实观察数据使用严格的 `schemaVersion: 1` JSON 文档导入。模板见 `stage-9-observation.example.json`；模板中的零值和空周期仅用于展示字段，不能作为发布证据。执行命令：

```powershell
pnpm evaluate:langgraph-stage9 -InputPath <观察输入.json> -OutputPath <判定报告.json>
```

退出码 `0` 表示 `promote`，`2` 表示继续观察，`3` 表示必须回退，`1` 表示输入或执行错误。解析器拒绝未知字段，因此 Prompt、源码、命令输出和错误正文不能进入报告。

模型网关仍由已有 `MODEL_PROVIDER_GATEWAY_ENABLED` 控制；关闭后会回到旧模型传输路径。

## 验证

```bash
pnpm --dir apps/server test:langgraph
pnpm --dir apps/server typecheck
pnpm --dir apps/server verify:runtime-phase8
pnpm verify:langgraph-stage0
pnpm verify:langgraph-stage2
pnpm verify:langgraph-stage3
pnpm verify:langgraph-stage4
pnpm verify:langgraph-stage5
pnpm verify:langgraph-stage9
```

## 后续边界

阶段 9 的工程门禁与自动化验收已就绪，但这不等同于真实生产观察。必须先收集 Legacy 基线以及两个真实 `all` 模式发布周期的脱敏聚合指标，由团队确认阈值并得到 `promote` 结论，才能完成 9D 并进入阶段 10；当前不得清理 Legacy 路径。

本地既有 `run-metrics.jsonl` 生成于控制面来源字段加入之前，并混有自动化测试记录，只能作为历史诊断数据。真实观察必须从部署新版本之后开始，筛选 `runtimeControlPlane=legacy` 的基线或 `runtimeControlPlane=langgraph && runtimeRolloutMode=all` 的周期记录。
