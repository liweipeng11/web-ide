import { Annotation } from "@langchain/langgraph";
import type { Task } from "../../runtime/contracts.js";

export type DeveloperGraphStatus =
  | "preparing"
  | "evidence_required"
  | "evidence_ready"
  | "scope_change_required"
  | "scope_ready"
  | "patch_pending_approval"
  | "blocked";

export type DeveloperEvidenceKind = "context" | "existence" | "pattern" | "impact";
export type DeveloperEvidenceSource = "task_context" | "explorer" | "read_tool";

/**
 * Developer 图只保存结构化证据引用，不保存文件正文或工具原始输出。
 * sourceRef 用于关联既有任务或只读工具调用，便于后续追踪 Patch 来源。
 */
export interface DeveloperEvidence {
  id: string;
  kind: DeveloperEvidenceKind;
  source: DeveloperEvidenceSource;
  sourceRef: string;
  summary: string;
  paths: string[];
}

export type DeveloperFileOperation = "create" | "modify" | "delete";

/** 5A 仅预留结构化修改计划；具体 write scope 校验由 5B 实现。 */
export interface DeveloperModificationIntent {
  path: string;
  operation: DeveloperFileOperation;
  reason: string;
  evidenceIds: string[];
}

export interface DeveloperModificationPlan {
  taskId: string;
  summary: string;
  files: DeveloperModificationIntent[];
}

export interface DeveloperPatchProposalReference {
  patchId: string;
  actionId: string;
  taskId: string;
  graphRunId: string;
  filePaths: string[];
}

function appendUniqueStrings(current: string[], next: string[]) {
  return [...new Set([...current, ...next].map((item) => item.trim()).filter(Boolean))];
}

function mergeEvidence(current: DeveloperEvidence[], next: DeveloperEvidence[]) {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const evidence of next) merged.set(evidence.id, evidence);
  return [...merged.values()];
}

/** Developer Patch-only 子图的精简状态，不承载完整源码和候选 Patch 正文。 */
export const DeveloperGraphState = Annotation.Root({
  task: Annotation<Task>,
  graphRunId: Annotation<string>,
  status: Annotation<DeveloperGraphStatus>,
  completedTaskIds: Annotation<string[]>({ reducer: appendUniqueStrings, default: () => [] }),
  facts: Annotation<string[]>({ reducer: appendUniqueStrings, default: () => [] }),
  evidence: Annotation<DeveloperEvidence[]>({ reducer: mergeEvidence, default: () => [] }),
  missingEvidence: Annotation<DeveloperEvidenceKind[]>({ reducer: (_current, next) => [...next], default: () => [] }),
  blockers: Annotation<string[]>({ reducer: appendUniqueStrings, default: () => [] }),
  requiredWriteScope: Annotation<string[]>({ reducer: appendUniqueStrings, default: () => [] }),
  modificationPlan: Annotation<DeveloperModificationPlan | null>,
  patchProposal: Annotation<DeveloperPatchProposalReference | null>
});

export type DeveloperGraphStateValue = typeof DeveloperGraphState.State;
