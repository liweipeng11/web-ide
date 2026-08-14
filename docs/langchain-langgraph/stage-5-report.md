# Stage 5 实施报告

## 结果

- 状态：completed
- 当前工作包：5D
- 中断类别：none
- 执行日期：2026-08-14

## 实际修改

- `langgraph/developer/developerGraphState.ts`：定义 Developer 精简状态、证据、修改意图和 Patch 引用。
- `langgraph/developer/developerEvidenceGate.ts`：执行任务依赖、read scope 和四类可追踪证据门禁。
- `langgraph/developer/modificationPlanGate.ts`：校验 create、modify、delete 意图、证据引用及 write scope。
- `langgraph/developer/developerPatchProposal.ts`：生成稳定、可追踪、基于内容哈希的待审批 Patch。
- `patchStore.ts`、`types.ts`：向后兼容增加稳定 Patch 创建/复用和 LangGraph 来源元数据。
- `acceptance/langGraphStage5Acceptance.test.ts`：验收 Safe Editor、Diff UI、幂等重放及零工作区写入。
- `scripts/check-langgraph-stage5.ps1`：提供阶段 0～5 累计验收入口。

## 与计划的偏差

- 偏差：Patch Store 仍是现有进程内存实现，阶段 5 只在 Graph checkpoint 中保存稳定 Patch 引用。
- 原因：本阶段边界是生成待审批 Patch；Patch 应用、服务重启后的副作用恢复属于阶段 6。
- 影响：不会产生未审批写入；服务重启后的 Patch 实体恢复需由阶段 6 与现有会话/Checkpoint 机制一起处理。

## 验证证据

- `pnpm verify:langgraph-stage5`：通过。
- Developer Patch-only 专项：16 项通过。
- Patch Store、Diff 和 Safe Editor 契约：24 项通过。
- Stage 5 端到端验收：1 项通过。
- LangGraph 专项回归：63 项通过。
- 服务端全量主测试集：464 项通过；pretest 全部通过。
- 服务端与 Web 类型检查：通过。
- Web 生产构建：通过。
- 未审批工作区写入：0。

## 指标对比

- Legacy：现有 Patch Store、Safe Editor、Diff UI 和 Patch Apply 契约保持通过。
- LangGraph：候选 Patch 文件集合、状态和 Diff 字段与 Legacy 契约兼容。
- 差异：新增稳定 action/patch ID、Graph 来源和基础内容哈希；不改变旧 Patch 调用方。

## 已知问题和风险

- 服务端全量并发测试期间记录过一次既有运行指标文件原子重命名 `EPERM` 警告；测试继续完成且 464 项全部通过。
- 阶段 5 不恢复进程重启后丢失的内存 Pending Patch，也不允许审批后写入；这些能力属于阶段 6。
- 是否阻止下一阶段：否。

## 回退方式

- Feature Flag：生产 LangGraph 入口仍默认关闭；保持 `AGENT_LANGGRAPH_RUNTIME_ENABLED=false` 即可停用新路径。
- 数据兼容性：`PendingPatch.source` 是可选字段，旧 Patch 和旧会话无需迁移。
- 操作步骤：关闭 LangGraph Flag 并重启服务；Legacy Patch 流程继续使用原随机 ID 创建入口。

## 下一阶段准入结论

- allowed
- 依据：证据、范围、Patch、Safe Editor、Diff、幂等和零写入验收全部通过；阶段 6 可从审批决策与稳定 action ID 开始，但必须继续把审批和真实副作用节点分离。
