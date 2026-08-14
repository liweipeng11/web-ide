# LangChain / LangGraph 迁移状态

- 当前阶段：阶段 9 进行中；Shadow 对照与脱敏指标已完成
- 当前工作包：9A 已完成；下一工作包为 9B
- 总体状态：in_progress（只读 Shadow 可量化观测已就绪；尚未启用百分比灰度）
- 最后更新：2026-08-14

| 工作包 | 状态 | 前置工作包 | 最近验证 | 备注 |
|---|---|---|---|---|
| 0A | completed | 无 | `tsx --test src/langgraph/testing/baselineScenarios.test.ts`；`pnpm typecheck` | 已创建场景契约、Fake Model 和结果归一化；不触及生产路径 |
| 0B | completed | 0A | `legacyBaselineRunner.test.ts`；`pnpm typecheck` | Runner 注入 Legacy 执行入口，校验场景终态/信号并生成稳定归一化报告 |
| 0C | completed | 0B | `pnpm verify:langgraph-stage0` | 默认关闭 Flag、14 类稳定基线、Legacy 回退、类型检查与专项回归全部通过 |
| 1A | completed | 0C | 本地类型检查；LangChain 官方 JS API 核对 | 采用现有 pnpm 与 NodeNext，不新增 Provider 专属 SDK |
| 1B | completed | 1A | `pnpm --dir apps/server test:langgraph` | 消息与响应双向适配器 |
| 1C | completed | 1B | `modelGatewayClient.test.ts`；Runtime Phase 8 | Provider Gateway 的 LangChain BaseChatModel 适配器 |
| 1D | completed | 1C | `runtimeToolAdapter` 聚焦测试 | Tool/schema 适配器仅委托受控 Runtime callTool |
| 2A | completed | 1D | `readOnlyAgentState.test.ts`；`readOnlyToolRegistry.test.ts`；`pnpm typecheck` | 状态预算、不可变更新、只读工具白名单与伪造写调用阻断已完成；未接入生产 |
| 2B | completed | 2A | `readOnlyAgent.test.ts`；`pnpm test:langgraph`；`pnpm verify:langgraph-stage0` | LangChain 消息/工具循环、重复调用抑制、预算、取消与伪造写调用恢复已通过；未接入生产 |
| 2C | completed | 2B | `runtimeSelector.test.ts`；`agentOrchestrationService.test.ts`；`pnpm verify:langgraph-stage0` | 支持 off/shadow/internal；默认 off，缺少新执行器时保持 Legacy，shadow/观测失败不改变用户结果 |
| 2D | completed | 2C | `pnpm verify:langgraph-stage2`；服务端 463 项全量测试；Web 类型检查与构建 | 只读任务通过率与 Legacy 基线一致，权限违规、未授权写入和文件差异均为 0；报告已生成 |
| 3A | completed | 2D | `planningGraphState.test.ts`；`pnpm typecheck` | 精简状态、唯一事实 reducer、并行探索 reducer 与不可变计划合并 |
| 3B | completed | 3A | `planningGraph.test.ts` | route/planner、ready/missing_context/failed 条件边与最终 `validatePlan` 门禁 |
| 3C | completed | 3B | `planningGraph.test.ts`；`mainAgentRuntime.test.ts` | `Send` fan-out/fan-in，按现有并发策略分批，统一 Plan 合并 |
| 3D | completed | 3C | `pnpm verify:langgraph-stage3` | 连续失败、有界重规划、internal 接入、Legacy 回退与累计验收通过 |
| 4A | completed | 3D | `threadIdentity.test.ts`；`taskSessionCheckpointer.test.ts` | 稳定 thread/action identity 与独立原子文件 checkpointer |
| 4B | completed | 4A | `taskSessionCheckpointer.test.ts` | 新实例恢复、thread 隔离、pending writes 与备份恢复能力 |
| 4C | completed | 4B | `agentStepAdapter.test.ts` | node/task/update/interrupt/final 映射及稳定步骤去重 |
| 4D | completed | 4C | `pnpm verify:langgraph-stage4` | 无副作用 interrupt、重启恢复、重复 resume 幂等和累计验收 |
| 5A | completed | 4D | `developerEvidenceGate.test.ts`；`pnpm typecheck` | 精简状态、依赖门禁及 context/existence/pattern/impact 四类可追踪证据校验 |
| 5B | completed | 5A | `modificationPlanGate.test.ts`；`pnpm typecheck` | create/modify/delete 意图、证据引用、重复路径、read/write scope 与范围变更请求校验 |
| 5C | completed | 5B | `developerPatchProposal.test.ts`；`pnpm typecheck` | 稳定 action/patch ID、来源追踪、计划子集、基础内容哈希、Diff 与零工作区写入 |
| 5D | completed | 5C | `pnpm verify:langgraph-stage5` | Safe Editor、Diff UI、稳定重放、前端构建、未审批零写入和阶段 0～5 累计验收 |
| 6A | completed | 5D | `patchApprovalDecision.test.ts`；`pnpm typecheck` | Patch/TaskSession/Graph 来源绑定、稳定审批与应用 action ID、超时、冲突和重放判定 |
| 6B | completed | 6A | `patchApplyNode.test.ts`；`pnpm typecheck` | 独立副作用节点复用现有 Patch Apply/Checkpoint，写入前后校验 write scope，并返回稳定应用回执 |
| 6C | completed | 6B | `patchApplicationRecovery.test.ts`；`patchApplicationGraph.test.ts`；`patchApplyNode.test.ts`；`pnpm typecheck` | 独立恢复节点、Graph checkpoint、新实例终态重放与写入后状态丢失恢复 |
| 6D | completed | 6C | `pnpm verify:langgraph-stage6` | 未审批/越权/重复写入为 0；新建、修改、删除、二进制回滚与状态存储验收通过 |
| 7A | completed | 6D | `verificationPlanNode.test.ts`；`pnpm typecheck` | 精简 Tester State、现有 verifier 规划复用、范围/证据门禁与安全命令白名单 |
| 7B | completed | 7A | `verificationExecutionNode.test.ts`；`verifier.test.ts`；`pnpm typecheck` | 冻结计划执行、执行时策略复核、结构化报告和稳定失败分类 |
| 7C | completed | 7B | `repairLoopGraph.test.ts`；`pnpm typecheck` | 实现失败回 Developer、计划失败回 Planner、环境/取消停止及循环耗尽 incomplete |
| 7D | completed | 7C | `pnpm verify:langgraph-stage7` | 统一完成策略、错误完成为 0、Runtime Phase 8、新文件、任务完成和 Safe Editor 累计验收通过 |
| 8A | completed | 7D | `mainGraph.test.ts`；`pnpm typecheck` | direct/main_loop/planned 条件路由、Planning 与计划执行子图组合、取消和契约失败收敛 |
| 8B | completed | 8A | `taskSessionMainGraph.test.ts`；`agentOrchestrationService.test.ts`；`pnpm typecheck` | Feature Flag 保护下接入批准后 TaskSession，恢复已批准计划并保持单次副作用执行 |
| 8C | completed | 8B | `agentStepAdapter.test.ts`；`taskSessionMainGraph.test.ts`；`agentOrchestrationService.test.ts`；`pnpm typecheck` | 稳定 Graph 事件实时桥接、TaskSession 步骤去重、审批前零执行及跨重启快照恢复 |
| 8D | completed | 8C | `pnpm verify:langgraph-stage8` | direct/main_loop/planned、审批等待、SSE、刷新恢复、Legacy 共存及双端构建累计验收 |
| 9A | completed | 8D | `shadowComparison.test.ts`；`runtimeSelector.test.ts`；`agentOrchestrationService.test.ts`；`pnpm --dir apps/server typecheck` | 固定维度差异、耗时分桶、JSONL 指标、观测失败隔离与 Legacy 返回语义均已验证 |
| 9B | pending | 9A | 未运行 | 稳定分桶与只读灰度 |
| 9C | pending | 9B | 未运行 | 写任务灰度与自动回退 |
| 9D | pending | 9C | 未运行 | 全量观察、回退演练和报告 |
| 10A | pending | 9D | 未运行 | Legacy 调用方审计 |
| 10B | pending | 10A | 未运行 | 清理重复编排代码 |
| 10C | pending | 10B | 未运行 | 测试、文档和运维收敛 |
| 10D | pending | 10C | 未运行 | 最终全量验收和报告 |
