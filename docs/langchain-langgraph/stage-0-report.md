# 阶段 0 报告

## 当前工作包

- 工作包：0C（已完成，阶段 0 验收通过）
- 范围：新增阶段验收测试与统一脚本，将 LangGraph Feature Flag 和 Capability 恢复为默认关闭，并验证 Legacy 生产回退入口。
- 实现边界：保留已存在的适配器和兼容图代码；未完成的新路径只有显式配置才可进入。
- 计划偏差：工作区在 0C 前已提前存在阶段 1 适配器和兼容图，因此本工作包没有删除这些用户改造，只纠正默认启用顺序。

## 恢复点

- 已完成：0A～0C 的场景契约、Fake Model、归一化 Runner、默认关闭开关、阶段验收和统一验证入口。
- 验证：`pnpm verify:langgraph-stage0` 通过；其中基线与验收 11 项、Feature Flag 与 Legacy 回退 24 项、LangGraph 专项 15 项均通过，服务端类型检查通过。
- 累计回归：`pnpm --dir apps/server test` 通过（最终全量集合 463 项通过，前置专项也全部通过）；`pnpm --dir apps/web typecheck` 与 `pnpm --dir apps/web build` 通过。
- 未完成：细粒度只读 Agent、子图、持久化、写入审批和最终 Main Graph 切换仍属于后续阶段。
- 下一条安全命令：读取阶段 2 的 2A 契约与现有只读工具 Registry，再实现只读 Agent 状态和受限 Registry。

## 风险与回退

- 风险：14 类场景使用确定性执行器冻结稳定结果；实际生产 Legacy 回退由现有编排服务回归覆盖，而不是让离线 Runner 发起真实外部模型请求。全量测试期间出现一次 Windows 文件占用导致的指标持久化告警，但测试自身重试/容错后 463 项全部通过，不影响本阶段结论。
- 回退：删除阶段 0 测试骨架和验收脚本、移除统一 package script，并保留 `AGENT_LANGGRAPH_RUNTIME_ENABLED=false`；没有业务数据迁移。
