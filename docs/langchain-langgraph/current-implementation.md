# LangChain / LangGraph 当前实现

## 架构边界

- LangChain `BaseChatModel` 已接入非流式模型入口，底层继续复用 Provider Gateway、任务预算、重试和指标。
- LangChain Tool 适配器只持有工具描述与 `RuntimeContext.callTool` 委托，不持有真实执行器，不绕过 Registry、权限和作用域检查。
- LangChain 只读 Agent 已具备有界消息/工具循环、重复调用抑制、取消处理和只读工具白名单；模型伪造写工具时会返回受控错误，不会触发 Runtime 写入。
- Planner / Explorer 的只读控制流已由 LangGraph `StateGraph` 表达：包含路由、计划、缺少上下文、受限并行探索、证据合并、计划校验和有界重规划。
- Explorer 使用 `Send` 动态分发，同一批结果通过 reducer 汇聚并回写唯一 Plan；并发批次上限继续复用现有 Runtime 稳定性策略。
- Graph checkpoint 使用独立的原子 JSON 命名空间；TaskSession ID 稳定映射为 thread ID，服务重启后可恢复，且不会覆盖旧 TaskSession。
- Graph node/task/update/interrupt/final 事件可转换为现有 AgentStep；稳定步骤 ID 会抑制恢复重放造成的重复展示。
- 已建立无副作用审批 interrupt/resume 协议，重复 resume 不会重复推进决定节点；真实 Patch 和写入仍未接入该图。
- Developer Patch-only 子图已具备四类证据门禁、结构化修改计划、read/write scope 校验、稳定 Patch 来源和基础内容哈希校验；只生成与现有 Safe Editor、Patch Store、Diff UI 兼容的待审批 Patch。
- 相同 task、Graph Run 和候选内容会复用同一 Pending Patch；Graph checkpoint 只保存 Patch 引用，不保存完整源码，未审批时不会调用文件写入或命令能力。
- direct 只读入口支持 `off`、`shadow`、`internal` 三种模式；`shadow` 始终返回 Legacy 结果，`internal` 仅对调用方显式标记的内部任务采用新结果，新路径异常会回退 Legacy。
- LangGraph 已实现批准后任务的兼容入口判断与执行分支，但生产默认关闭；TaskSession 仍是业务状态真相来源。
- Main、Planner、Explorer、Developer、Tester 的现有实现、Patch、Safe Editor、Checkpoint、完成策略和前端协议保持不变。

## 运行与回退

默认关闭：

```env
AGENT_LANGGRAPH_RUNTIME_ENABLED=false
AGENT_LANGGRAPH_READ_ONLY_MODE=off
```

`AGENT_LANGGRAPH_READ_ONLY_MODE` 可在受控环境设置为 `shadow` 或 `internal`。`shadow` 会执行新路径用于脱敏对照，但用户结果仍来自 Legacy；`internal` 还要求请求被显式标记为内部任务。需要紧急回退时将该变量恢复为 `off` 并重启服务，无需迁移数据。

`AGENT_LANGGRAPH_RUNTIME_ENABLED` 仅在受控验证环境设置为 `true`。需要回退时恢复为 `false` 并重启服务；回退仅切换批准后任务的控制面，不迁移或删除 TaskSession 数据。

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
```

## 后续边界

当前 Developer Graph 停止在 `patch_pending_approval`，尚未接入审批后的真实应用。阶段 6 必须把审批节点与 Patch 应用副作用节点分离，并继续复用现有 Patch Apply、文件 Checkpoint、权限和幂等控制，不能让 Graph 节点直接使用 `fs` 写文件。
