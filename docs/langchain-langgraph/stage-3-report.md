# Stage 3 实施报告

## 结果

- 状态：completed
- 当前工作包：3D
- 中断类别：none
- 开始提交：`d3e5ac5`
- 完成提交：未提交工作区
- 执行日期：2026-08-13

## 实际修改

- `apps/server/src/langgraph/planning/planningGraphState.ts`：定义只保存结构化计划、事实、探索结果和计数器的 Graph State 与 reducers。
- `apps/server/src/langgraph/planning/planningGraph.ts`：实现 Planner 条件边、缺上下文探索、Explorer `Send` fan-out/fan-in、计划校验和有界重规划。
- `apps/server/src/agents/main/mainAgentRuntime.ts`：在 `off/shadow/internal` 灰度边界内接入规划图，并保留 Legacy 回退与原返回契约。
- `apps/server/src/langgraph/planning/planningGraph.test.ts`：覆盖 ready、missing_context、无读取范围、并行合并、连续失败和重规划上限。
- `scripts/check-langgraph-stage3.ps1`：增加阶段 0～3 累计验收入口。

## 与计划的偏差

- 偏差：阶段 3 不引入 checkpointer，也不持久化 Graph State。
- 原因：持久化、稳定 thread ID 和 Interrupt 属于阶段 4；当前先保证只读控制流和契约等价。
- 影响：当前进程中 Graph 可完整完成规划，但服务重启恢复仍由现有 TaskSession 负责。

## 验证证据

- `pnpm --dir apps/server typecheck`：通过。
- `pnpm --dir apps/server test:langgraph`：39/39 通过（包含嵌套子测试）。
- `pnpm --dir apps/server test:main-agent`：51/51 通过。
- `pnpm verify:langgraph-stage3`：阶段累计验收通过。
- `pnpm --dir apps/server test`：服务端主测试集 463/463 通过，全部 pretest 专项通过。
- `pnpm --dir apps/web typecheck`：通过。
- `pnpm --dir apps/web build`：Vite 生产构建通过。

## 安全与兼容性

- Graph 节点不直接持有文件或命令执行器，所有探索仍委托现有 Explorer Runtime 与权限管理器。
- Graph State 不保存 Prompt、源码正文或工具原始输出。
- 默认 `AGENT_LANGGRAPH_READ_ONLY_MODE=off`；`shadow` 返回 Legacy，`internal` 仅接管显式内部任务。
- Plan、PlannerResult、ExplorerExecution 和 MainAgentRuntime 对外契约未改变。

## 回退方式

- 将 `AGENT_LANGGRAPH_READ_ONLY_MODE=off` 并重启服务，规划入口立即恢复纯 Legacy。
- 无数据迁移，不影响现有 TaskSession、Patch、Checkpoint 或前端协议。

## 下一阶段准入结论

- allowed
- 依据：3A～3D 完成，累计专项测试和类型检查通过，未引入写权限或新的副作用入口。
