import { isPathInScope } from "../../runtime/permissionManager.js";
import type { Task } from "../../runtime/contracts.js";
import { evaluateDeveloperEvidence } from "./developerEvidenceGate.js";
import type {
  DeveloperEvidence,
  DeveloperGraphStateValue,
  DeveloperModificationIntent,
  DeveloperModificationPlan
} from "./developerGraphState.js";

export interface ModificationPlanGateResult {
  ready: boolean;
  requiredWriteScope: string[];
  errors: string[];
}

function normalizedPathKey(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function pathIsInScope(filePath: string, scope: string[]) {
  try {
    return isPathInScope(filePath, scope);
  } catch {
    return false;
  }
}

function validateIntent(intent: DeveloperModificationIntent, task: Task, evidenceById: Map<string, DeveloperEvidence>) {
  const errors: string[] = [];
  if (!intent.path.trim()) errors.push("修改计划包含空文件路径。");
  if (!(["create", "modify", "delete"] as const).includes(intent.operation)) {
    errors.push(`文件 ${intent.path || "<unknown>"} 的操作类型无效。`);
  }
  if (!intent.reason.trim() || intent.reason.length > 500) {
    errors.push(`文件 ${intent.path || "<unknown>"} 缺少有效修改原因。`);
  }
  if (intent.evidenceIds.length === 0) {
    errors.push(`文件 ${intent.path || "<unknown>"} 没有引用证据。`);
  }

  const referencedEvidence = intent.evidenceIds.map((id) => evidenceById.get(id));
  const unknownEvidenceIds = intent.evidenceIds.filter((id, index) => !id.trim() || !referencedEvidence[index]);
  if (unknownEvidenceIds.length) {
    errors.push(`文件 ${intent.path || "<unknown>"} 引用了未知证据：${unknownEvidenceIds.join(", ")}`);
  }
  const referencedKinds = new Set(referencedEvidence.flatMap((item) => item ? [item.kind] : []));
  if (!referencedKinds.has("existence") || !referencedKinds.has("impact")) {
    errors.push(`文件 ${intent.path || "<unknown>"} 必须同时引用存在性和影响分析证据。`);
  }

  // 修改和删除已有文件前必须具备读取权限；新建文件只要求写入授权。
  if (intent.operation !== "create" && intent.path.trim() && !pathIsInScope(intent.path, task.readScope)) {
    errors.push(`已有文件 ${intent.path} 不在 readScope 内。`);
  }
  return errors;
}

/**
 * 修改计划必须是证据就绪任务的有限文件集合；本门禁只检查授权，不访问或修改文件系统。
 * write scope 外目标单独返回 requiredWriteScope，交由上层走既有范围变更审批。
 */
export function evaluateModificationPlan(input: {
  task: Task;
  completedTaskIds: string[];
  evidence: DeveloperEvidence[];
  plan: DeveloperModificationPlan;
}): ModificationPlanGateResult {
  const evidenceGate = evaluateDeveloperEvidence(input);
  const errors = evidenceGate.ready ? [] : [
    ...evidenceGate.blockers,
    ...(evidenceGate.missingEvidence.length
      ? [`缺少 Developer 证据：${evidenceGate.missingEvidence.join(", ")}`]
      : [])
  ];
  const { task, plan } = input;
  if (plan.taskId !== task.id) errors.push(`修改计划 taskId ${plan.taskId} 与任务 ${task.id} 不一致。`);
  if (!plan.summary.trim() || plan.summary.length > 500) errors.push("修改计划缺少有效摘要。");
  if (plan.files.length === 0) errors.push("修改计划至少需要一个文件意图。");

  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const seenPaths = new Set<string>();
  const requiredWriteScope: string[] = [];
  for (const intent of plan.files) {
    errors.push(...validateIntent(intent, task, evidenceById));
    const key = normalizedPathKey(intent.path);
    if (key && seenPaths.has(key)) errors.push(`修改计划包含重复文件：${intent.path}`);
    if (key) seenPaths.add(key);

    if (!intent.path.trim()) continue;
    try {
      if (!isPathInScope(intent.path, task.writeScope)) requiredWriteScope.push(intent.path);
    } catch {
      errors.push(`文件路径不是合法的工作区相对路径：${intent.path}`);
    }
  }

  return {
    ready: errors.length === 0 && requiredWriteScope.length === 0,
    requiredWriteScope: [...new Map(requiredWriteScope.map((path) => [normalizedPathKey(path), path])).values()],
    errors: [...new Set(errors)]
  };
}

/** 计划门禁节点不会创建 PendingPatch，只推进到可安全生成候选 Patch 的状态。 */
export function modificationPlanGateNode(state: DeveloperGraphStateValue): Partial<DeveloperGraphStateValue> {
  if (!state.modificationPlan) {
    return { status: "blocked", blockers: ["Developer 缺少结构化修改计划。"], requiredWriteScope: [] };
  }
  const result = evaluateModificationPlan({
    task: state.task,
    completedTaskIds: state.completedTaskIds,
    evidence: state.evidence,
    plan: state.modificationPlan
  });
  return {
    status: result.ready
      ? "scope_ready"
      : result.errors.length
        ? "blocked"
        : result.requiredWriteScope.length
          ? "scope_change_required"
          : "blocked",
    requiredWriteScope: result.requiredWriteScope,
    blockers: result.errors
  };
}
