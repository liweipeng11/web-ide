# Stage 9 实施报告

## 结果

- 状态：incomplete（9A～9C completed；9D engineering-ready / observation-pending）
- 当前工作包：9D 全量观察门禁、回退演练与报告
- 中断类别：none
- 开始提交：`ef66cbd`
- 完成提交：未提交工作区
- 执行日期：2026-08-18

## 实际修改

- `apps/server/src/langgraph/rollout/shadowComparison.ts`：固定维度对照、耗时分桶和独立 JSONL 指标写入。
- `apps/server/src/langgraph/rollout/runtimeSelector.ts`：在只读 Shadow 双运行中采集脱敏结构差异，并隔离观测异常。
- `apps/server/src/agentOrchestrationService.ts`：为 direct 结果提供固定结构描述，生产默认观测写入独立指标文件。
- 对应测试：覆盖敏感值不落盘、并发指标写入、结构差异、Legacy 返回和失败隔离。
- `apps/server/src/langgraph/rollout/featureFlags.ts`：扩展 `10`、`50`、`all` 只读灰度配置，非法值继续安全关闭。
- `apps/server/src/langgraph/rollout/runtimeSelector.ts`：复用项目稳定哈希，根据 TaskSession ID 固定分桶；未命中灰度时明确选择 Legacy，一旦命中 Graph，执行器不可用或新路径失败都会直接报错。
- `apps/server/src/agents/main/mainAgentRuntime.ts`、`apps/server/src/taskPlanService.ts`、`apps/server/src/agentOrchestrationService.ts`：统一透传稳定灰度键，覆盖计划准备和 direct 只读入口。
- `apps/server/src/langgraph/rollout/writeRuntimeGate.ts`：按 TaskSession ID 选择写路径，提供只记录固定原因的进程内熔断器和最小副作用快照。
- `apps/server/src/agentOrchestrationService.ts`：已批准写任务接入独立灰度；一旦选中 Graph，失败会熔断并原样抛错，无论副作用状态都禁止同请求回退 Legacy。
- `apps/server/src/langgraph/main/taskSessionMainGraph.ts`：保留被 Main Graph 收敛为 failed state 的原始执行异常，供写路径门禁准确判断。
- `.env.example`、`apps/server/src/config.ts`：增加 `AGENT_LANGGRAPH_WRITE_MODE`，总开关默认关闭行为不变。
- `apps/server/src/langgraph/rollout/rolloutObservation.ts`：新增发布周期聚合指标契约与确定性决策器；样本不足保持观察，指标越界或硬安全信号触发回退，只有两个合格的唯一全量周期才允许提出 Legacy 清理。
- `apps/server/src/acceptance/langGraphStage9Acceptance.test.ts`：覆盖只读 `all -> off` 和写路径总开关关闭后的无迁移回退演练。
- `scripts/check-langgraph-stage9.ps1`、根 `package.json`：提供阶段 9 累计验收入口，串联阶段 8、灰度契约、回退验收、LangGraph 专项、双端类型检查和 Web 生产构建。
- `apps/server/src/langgraph/rollout/rolloutObservationInput.ts`、`rolloutObservationCli.ts`：严格导入真实聚合数据并输出机器可读判定；未知字段、非法比例、非整数计数和伪造基线会被拒绝。
- `scripts/evaluate-langgraph-stage9.ps1`、`stage-9-observation.example.json`：提供运维命令和不具备发布效力的空数据模板；退出码区分放行、继续观察、回退和输入错误。
- `apps/server/src/langgraph/rollout/runtimeObservationContext.ts`：使用 `AsyncLocalStorage` 为并发请求隔离 Legacy/LangGraph 控制面和灰度模式，不携带任务正文。
- `apps/server/src/observability/runMetrics.ts`、`taskMetrics.ts`：新指标写入固定来源枚举，旧快照补为 `unknown`；Graph 失败后的 Legacy 接管会形成独立的 Legacy 来源记录。

## 与计划的偏差

- 偏差：9B 只开放只读路径的稳定选择能力，不触及写任务灰度。
- 原因：写任务还需要 9C 的安全指标自动回退门禁，不能与只读灰度同时放开。
- 影响：生产默认仍为 `off`；只有显式配置 `10`、`50` 或 `all` 且新执行器可用时才接管对应只读任务。
- 偏差：9C 的自动回退先覆盖确定性的运行失败、状态契约、范围违规和副作用事实；跨发布周期的成功率、P95 和 token 阈值仍留在 9D 观察门禁中。
- 原因：写任务不能通过双运行获得安全对照，必须先保证单请求不会因回退而重复副作用。
- 影响：当前可以受控开展写任务分桶，但在 9D 完成前不升级为默认全量模式。
- 偏差：本地自动化只能验证观察契约和回退操作，不能替代两个真实生产发布周期。
- 原因：仓库中没有可证明来自真实 `all` 模式发布周期的聚合快照，也没有团队批准的最终阈值记录。
- 影响：9D 保持 incomplete，观察决策器的模拟通过结果不得作为阶段 10 准入证据。

