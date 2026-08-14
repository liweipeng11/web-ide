import crypto from "node:crypto";

function stableId(prefix: string, parts: string[]): string {
  const normalized = parts.map((part) => part.trim());
  if (normalized.some((part) => !part)) throw new Error(`${prefix} 标识字段不能为空。`);
  const digest = crypto.createHash("sha256").update(normalized.join("\u0000")).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

/** TaskSession 重试、服务重启和审批恢复始终使用同一 Graph thread ID。 */
export function graphThreadIdForTask(taskSessionId: string, graphName = "main"): string {
  return stableId("task", [taskSessionId, graphName]);
}

/** 同一任务的不同子图使用独立 namespace，避免状态互相覆盖。 */
export function graphCheckpointNamespace(graphName: string): string {
  return stableId("graph", [graphName]);
}

/** 审批 action ID 由任务和业务动作稳定派生，可用于拒绝重复 resume。 */
export function graphApprovalActionId(taskSessionId: string, actionKey: string): string {
  return stableId("graph-approval", [taskSessionId, actionKey]);
}

/** Graph 内无副作用动作也使用稳定 ID，供 checkpoint 重放和产物去重。 */
export function graphActionId(taskId: string, graphRunId: string, actionKey: string): string {
  return stableId("graph-action", [taskId, graphRunId, actionKey]);
}
