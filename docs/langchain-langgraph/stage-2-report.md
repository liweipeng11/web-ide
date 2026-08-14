# Stage 2 实施报告

## 结果

- 状态：completed
- 当前工作包：2D
- 中断类别：none
- 开始提交：`d3e5ac5`
- 完成提交：未提交工作区
- 执行日期：2026-08-13

## 实际修改

- `apps/server/src/acceptance/langGraphStage2Acceptance.test.ts`：使用真实只读 Runtime 工具、Registry、权限管理器和临时工作区完成阶段安全验收。
- `scripts/check-langgraph-stage2.ps1`：串联 Stage 0 基线、Stage 2 安全验收、入口与灰度回归、服务端类型检查。
- `package.json`：新增 `verify:langgraph-stage2` 验收命令。
- `docs/langchain-langgraph/current-implementation.md`：记录只读 Agent、灰度模式和回退方式。
- `docs/langchain-langgraph/migration-status.md`：完成 2D，并将下一工作包推进为 3A。

## 与计划的偏差

- 偏差：安全验收集中为一个端到端测试，而不是重复建立独立的模拟工具集合。
- 原因：直接复用现有 `explorerRuntimeTools`、`ToolRegistry` 和 `PermissionManager`，可以同时验证真实工具描述、权限边界和工作区不变性。
- 影响：覆盖范围更贴近生产边界，未扩大生产代码改动。

## 验证证据

- `pnpm verify:langgraph-stage2`：通过；包含 Stage 0 基线 11 项、LangChain/LangGraph 聚焦回归 33 项、direct 入口与灰度回归 16 项、Stage 2 安全验收 1 项和服务端类型检查。
- `pnpm --dir apps/server test`：通过；主测试集 463/463，通过全部前置专项测试。
- `pnpm --dir apps/web typecheck`：通过。
- `pnpm --dir apps/web build`：通过，Vite 生产构建完成。

## 指标对比

- Legacy：`question`、`read_analysis` 两类只读基线通过率 100%。
- LangChain 只读 Agent：直接回答、搜索后读取两类场景通过率 100%。
- 差异：通过率 0 个百分点；权限违规 0；未授权写入 0；验收前后工作区文件差异 0。
- 补充安全证据：伪造 `writeFile` 调用被只读 Registry 拒绝，Agent 可在收到受控错误后恢复并正常结束。

## 已知问题和风险

- 当前只读新执行器仍由调用方注入，尚未作为默认生产执行路径装配。
- `shadow` 会增加一次模型执行成本；当前阶段只提供安全控制面，真实流量采样和成本阈值留待阶段 9。
- 是否阻止下一阶段：否。

## 回退方式

- Feature Flag：将 `AGENT_LANGGRAPH_READ_ONLY_MODE=off` 并重启服务。
- 数据兼容性：无需数据迁移；TaskSession 与 Legacy 结果契约保持不变。
- 操作步骤：关闭只读模式后，direct 请求只执行 Legacy；若同时验证过批准后 LangGraph 兼容入口，可将 `AGENT_LANGGRAPH_RUNTIME_ENABLED=false`。

## 下一阶段准入结论

- allowed
- 依据：2A～2D 均完成，阶段累计验收、全量服务端测试、双端类型检查和前端生产构建通过，且安全强制回退条件均未触发。