## 验证证据

- 命令：`pnpm --dir apps/server exec tsx --test src/langgraph/rollout/shadowComparison.test.ts src/langgraph/rollout/runtimeSelector.test.ts src/agentOrchestrationService.test.ts`
- 结果：通过。
- 测试数量：20 项通过，0 项失败。
- 命令：`pnpm --dir apps/server typecheck`
- 结果：通过。
- 命令：`pnpm --dir apps/server exec tsx --test src/langgraph/rollout/featureFlags.test.ts src/langgraph/rollout/runtimeSelector.test.ts src/agentOrchestrationService.test.ts src/taskSessionStore.test.ts`
- 结果：82 项通过，0 项失败。
- 命令：`pnpm --dir apps/server test:langgraph`
- 结果：119 项通过，0 项失败（9C 当前结果）。
- 命令：`pnpm --dir apps/server test:main-agent`
- 结果：51 项通过，0 项失败。
- 命令：`pnpm --dir apps/server exec tsx --test src/acceptance/langGraphStage9Acceptance.test.ts src/langgraph/rollout/rolloutObservation.test.ts`
- 结果：7 项通过，0 项失败；其中观察门禁 5 项、回退演练 2 项。
- 命令：`pnpm verify:langgraph-stage9`
- 结果：通过；阶段 9 灰度与安全契约 35 项、回退验收 2 项、LangGraph/LangChain 专项 124 项、服务端和 Web 类型检查、Web 生产构建及前序阶段累计验收均通过。
- 命令：`pnpm --dir apps/server exec tsx --test src/langgraph/rollout/rolloutObservation.test.ts src/langgraph/rollout/rolloutObservationInput.test.ts`；`pnpm --dir apps/server typecheck`
- 结果：观察决策与严格输入解析 9 项通过，类型检查通过。
- 命令：`pnpm --dir apps/server test:langgraph`
- 结果：加入严格输入和控制面上下文测试后的当前专项套件 130 项通过，0 项失败。
- 命令：`pnpm evaluate:langgraph-stage9 -InputPath docs/langchain-langgraph/stage-9-observation.example.json`
- 结果：返回 `hold` 和退出码 `2`，空示例不会放行阶段 10。
- 命令：`pnpm --dir apps/server exec tsx --test src/langgraph/rollout/runtimeObservationContext.test.ts src/observability/runMetrics.test.ts src/observability/taskMetrics.test.ts src/agentOrchestrationService.test.ts`；`pnpm --dir apps/server typecheck`
- 结果：控制面来源、并发隔离、Graph/Legacy/回退分支及指标兼容共 33 项通过，类型检查通过。

## 指标对比

- Legacy：Shadow 模式继续作为唯一用户返回来源。
- LangGraph：记录完成/失败状态、固定结果维度差异和粗粒度耗时区间。
- 差异：不保存 Prompt、回答、源码、工具输出、错误正文或结果维度原值。
- 9D：观察决策只消费任务量、成功/错误率、安全计数、补丁与验证比率、步骤/耗时/token P95、恢复/重复/重规划/审批比率等聚合值。
- 注意：测试中的两个合格周期是契约模拟数据，仅证明决策逻辑，不代表真实发布结果。

## 已知问题和风险

- 问题：尚未取得 Legacy 基线、团队批准阈值和两个真实 `all` 模式发布周期的聚合指标。
- 数据边界：本机已有 470 条历史 `task_run`，但均缺少控制面来源且混有测试运行，不能作为 9D 发布证据；必须从本次来源标记上线后重新观察。
- 已完成：自动化回退演练和观察门禁的 promote/hold/rollback 契约验证。
- 是否阻止下一阶段：是；在真实观察证据齐备前禁止进入阶段 10。

## 回退方式

- Feature Flag：设置 `AGENT_LANGGRAPH_READ_ONLY_MODE=off` 并重启服务。
- 写任务 Feature Flag：设置 `AGENT_LANGGRAPH_WRITE_MODE=off` 或 `AGENT_LANGGRAPH_RUNTIME_ENABLED=false` 并重启服务。
- 数据兼容性：Shadow 指标位于独立 JSONL，不参与 TaskSession 或 Graph checkpoint 恢复。
- 操作步骤：关闭对应读写模式即可停止新路径接管，无需迁移或删除业务数据。

## 下一阶段准入结论

- blocked（不允许进入阶段 10）
- 依据：工程实现和自动化累计验收已通过，但迁移计划要求的两个真实全量发布周期尚无证据；当前只能继续执行 9D 的生产观察与阈值评审。
