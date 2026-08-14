# Stage 8 实施报告

## 结果

- 状态：completed
- 当前工作包：8D
- 中断类别：none
- 执行日期：2026-08-14

## 实际修改

- `langgraph/main/mainGraph.ts`：统一 direct、main_loop 和 planned 条件路由及子图组合。
- `langgraph/main/taskSessionMainGraph.ts`：接入已批准 TaskSession、稳定 checkpoint、事件流和跨重启快照。
- `langgraph/events/graphEventStream.ts`：将稳定 Graph 事件实时桥接为现有 AgentStep。
- `agentOrchestrationService.ts`：在 Feature Flag 保护下接入生产编排入口并保持 Legacy 回退。
- `index.ts`：复用现有 SSE `agent_step` 协议推送 Graph 步骤。
- `acceptance/langGraphStage8Acceptance.test.ts`：验证 direct、main_loop、planned、审批等待、刷新恢复和 Legacy 共存。
- `scripts/check-langgraph-stage8.ps1`：提供阶段 0～8 累计验收入口。

## 与计划的偏差

- 项目当前没有独立浏览器 E2E 测试框架；双端验收采用服务端真实 TaskSession/Graph/SSE 契约，加 Web 类型检查和生产构建，不额外引入重复测试依赖。

## 验证证据

- `pnpm verify:langgraph-stage8`：通过。
- Main Graph、TaskSession、事件、审批、checkpoint 和重启恢复专项：通过。
- direct、main_loop、planned、审批等待及 Legacy 回退端到端验收：通过。
- 服务端与 Web 类型检查、Web 生产构建：通过。
- Graph 步骤重复持久化、未批准执行和错误默认开放数量：0。

## 指标对比

- Legacy：继续提供原 API、SSE、TaskSession、审批、Diff、Patch 和最终状态契约。
- LangGraph：在相同对外协议下增加统一路由、稳定流程 checkpoint、事件去重和刷新恢复。
- 差异：Graph checkpoint 只保存流程状态；业务状态和文件快照仍分别由 TaskSession 与现有 Checkpoint Store 管理。

## 已知问题和风险

- 普通流量仍默认使用 Legacy；阶段 9 才进行 Shadow 对照、稳定分桶和写任务灰度。
- Main Graph 的事件为兼容层摘要，不向前端暴露内部节点名称、Prompt、源码或完整工具输出。
- 是否阻止下一阶段：否。

## 回退方式

- Feature Flag：设置 `AGENT_LANGGRAPH_RUNTIME_ENABLED=false` 并重启服务。
- 数据兼容性：Graph checkpoint 使用独立目录，关闭 Flag 后 TaskSession 和 Legacy 历史仍可读取。
- 操作步骤：关闭 Flag 后新任务立即回到 Legacy；已有 Graph AgentStep 继续作为只读历史显示。

## 下一阶段准入结论

- allowed
- 依据：阶段 0～8 累计门禁、双端构建、审批边界、事件去重和跨重启恢复均通过。
