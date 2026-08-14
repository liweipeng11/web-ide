/** 阶段 0 的 Legacy 基线场景契约；仅用于后续 Runner 对照，不改变生产执行路径。 */
export type BaselineScenarioKind =
  | "question"
  | "read_analysis"
  | "single_file_edit"
  | "new_file"
  | "multi_file_edit"
  | "unauthorized_write"
  | "patch_decision"
  | "command"
  | "test_failure"
  | "tool_recovery"
  | "duplicate_tool"
  | "step_limit"
  | "restart_recovery"
  | "insufficient_evidence";

export type BaselineExpectedOutcome = "completed" | "rejected" | "failed" | "paused";

export type BaselineScenario = {
  id: string;
  kind: BaselineScenarioKind;
  title: string;
  expectedOutcome: BaselineExpectedOutcome;
  expectedSignals: readonly string[];
};

/**
 * 覆盖迁移计划规定的最小 Legacy 行为集合。
 * 场景只描述可验证结果，不保存 Prompt、源码或任何敏感配置。
 */
export const baselineScenarios: readonly BaselineScenario[] = [
  { id: "question", kind: "question", title: "普通问答", expectedOutcome: "completed", expectedSignals: ["answer"] },
  { id: "read-analysis", kind: "read_analysis", title: "只读分析", expectedOutcome: "completed", expectedSignals: ["read_only"] },
  { id: "single-file-edit", kind: "single_file_edit", title: "单文件修改", expectedOutcome: "paused", expectedSignals: ["patch_pending"] },
  { id: "new-file", kind: "new_file", title: "新建文件", expectedOutcome: "paused", expectedSignals: ["patch_pending", "new_file"] },
  { id: "multi-file-edit", kind: "multi_file_edit", title: "多文件修改", expectedOutcome: "paused", expectedSignals: ["patch_pending", "multiple_files"] },
  { id: "unauthorized-write", kind: "unauthorized_write", title: "越权写入", expectedOutcome: "rejected", expectedSignals: ["permission_denied"] },
  { id: "patch-decision", kind: "patch_decision", title: "Patch 审批或拒绝", expectedOutcome: "paused", expectedSignals: ["approval_required"] },
  { id: "command", kind: "command", title: "命令执行", expectedOutcome: "paused", expectedSignals: ["command_review"] },
  { id: "test-failure", kind: "test_failure", title: "测试失败", expectedOutcome: "failed", expectedSignals: ["verification_failed"] },
  { id: "tool-recovery", kind: "tool_recovery", title: "工具失败恢复", expectedOutcome: "completed", expectedSignals: ["tool_recovered"] },
  { id: "duplicate-tool", kind: "duplicate_tool", title: "重复工具调用", expectedOutcome: "completed", expectedSignals: ["duplicate_suppressed"] },
  { id: "step-limit", kind: "step_limit", title: "步数耗尽", expectedOutcome: "failed", expectedSignals: ["step_limit_reached"] },
  { id: "restart-recovery", kind: "restart_recovery", title: "服务重启恢复", expectedOutcome: "paused", expectedSignals: ["session_restored"] },
  { id: "insufficient-evidence", kind: "insufficient_evidence", title: "完成证据不足", expectedOutcome: "rejected", expectedSignals: ["evidence_missing"] }
];

export function getBaselineScenario(id: string): BaselineScenario {
  const scenario = baselineScenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`未知基线场景：${id}`);
  return scenario;
}
