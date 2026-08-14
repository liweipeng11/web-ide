# Stage 9 实施报告

## 结果

- 状态：incomplete（9A completed；9B～9D pending）
- 当前工作包：9A Shadow 对照器和脱敏指标
- 中断类别：none
- 开始提交：`ef66cbd`
- 完成提交：未提交工作区
- 执行日期：2026-08-14

## 实际修改

- `apps/server/src/langgraph/rollout/shadowComparison.ts`：固定维度对照、耗时分桶和独立 JSONL 指标写入。
- `apps/server/src/langgraph/rollout/runtimeSelector.ts`：在只读 Shadow 双运行中采集脱敏结构差异，并隔离观测异常。
- `apps/server/src/agentOrchestrationService.ts`：为 direct 结果提供固定结构描述，生产默认观测写入独立指标文件。
- 对应测试：覆盖敏感值不落盘、并发指标写入、结构差异、Legacy 返回和失败隔离。

## 与计划的偏差

- 偏差：本工作包不启用真实模型采样率或百分比流量。
- 原因：稳定分桶属于 9B；9A 只建立可量化且安全的对照基础。
- 影响：生产默认仍为 `off`，不会扩大 LangGraph 接管范围。

## 验证证据

- 命令：`pnpm --dir apps/server exec tsx --test src/langgraph/rollout/shadowComparison.test.ts src/langgraph/rollout/runtimeSelector.test.ts src/agentOrchestrationService.test.ts`
- 结果：通过。
- 测试数量：20 项通过，0 项失败。
- 命令：`pnpm --dir apps/server typecheck`
- 结果：通过。

## 指标对比

- Legacy：Shadow 模式继续作为唯一用户返回来源。
- LangGraph：记录完成/失败状态、固定结果维度差异和粗粒度耗时区间。
- 差异：不保存 Prompt、回答、源码、工具输出、错误正文或结果维度原值。

## 已知问题和风险

- 问题：尚未实现稳定任务分桶、采样成本上限和灰度自动回退门禁。
- 是否阻止下一阶段：否；上述能力分别属于 9B 和 9C。

## 回退方式

- Feature Flag：设置 `AGENT_LANGGRAPH_READ_ONLY_MODE=off` 并重启服务。
- 数据兼容性：Shadow 指标位于独立 JSONL，不参与 TaskSession 或 Graph checkpoint 恢复。
- 操作步骤：关闭只读模式即可停止双运行，无需迁移或删除业务数据。

## 下一阶段准入结论

- allowed
- 依据：9A 聚焦测试和服务端类型检查通过，Legacy 用户返回语义与安全边界保持不变。
