import { isPathInScope } from "../../runtime/permissionManager.js";
import type { Task } from "../../runtime/contracts.js";
import type {
  DeveloperEvidence,
  DeveloperEvidenceKind,
  DeveloperGraphStateValue
} from "./developerGraphState.js";

export const REQUIRED_DEVELOPER_EVIDENCE = ["context", "existence", "pattern", "impact"] as const;

export interface DeveloperEvidenceGateResult {
  ready: boolean;
  missingEvidence: DeveloperEvidenceKind[];
  blockers: string[];
}

function evidenceIsTraceable(item: DeveloperEvidence) {
  if (!item.id.trim() || !item.sourceRef.trim() || !item.summary.trim()) return false;
  if (item.summary.length > 500) return false;

  // 文件相关结论必须指向已读取的路径，不能只依赖模型的无来源判断。
  if (item.kind !== "context" && item.paths.length === 0) return false;
  return item.paths.every((path) => path.trim().length > 0);
}

function invalidEvidenceBlockers(task: Task, evidence: DeveloperEvidence[]) {
  const blockers: string[] = [];
  for (const item of evidence) {
    if (!evidenceIsTraceable(item)) {
      blockers.push(`证据 ${item.id || "<unknown>"} 缺少可追踪来源或有效摘要。`);
      continue;
    }
    const outOfReadScope = item.paths.filter((path) => !isPathInScope(path, task.readScope));
    if (outOfReadScope.length) {
      blockers.push(`证据 ${item.id} 引用了 read scope 外路径：${outOfReadScope.join(", ")}`);
    }
  }
  return blockers;
}

/**
 * 在生成修改计划前执行确定性门禁：任务类型、依赖、读写范围和四类证据缺一不可。
 * 本函数没有文件或 Patch 副作用，适合在 checkpoint 恢复后重复执行。
 */
export function evaluateDeveloperEvidence(input: {
  task: Task;
  completedTaskIds: string[];
  evidence: DeveloperEvidence[];
}): DeveloperEvidenceGateResult {
  const { task, evidence } = input;
  const blockers: string[] = [];
  if (task.type !== "implement") blockers.push(`任务 ${task.id} 不是 implement Task。`);
  if (task.readScope.length === 0) blockers.push(`任务 ${task.id} 缺少 readScope。`);
  if (task.writeScope.length === 0) blockers.push(`任务 ${task.id} 缺少 writeScope。`);

  const completed = new Set(input.completedTaskIds);
  const missingDependencies = task.dependencies.filter((dependency) => !completed.has(dependency));
  if (missingDependencies.length) {
    blockers.push(`任务 ${task.id} 的依赖尚未完成：${missingDependencies.join(", ")}`);
  }
  blockers.push(...invalidEvidenceBlockers(task, evidence));

  const validKinds = new Set(
    evidence.filter((item) => evidenceIsTraceable(item)
      && item.paths.every((path) => isPathInScope(path, task.readScope)))
      .map((item) => item.kind)
  );
  const missingEvidence = REQUIRED_DEVELOPER_EVIDENCE.filter((kind) => !validKinds.has(kind));
  return {
    ready: blockers.length === 0 && missingEvidence.length === 0,
    missingEvidence: [...missingEvidence],
    blockers
  };
}

/** LangGraph 节点只返回状态增量，避免原地修改 checkpoint 中的数组。 */
export function developerEvidenceGateNode(state: DeveloperGraphStateValue): Partial<DeveloperGraphStateValue> {
  const result = evaluateDeveloperEvidence({
    task: state.task,
    completedTaskIds: state.completedTaskIds,
    evidence: state.evidence
  });
  return {
    status: result.ready ? "evidence_ready" : result.blockers.length ? "blocked" : "evidence_required",
    missingEvidence: result.missingEvidence,
    blockers: result.blockers
  };
}

