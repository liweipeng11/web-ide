import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCheckpoint } from "./checkpointStore.js";
import { HttpError } from "./errors.js";
import { legacyProjectRuntimeDirectory, listJsonFilesWithLegacyFallback, projectRuntimeDirectory } from "./statePaths.js";
import { readJsonStateFile, writeJsonStateFile } from "./stateFileStorage.js";
import type { AgentMessage, AgentMessageRole, AgentMode, AgentStep, DeliveryUnit, DeliveryUnitStatus, FileEditLifecycleEvent, FileEditLifecycleEventType, PatchFilterReason, PatchFilterStage, PatchGenerationDiagnostics, PatchLifecycleEvent, PatchLifecycleEventType, PendingAgentToolCall, RecoveryDecision, TaskContinuation, TaskPlanItem, TaskPlanItemStatus, TaskPlanRevision, TaskPlanRevisionTrigger, TaskRuntimeEvidence, TaskSession, TaskSessionFinalizationSource, TaskSessionTerminalStatus, ToolFailureDiagnostic } from "./types.js";
import type { CandidateFileRecord, ContextSelectionSnapshot, EvidenceRecord, MissingRequirementRecord, PatchCompletenessReport, RequiredCompanionFile } from "./contextSelection/types.js";
import type { GitCommitRecord } from "./gitWorkflow/types.js";
import type { TaskWorkflowSnapshot, TaskWorkflowSource, TaskWorkflowType } from "./taskWorkflow/index.js";
import { isTerminalTaskSessionStatus } from "./taskWorkflow/index.js";
import { getTaskMetricsSnapshot, recordTaskSessionPersistenceMetrics, scheduleTaskMetricsFinalization } from "./observability/index.js";
import type { ContextBudgetSnapshot, StructuredContextSummary } from "./contracts/context.js";
import { deleteStoredContextArtifacts } from "./contextBudget/artifactStore.js";
import { normalizeStructuredModificationPlan, type StructuredModificationPlan } from "./safeEditor/index.js";

function taskSessionDirectory() {
  return projectRuntimeDirectory("task-sessions");
}

function legacyTaskSessionDirectory() {
  return legacyProjectRuntimeDirectory("task-sessions");
}

function sanitizeTaskSessionFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || crypto.randomUUID();
}

function taskSessionPath(taskSessionId: string) {
  return path.join(taskSessionDirectory(), `${sanitizeTaskSessionFileName(taskSessionId)}.json`);
}

function legacyTaskSessionPath(taskSessionId: string) {
  return path.join(legacyTaskSessionDirectory(), `${sanitizeTaskSessionFileName(taskSessionId)}.json`);
}

function unique(values: string[]) {
  return [...new Set(values.filter((value) => value.trim()))];
}

function normalizeTaskRuntimeEvidence(value: unknown): TaskRuntimeEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<TaskRuntimeEvidence>;
  if (typeof record.taskRunId !== "string" || !record.taskRunId.trim()) return undefined;

  const lastValidationStatus = record.lastValidationStatus === "success"
    || record.lastValidationStatus === "failed"
    || record.lastValidationStatus === "running"
    || record.lastValidationStatus === "cancelled"
    ? record.lastValidationStatus
    : undefined;

  return {
    taskRunId: record.taskRunId.trim(),
    appliedFilePaths: unique(Array.isArray(record.appliedFilePaths) ? record.appliedFilePaths.filter((item): item is string => typeof item === "string") : []),
    generatedPatchIds: unique(Array.isArray(record.generatedPatchIds) ? record.generatedPatchIds.filter((item): item is string => typeof item === "string") : []),
    lastMutationAt: typeof record.lastMutationAt === "number" && Number.isFinite(record.lastMutationAt) ? record.lastMutationAt : undefined,
    lastValidationAt: typeof record.lastValidationAt === "number" && Number.isFinite(record.lastValidationAt) ? record.lastValidationAt : undefined,
    ...(lastValidationStatus ? { lastValidationStatus } : {})
  };
}

function mergeTaskRuntimeEvidence(current: TaskRuntimeEvidence | undefined, incoming: TaskRuntimeEvidence) {
  if (!current) return incoming;

  // taskRunId 是证据所属运行的边界；迟到的旧 Runtime 不能覆盖当前任务运行。
  if (current.taskRunId !== incoming.taskRunId) return current;

  const currentValidationAt = current.lastValidationAt ?? 0;
  const incomingValidationAt = incoming.lastValidationAt ?? 0;
  let lastValidationAt = current.lastValidationAt;
  let lastValidationStatus = current.lastValidationStatus;

  if (incomingValidationAt > currentValidationAt) {
    lastValidationAt = incoming.lastValidationAt;
    lastValidationStatus = incoming.lastValidationStatus;
  } else if (incomingValidationAt === currentValidationAt) {
    // 相同时间戳无法证明先后顺序时采用保守状态，避免迟到快照把失败覆盖为成功。
    const conservativeStatus = [current.lastValidationStatus, incoming.lastValidationStatus]
      .find((status) => status === "failed" || status === "cancelled" || status === "running");
    lastValidationStatus = conservativeStatus ?? incoming.lastValidationStatus ?? current.lastValidationStatus;
  }

  return {
    taskRunId: current.taskRunId,
    appliedFilePaths: unique([...current.appliedFilePaths, ...incoming.appliedFilePaths]),
    generatedPatchIds: unique([...current.generatedPatchIds, ...incoming.generatedPatchIds]),
    lastMutationAt: Math.max(current.lastMutationAt ?? 0, incoming.lastMutationAt ?? 0) || undefined,
    lastValidationAt,
    ...(lastValidationStatus ? { lastValidationStatus } : {})
  };
}

function withoutValues(values: string[], excluded: string[]) {
  const excludedSet = new Set(excluded);
  return values.filter((value) => !excludedSet.has(value));
}

type TaskSessionUpdate = (session: TaskSession) => TaskSession | Promise<TaskSession>;
type PendingTaskSessionUpdate = {
  update: TaskSessionUpdate;
  resolve: (session: TaskSession) => void;
  reject: (error: unknown) => void;
};
type TaskSessionUpdateBatch = {
  updates: PendingTaskSessionUpdate[];
  timer: ReturnType<typeof setTimeout> | null;
};

const taskSessionWriteQueues = new Map<string, Promise<void>>();
const taskSessionUpdateBatches = new Map<string, TaskSessionUpdateBatch>();
const lastPersistedTaskSessionHashes = new Map<string, string>();
export const taskSessionWriteCoalesceWindowMs = 20;
const taskSessionRenameRetryDelaysMs = [20, 50, 100, 200, 400];

function isRetryableTaskSessionRenameError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function renameTaskSessionFileWithRetry(taskSessionId: string, source: string, destination: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const delayMs = taskSessionRenameRetryDelaysMs[attempt];

      if (delayMs === undefined || !isRetryableTaskSessionRenameError(error)) {
        throw error;
      }

      recordTaskSessionPersistenceMetrics(taskSessionId, { taskSessionRenameRetryCount: 1 });
      // Windows 的杀毒、索引或同步程序可能短暂占用目标文件，等待后重试可保留原子替换语义。
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function flushTaskSessionUpdateBatch(taskSessionId: string) {
  const batch = taskSessionUpdateBatches.get(taskSessionId);
  if (!batch) return taskSessionWriteQueues.get(taskSessionId);
  taskSessionUpdateBatches.delete(taskSessionId);
  if (batch.timer) clearTimeout(batch.timer);

  if (batch.updates.length > 1) {
    recordTaskSessionPersistenceMetrics(taskSessionId, { taskSessionWriteCoalescedCount: batch.updates.length - 1 });
  }

  const previous = taskSessionWriteQueues.get(taskSessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    let current: TaskSession;
    try {
      current = await readTaskSessionRecord(taskSessionId);
    } catch (error) {
      for (const pending of batch.updates) pending.reject(error);
      return;
    }

    const completed: Array<{ pending: PendingTaskSessionUpdate; result: TaskSession }> = [];
    for (const pending of batch.updates) {
      try {
        // 同一任务的更新严格按提交顺序作用于内存快照，单个更新失败不阻断后续更新。
        current = await pending.update(current);
        completed.push({ pending, result: current });
      } catch (error) {
        pending.reject(error);
      }
    }

    try {
      if (completed.length) await writeTaskSession(current);
      for (const item of completed) item.pending.resolve(item.result);
    } catch (error) {
      for (const item of completed) item.pending.reject(error);
    }
  });

  taskSessionWriteQueues.set(taskSessionId, next);
  await next;
  if (taskSessionWriteQueues.get(taskSessionId) === next) taskSessionWriteQueues.delete(taskSessionId);
}

async function enqueueTaskSessionUpdate(taskSessionId: string, update: TaskSessionUpdate, options: { flushImmediately?: boolean } = {}) {
  recordTaskSessionPersistenceMetrics(taskSessionId, { taskSessionUpdateCount: 1 });
  const result = new Promise<TaskSession>((resolve, reject) => {
    let batch = taskSessionUpdateBatches.get(taskSessionId);
    if (!batch) {
      batch = { updates: [], timer: null };
      taskSessionUpdateBatches.set(taskSessionId, batch);
    }
    batch.updates.push({ update, resolve, reject });

    if (options.flushImmediately) {
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = null;
      // 关键状态在当前同步调用栈结束后立即冲刷，同时仍可吸收同一轮已排队的更新。
      queueMicrotask(() => void flushTaskSessionUpdateBatch(taskSessionId));
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => void flushTaskSessionUpdateBatch(taskSessionId), taskSessionWriteCoalesceWindowMs);
    }
  });
  return result;
}

export async function flushPendingTaskSessionWrites(taskSessionId?: string) {
  do {
    const pendingIds = taskSessionId
      ? taskSessionUpdateBatches.has(taskSessionId) ? [taskSessionId] : []
      : [...taskSessionUpdateBatches.keys()];
    await Promise.all(pendingIds.map((id) => flushTaskSessionUpdateBatch(id)));
    const queues = taskSessionId
      ? [taskSessionWriteQueues.get(taskSessionId)].filter((queue): queue is Promise<void> => Boolean(queue))
      : [...taskSessionWriteQueues.values()];
    await Promise.all(queues);
  } while (taskSessionId ? taskSessionUpdateBatches.has(taskSessionId) : taskSessionUpdateBatches.size > 0);
}

function getStringField(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return typeof record[field] === "string" ? record[field] : "";
}

function getFilesReadFromStep(step: AgentStep) {
  if (step.type === "tool_call" && step.toolName === "readFile") {
    return unique([getStringField(step.input, "filePath")]);
  }

  if (step.type === "tool_result" && step.toolName === "readFile") {
    return unique([getStringField(step.output, "filePath")]);
  }

  return [];
}

function getFilesChangedFromStep(step: AgentStep) {
  if (step.type === "edit") return step.files;
  if (step.type === "checkpoint") return step.files;
  return [];
}

function getCommandsFromStep(step: AgentStep) {
  return step.type === "command" ? [step.command] : [];
}

function isTaskPlanItemStatus(value: unknown): value is TaskPlanItemStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked";
}

function isTaskSessionStatus(value: unknown): value is TaskSession["status"] {
  return [
    "running",
    "awaiting_approval",
    "awaiting_user",
    "paused",
    "success",
    "incomplete",
    "blocked",
    "failed",
    "cancelled",
    "awaiting_replan"
  ].includes(String(value));
}

function isAgentRuntimeStatus(value: unknown): value is NonNullable<TaskSession["runtimeStatus"]> {
  return value === "completed"
    || value === "awaiting_approval"
    || value === "incomplete"
    || value === "blocked"
    || value === "step_limit_reached"
    || value === "no_progress";
}

function isTaskSessionTerminalStatus(value: unknown): value is TaskSessionTerminalStatus {
  return isTaskSessionStatus(value) && isTerminalTaskSessionStatus(value);
}

function isTaskSessionFinalizationSource(value: unknown): value is TaskSessionFinalizationSource {
  return value === "agent_runtime"
    || value === "plan_runtime"
    || value === "auto_validation"
    || value === "legacy_chat"
    || value === "provider_error"
    || value === "client_disconnect"
    || value === "patch_rejection"
    || value === "route_error";
}

function normalizeTaskPlanItems(items: unknown): TaskPlanItem[] {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item): item is Partial<TaskPlanItem> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const now = Date.now();

      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id : `plan-${crypto.randomUUID()}`,
        workflowStepId: typeof item.workflowStepId === "string" && item.workflowStepId.trim() ? item.workflowStepId.trim() : undefined,
        title: typeof item.title === "string" ? item.title : "",
        status: isTaskPlanItemStatus(item.status) ? item.status : "pending",
      note: typeof item.note === "string" ? item.note : undefined,
      evidence:
          item.evidence && typeof item.evidence === "object" && !Array.isArray(item.evidence)
            ? {
                stepIds: Array.isArray(item.evidence.stepIds) ? item.evidence.stepIds.filter((value): value is string => typeof value === "string") : [],
                files: Array.isArray(item.evidence.files) ? item.evidence.files.filter((value): value is string => typeof value === "string") : [],
                commands: Array.isArray(item.evidence.commands) ? item.evidence.commands.filter((value): value is string => typeof value === "string") : []
              }
            : { stepIds: [], files: [], commands: [] },
      createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now
      };
    })
    .filter((item) => item.title.trim());
}

function snapshotTaskPlanItems(items: unknown) {
  // 只保存计划标题和状态，避免修订历史膨胀，同时保留足够的审阅线索。
  return normalizeTaskPlanItems(items).map((item) => ({
    title: item.title,
    status: item.status
  }));
}

function normalizeTaskPlanRevisions(revisions: unknown): TaskPlanRevision[] {
  if (!Array.isArray(revisions)) return [];

  return revisions
    .filter((revision): revision is Partial<TaskPlanRevision> => Boolean(revision && typeof revision === "object" && !Array.isArray(revision)))
    .map((revision) => ({
      id: typeof revision.id === "string" && revision.id.trim() ? revision.id : `revision-${crypto.randomUUID()}`,
      trigger: isTaskPlanRevisionTrigger(revision.trigger) ? revision.trigger : "system",
      reason: typeof revision.reason === "string" && revision.reason.trim() ? revision.reason.trim() : "计划已调整",
      beforeItems: snapshotTaskPlanItems(revision.beforeItems),
      afterItems: snapshotTaskPlanItems(revision.afterItems),
      createdAt: typeof revision.createdAt === "number" ? revision.createdAt : Date.now()
    }))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 20);
}

function isTaskPlanRevisionTrigger(value: unknown): value is TaskPlanRevisionTrigger {
  return value === "user" || value === "agent" || value === "validation" || value === "system";
}

function isAgentMessageRole(value: unknown): value is AgentMessageRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function isAgentMode(value: unknown): value is AgentMode {
  return value === "plan" || value === "act";
}

function isTaskWorkflowType(value: unknown): value is TaskWorkflowType {
  return value === "bugfix" || value === "feature" || value === "refactor" || value === "analysis-only";
}

function isTaskWorkflowSource(value: unknown): value is TaskWorkflowSource {
  return value === "intent" || value === "keyword" || value === "fallback";
}

function normalizeTaskWorkflow(value: unknown): TaskWorkflowSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  if (!isTaskWorkflowType(record.type) || !isTaskWorkflowSource(record.source) || !Array.isArray(record.steps)) return undefined;

  const steps = record.steps
    .filter((step): step is Record<string, unknown> => Boolean(step && typeof step === "object" && !Array.isArray(step)))
    .map((step) => ({
      id: typeof step.id === "string" ? step.id : "",
      title: typeof step.title === "string" ? step.title : "",
      description: typeof step.description === "string" ? step.description : ""
    }))
    .filter((step) => step.id && step.title);

  if (!steps.length) return undefined;

  return {
    type: record.type,
    source: record.source,
    confidence: typeof record.confidence === "number" && Number.isFinite(record.confidence) ? Math.max(0, Math.min(1, record.confidence)) : 0.5,
    reason: typeof record.reason === "string" ? record.reason : "",
    authorization: record.authorization && typeof record.authorization === "object" && !Array.isArray(record.authorization)
      ? {
          workspaceMutation: (record.authorization as Record<string, unknown>).workspaceMutation !== false,
          commandExecution: (record.authorization as Record<string, unknown>).commandExecution !== false,
          source: (record.authorization as Record<string, unknown>).source === "user" ? "user" : "workflow"
        }
      : undefined,
    steps,
    version: typeof record.version === "number" ? record.version : 1,
    selectedAt: typeof record.selectedAt === "number" ? record.selectedAt : Date.now()
  };
}

function isPatchFilterReason(value: unknown): value is PatchFilterReason {
  return value === "invalid_path" || value === "duplicate_path" || value === "no_effect_change" || value === "scope_violation" || value === "stale_full_rewrite_retry";
}

function isPatchFilterStage(value: unknown): value is PatchFilterStage {
  return value === "path_validation" || value === "scope_validation" || value === "dedupe" || value === "content_diff" || value === "retry";
}

function isCompanionStatus(value: unknown): RequiredCompanionFile["status"] {
  return value === "read" || value === "missing" || value === "pending" ? value : "pending";
}

function isMissingRequirementSeverity(value: unknown): MissingRequirementRecord["severity"] {
  return value === "warning" || value === "blocking" ? value : "warning";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function isDeliveryUnitStatus(value: unknown): value is DeliveryUnitStatus {
  return value === "pending" || value === "active" || value === "validated" || value === "blocked" || value === "deferred";
}

function sanitizeSessionSummary(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return "";
  // 避免诊断摘要意外持久化常见密钥字段；完整参数和错误输出不允许进入会话。
  return value.replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[已脱敏]").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeDeliveryUnits(value: unknown): DeliveryUnit[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<DeliveryUnit> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      version: 1 as const,
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `unit-${crypto.randomUUID()}`,
      title: sanitizeSessionSummary(item.title, 160),
      sourcePlanItemIds: unique(normalizeStringArray(item.sourcePlanItemIds)),
      status: isDeliveryUnitStatus(item.status) ? item.status : "pending",
      completionCriteria: unique(normalizeStringArray(item.completionCriteria).map((entry) => sanitizeSessionSummary(entry, 300)).filter(Boolean)),
      candidateFiles: unique(normalizeStringArray(item.candidateFiles)), filesRead: unique(normalizeStringArray(item.filesRead)), plannedFiles: unique(normalizeStringArray(item.plannedFiles)),
      dependencyUnitIds: unique(normalizeStringArray(item.dependencyUnitIds)), checkpointIds: unique(normalizeStringArray(item.checkpointIds)), verificationCommands: unique(normalizeStringArray(item.verificationCommands).map((entry) => sanitizeSessionSummary(entry, 300)).filter(Boolean)),
      contextMetrics: item.contextMetrics && typeof item.contextMetrics === "object" ? {
        inputTokens: Math.max(0, Number(item.contextMetrics.inputTokens) || 0), compressionCount: Math.max(0, Number(item.contextMetrics.compressionCount) || 0),
        toolCallCount: Math.max(0, Number(item.contextMetrics.toolCallCount) || 0), changedFileCount: Math.max(0, Number(item.contextMetrics.changedFileCount) || 0),
        validationResult: (item.contextMetrics.validationResult === "passed" || item.contextMetrics.validationResult === "failed" ? item.contextMetrics.validationResult : "not_run") as "passed" | "failed" | "not_run",
        updatedAt: typeof item.contextMetrics.updatedAt === "number" ? item.contextMetrics.updatedAt : Date.now()
      } : undefined,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(), updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now()
    }))
    .filter((item) => item.title && item.sourcePlanItemIds.length);
}

function normalizeToolFailureDiagnostics(value: unknown): ToolFailureDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Partial<ToolFailureDiagnostic> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({
    version: 1 as const, id: typeof item.id === "string" && item.id.trim() ? item.id : `tool-failure-${crypto.randomUUID()}`,
    toolName: sanitizeSessionSummary(item.toolName, 100) || "unknown", parameterSummary: sanitizeSessionSummary(item.parameterSummary),
    errorCode: sanitizeSessionSummary(item.errorCode, 100) || undefined, errorSignature: sanitizeSessionSummary(item.errorSignature, 240) || undefined, errorCategory: sanitizeSessionSummary(item.errorCategory, 100) || "unknown",
    retryable: Boolean(item.retryable), deliveryUnitId: typeof item.deliveryUnitId === "string" && item.deliveryUnitId.trim() ? item.deliveryUnitId : undefined,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now()
  })).sort((left, right) => left.createdAt - right.createdAt).slice(-100);
}

function normalizeRecoveryHistory(value: unknown): RecoveryDecision[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Partial<RecoveryDecision> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({
    version: 1 as const, id: typeof item.id === "string" && item.id.trim() ? item.id : `recovery-${crypto.randomUUID()}`,
    triggerSignal: sanitizeSessionSummary(item.triggerSignal, 120), candidateActions: unique(normalizeStringArray(item.candidateActions).map((entry) => sanitizeSessionSummary(entry, 120)).filter(Boolean)),
    finalAction: sanitizeSessionSummary(item.finalAction, 120), reason: sanitizeSessionSummary(item.reason), evidence: unique(normalizeStringArray(item.evidence).map((entry) => sanitizeSessionSummary(entry, 300)).filter(Boolean)),
    deliveryUnitId: typeof item.deliveryUnitId === "string" && item.deliveryUnitId.trim() ? item.deliveryUnitId : undefined, createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now()
  })).filter((item) => item.triggerSignal && item.finalAction).sort((left, right) => left.createdAt - right.createdAt).slice(-100);
}

function normalizeTaskContinuation(value: unknown): TaskContinuation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<TaskContinuation>;
  if (item.nextStep !== "continue_current_unit" && item.nextStep !== "select_next_unit" && item.nextStep !== "replan" && item.nextStep !== "await_user_input" && item.nextStep !== "resume_validation") return undefined;
  return { version: 1, nextStep: item.nextStep, requiredUserInputs: Array.isArray(item.requiredUserInputs) ? item.requiredUserInputs.filter((input): input is { field: string; label: string; required: boolean } => Boolean(input && typeof input.field === "string" && typeof input.label === "string")).map((input) => ({ field: sanitizeSessionSummary(input.field, 80), label: sanitizeSessionSummary(input.label, 120), required: Boolean(input.required) })).filter((input) => input.field && input.label) : [], autoContinueConditions: unique(normalizeStringArray(item.autoContinueConditions).map((entry) => sanitizeSessionSummary(entry, 300)).filter(Boolean)), message: sanitizeSessionSummary(item.message), deliveryUnitId: typeof item.deliveryUnitId === "string" && item.deliveryUnitId.trim() ? item.deliveryUnitId : undefined, updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now() };
}

function syncPlanItemsAndDeliveryUnits(planItems: TaskPlanItem[], deliveryUnits: DeliveryUnit[]) {
  const unitByPlanItemId = new Map(deliveryUnits.flatMap((unit) => unit.sourcePlanItemIds.map((id) => [id, unit] as const)));
  return planItems.map((item) => {
    const unit = unitByPlanItemId.get(item.id);
    if (!unit) return item;
    const status: TaskPlanItemStatus = unit.status === "validated" ? "completed" : unit.status === "blocked" || unit.status === "deferred" ? "blocked" : unit.status === "active" ? "in_progress" : "pending";
    return item.status === status ? item : { ...item, status, updatedAt: Date.now() };
  });
}

// Runtime 触发重规划时同步补齐计划新增的单元；已验证单元始终保留原有状态和证据。
function synchronizeDeliveryUnitsForPlanRevision(planItems: TaskPlanItem[], existingUnits: DeliveryUnit[], now: number) {
  const existingByPlanItemId = new Map(existingUnits.flatMap((unit) => unit.sourcePlanItemIds.map((id) => [id, unit] as const)));
  const units = planItems.map((item) => {
    const existing = existingByPlanItemId.get(item.id);
    if (existing) {
      if (existing.status === "validated") return existing;
      const status: DeliveryUnitStatus = item.status === "in_progress" ? "active" : item.status === "blocked" ? "blocked" : "pending";
      return { ...existing, title: item.title, status, updatedAt: now };
    }
    return {
      version: 1 as const,
      id: `unit-${item.id}`,
      title: item.title,
      sourcePlanItemIds: [item.id],
      status: item.status === "in_progress" ? "active" as const : item.status === "blocked" ? "blocked" as const : "pending" as const,
      completionCriteria: ["已形成结构化结论或明确阻塞项"],
      candidateFiles: item.evidence?.files || [],
      filesRead: item.evidence?.files || [],
      plannedFiles: [],
      dependencyUnitIds: [],
      checkpointIds: [],
      verificationCommands: [],
      createdAt: now,
      updatedAt: now
    };
  });
  return normalizeDeliveryUnits(units);
}

function isPatchLifecycleEventType(value: unknown): value is PatchLifecycleEventType {
  return value === "patch_created" || value === "patch_filtered" || value === "patch_file_applied" || value === "patch_file_rejected" || value === "patch_completed" || value === "patch_superseded" || value === "auto_fix_patch_created";
}

function isFileEditLifecycleEventType(value: unknown): value is FileEditLifecycleEventType {
  return value === "file_edit_started" || value === "file_edit_applied" || value === "file_edit_failed";
}

function isFileEditToolName(value: unknown): value is FileEditLifecycleEvent["toolName"] {
  return value === "replaceInFile" || value === "writeFile";
}

function normalizePatchLifecycleEvents(value: unknown): PatchLifecycleEvent[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<PatchLifecycleEvent> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const detail = item.detail && typeof item.detail === "object" && !Array.isArray(item.detail) ? (item.detail as Record<string, unknown>) : undefined;

      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id : `patch-event-${crypto.randomUUID()}`,
        type: isPatchLifecycleEventType(item.type) ? item.type : "patch_created",
        patchId: typeof item.patchId === "string" && item.patchId.trim() ? item.patchId : "",
        taskSessionId: typeof item.taskSessionId === "string" && item.taskSessionId.trim() ? item.taskSessionId : item.taskSessionId === null ? null : undefined,
        filePath: typeof item.filePath === "string" && item.filePath.trim() ? item.filePath : item.filePath === null ? null : undefined,
        filePaths: Array.isArray(item.filePaths) ? item.filePaths.filter((filePath): filePath is string => typeof filePath === "string" && Boolean(filePath.trim())) : undefined,
        sourcePatchId: typeof item.sourcePatchId === "string" && item.sourcePatchId.trim() ? item.sourcePatchId : item.sourcePatchId === null ? null : undefined,
        command: typeof item.command === "string" && item.command.trim() ? item.command : item.command === null ? null : undefined,
        attempt: typeof item.attempt === "number" ? item.attempt : item.attempt === null ? null : undefined,
        message: typeof item.message === "string" && item.message.trim() ? item.message : item.message === null ? null : undefined,
        detail,
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now()
      };
    })
    .filter((event) => event.patchId.trim())
    .sort((left, right) => left.createdAt - right.createdAt);
}

function normalizeFileEditLifecycleEvents(value: unknown): FileEditLifecycleEvent[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<FileEditLifecycleEvent> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const detail = item.detail && typeof item.detail === "object" && !Array.isArray(item.detail) ? (item.detail as Record<string, unknown>) : undefined;

      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id : `file-edit-event-${crypto.randomUUID()}`,
        taskSessionId: typeof item.taskSessionId === "string" && item.taskSessionId.trim() ? item.taskSessionId : item.taskSessionId === null ? null : undefined,
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        type: isFileEditLifecycleEventType(item.type) ? item.type : "file_edit_started",
        toolName: isFileEditToolName(item.toolName) ? item.toolName : "replaceInFile",
        filePath: typeof item.filePath === "string" ? item.filePath : "",
        checkpointId: typeof item.checkpointId === "string" && item.checkpointId.trim() ? item.checkpointId : undefined,
        detail
      };
    })
    .filter((event) => event.filePath.trim())
    .sort((left, right) => left.createdAt - right.createdAt);
}

function normalizeCandidateFiles(value: unknown): CandidateFileRecord[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<CandidateFileRecord> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      filePath: typeof item.filePath === "string" ? item.filePath : "",
      role: item.role === "target" || item.role === "companion" || item.role === "context" ? item.role : "context",
      score: typeof item.score === "number" ? item.score : 0,
      reasons: normalizeStringArray(item.reasons),
      read: Boolean(item.read),
      fromTools: Array.isArray(item.fromTools) ? item.fromTools.filter((tool): tool is CandidateFileRecord["fromTools"][number] => typeof tool === "string") : []
    }))
    .filter((item) => item.filePath.trim());
}

function normalizeEvidenceRecords(value: unknown): EvidenceRecord[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<EvidenceRecord> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      filePath: typeof item.filePath === "string" ? item.filePath : "",
      evidenceType:
        item.evidenceType === "filename" ||
        item.evidenceType === "definition" ||
        item.evidenceType === "text_match" ||
        item.evidenceType === "import_relation" ||
        item.evidenceType === "selected_file" ||
        item.evidenceType === "previous_failure" ||
        item.evidenceType === "session_history"
          ? item.evidenceType
          : "session_history",
      sourceTool: typeof item.sourceTool === "string" ? item.sourceTool : "unknown",
      detail: typeof item.detail === "string" ? item.detail : "",
      line: typeof item.line === "number" ? item.line : undefined,
      score: typeof item.score === "number" ? item.score : 0
    }))
    .filter((item) => item.filePath.trim());
}

function normalizeRequiredCompanions(value: unknown): RequiredCompanionFile[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<RequiredCompanionFile> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      filePath: typeof item.filePath === "string" ? item.filePath : "",
      reason: typeof item.reason === "string" ? item.reason : "",
      requiredBy: typeof item.requiredBy === "string" ? item.requiredBy : "unknown",
      status: isCompanionStatus(item.status)
    }))
    .filter((item) => item.filePath.trim());
}

function normalizeMissingRequirements(value: unknown): MissingRequirementRecord[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<MissingRequirementRecord> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      requirement: typeof item.requirement === "string" ? item.requirement : "unknown",
      reason: typeof item.reason === "string" ? item.reason : "",
      severity: isMissingRequirementSeverity(item.severity),
      relatedFiles: normalizeStringArray(item.relatedFiles)
    }));
}

function normalizeContextSelectionSnapshot(value: unknown): ContextSelectionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const item = value as Partial<ContextSelectionSnapshot>;

  if (typeof item.userGoal !== "string") return null;

  return {
    taskSessionId: typeof item.taskSessionId === "string" && item.taskSessionId.trim() ? item.taskSessionId : item.taskSessionId === null ? null : undefined,
    userGoal: item.userGoal,
    candidateFiles: normalizeCandidateFiles(item.candidateFiles),
    evidence: normalizeEvidenceRecords(item.evidence),
    requiredCompanions: normalizeRequiredCompanions(item.requiredCompanions),
    missingRequirements: normalizeMissingRequirements(item.missingRequirements),
    readyForPatch: Boolean(item.readyForPatch),
    summary: typeof item.summary === "string" ? item.summary : "",
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now()
  };
}

function normalizeContextSelectionSnapshots(value: unknown): ContextSelectionSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value
    .map(normalizeContextSelectionSnapshot)
    .filter((item): item is ContextSelectionSnapshot => Boolean(item))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 50);
}

function normalizePatchCompletenessReport(value: unknown): PatchCompletenessReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const item = value as Partial<PatchCompletenessReport>;

  return {
    ready: Boolean(item.ready),
    risks: normalizeMissingRequirements(item.risks),
    checkedFiles: normalizeStringArray(item.checkedFiles),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now()
  };
}

function normalizePatchDiagnostics(value: unknown): PatchGenerationDiagnostics[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<PatchGenerationDiagnostics> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      patchId: typeof item.patchId === "string" && item.patchId.trim() ? item.patchId : undefined,
      modelSummary: typeof item.modelSummary === "string" && item.modelSummary.trim() ? item.modelSummary : undefined,
      rawPatchCount: typeof item.rawPatchCount === "number" ? item.rawPatchCount : 0,
      normalizedFilePaths: Array.isArray(item.normalizedFilePaths) ? item.normalizedFilePaths.filter((filePath): filePath is string => typeof filePath === "string") : [],
      preDedupeCount: typeof item.preDedupeCount === "number" ? item.preDedupeCount : 0,
      postDedupeCount: typeof item.postDedupeCount === "number" ? item.postDedupeCount : 0,
      finalPatchCount: typeof item.finalPatchCount === "number" ? item.finalPatchCount : 0,
      filteredCount: typeof item.filteredCount === "number" ? item.filteredCount : 0,
      noEffectCount: typeof item.noEffectCount === "number" ? item.noEffectCount : 0,
      records: Array.isArray(item.records)
        ? item.records
            .filter((record) => Boolean(record && typeof record === "object" && !Array.isArray(record)))
            .map((record) => {
              const data = record as Record<string, unknown>;

              return {
                reason: isPatchFilterReason(data.reason) ? data.reason : "invalid_path",
                stage: isPatchFilterStage(data.stage) ? data.stage : "path_validation",
                attempt: typeof data.attempt === "number" ? data.attempt : 0,
                filePath: typeof data.filePath === "string" ? data.filePath : "",
                normalizedPath: typeof data.normalizedPath === "string" && data.normalizedPath.trim() ? data.normalizedPath : undefined,
                detail: typeof data.detail === "string" && data.detail.trim() ? data.detail : undefined
              };
            })
            .filter((record) => record.filePath.trim())
        : [],
      contextSelection: normalizeContextSelectionSnapshot(item.contextSelection) || undefined,
      patchCompleteness: normalizePatchCompletenessReport(item.patchCompleteness),
      generatedAt: typeof item.generatedAt === "number" ? item.generatedAt : Date.now()
    }))
    .sort((left, right) => right.generatedAt - left.generatedAt);
}

function normalizeAgentMessages(messages: unknown): AgentMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message): message is Partial<AgentMessage> => Boolean(message && typeof message === "object" && !Array.isArray(message)))
    .map((message) => ({
      id: typeof message.id === "string" && message.id.trim() ? message.id : `agent-message-${crypto.randomUUID()}`,
      role: isAgentMessageRole(message.role) ? message.role : "assistant",
      content: typeof message.content === "string" || message.content === null ? message.content : "",
      toolCallId: typeof message.toolCallId === "string" && message.toolCallId.trim() ? message.toolCallId : undefined,
      toolCalls: Array.isArray(message.toolCalls)
        ? message.toolCalls
            .filter((toolCall) => Boolean(toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)))
            .map((toolCall) => {
              const record = toolCall as Record<string, unknown>;

              return {
                id: typeof record.id === "string" && record.id.trim() ? record.id : `tool-call-${crypto.randomUUID()}`,
                name: typeof record.name === "string" ? record.name : "unknown",
                arguments: record.arguments
              };
            })
        : undefined,
      createdAt: typeof message.createdAt === "number" ? message.createdAt : Date.now()
    }))
    .sort((left, right) => left.createdAt - right.createdAt);
}

function normalizePendingToolCall(value: unknown): PendingAgentToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Partial<PendingAgentToolCall>;
  const riskLevel = record.riskLevel === "high" || record.riskLevel === "medium" || record.riskLevel === "low" ? record.riskLevel : "medium";

  if (typeof record.actionId !== "string" || !record.actionId.trim() || typeof record.toolCallId !== "string" || !record.toolCallId.trim() || typeof record.toolName !== "string" || !record.toolName.trim()) {
    return null;
  }

  return {
    actionId: record.actionId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    arguments: record.arguments,
    riskLevel,
    status: "pending",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    agentContext: record.agentContext && typeof record.agentContext === "object" && !Array.isArray(record.agentContext) ? record.agentContext : undefined
  };
}

function normalizeTaskSession(session: TaskSession): TaskSession {
  const deliveryUnits = normalizeDeliveryUnits(session.deliveryUnits);
  const activeDeliveryUnitId = typeof session.activeDeliveryUnitId === "string" && deliveryUnits.some((unit) => unit.id === session.activeDeliveryUnitId)
    ? session.activeDeliveryUnitId
    : undefined;
  return {
    ...session,
    // 未识别的历史状态回退为 failed，避免损坏记录被误显示为成功。
    status: isTaskSessionStatus(session.status) ? session.status : "failed",
    runtimeStatus: isAgentRuntimeStatus(session.runtimeStatus) ? session.runtimeStatus : undefined,
    runtimeStatusReason: typeof session.runtimeStatusReason === "string" ? session.runtimeStatusReason : undefined,
    completionEvidence: session.completionEvidence && typeof session.completionEvidence === "object" ? session.completionEvidence : undefined,
    runtimeEvidence: normalizeTaskRuntimeEvidence(session.runtimeEvidence),
    runtimeOutcome: session.runtimeOutcome
      && typeof session.runtimeOutcome === "object"
      && isAgentRuntimeStatus(session.runtimeOutcome.requestedStatus)
      && isAgentRuntimeStatus(session.runtimeOutcome.effectiveStatus)
      ? session.runtimeOutcome
      : undefined,
    finalization: session.finalization
      && typeof session.finalization === "object"
      && isTaskSessionTerminalStatus(session.finalization.status)
      && isTaskSessionFinalizationSource(session.finalization.source)
      && typeof session.finalization.finalizedAt === "number"
      ? session.finalization
      : undefined,
    agentMode: isAgentMode(session.agentMode) ? session.agentMode : "act",
    workflow: normalizeTaskWorkflow(session.workflow),
    // 旧任务记录没有 Agent 消息字段，读取时补齐，后续 runtime 可以直接追加和恢复。
    agentMessages: normalizeAgentMessages(session.agentMessages),
    pendingToolCall: normalizePendingToolCall(session.pendingToolCall),
    planItems: normalizeTaskPlanItems(session.planItems),
    planRevisions: normalizeTaskPlanRevisions(session.planRevisions),
    deliveryUnits,
    activeDeliveryUnitId,
    toolFailureDiagnostics: normalizeToolFailureDiagnostics(session.toolFailureDiagnostics),
    recoveryHistory: normalizeRecoveryHistory(session.recoveryHistory),
    continuation: normalizeTaskContinuation(session.continuation),
    modificationPlan: normalizeStructuredModificationPlan(session.modificationPlan) || undefined,
    patchDiagnostics: normalizePatchDiagnostics(session.patchDiagnostics),
    contextSelectionSnapshots: normalizeContextSelectionSnapshots(session.contextSelectionSnapshots),
    contextBudgetSnapshot: session.contextBudgetSnapshot && typeof session.contextBudgetSnapshot === "object" ? session.contextBudgetSnapshot : undefined,
    contextSummary: session.contextSummary && typeof session.contextSummary === "object" ? session.contextSummary : undefined,
    patchEvents: normalizePatchLifecycleEvents(session.patchEvents),
    fileEditEvents: normalizeFileEditLifecycleEvents(session.fileEditEvents)
  };
}

function createTaskPlanRevision(input: { trigger: TaskPlanRevisionTrigger; reason: string; beforeItems: unknown; afterItems: unknown }): TaskPlanRevision {
  return {
    id: `revision-${Date.now().toString(36)}-${crypto.randomUUID()}`,
    trigger: input.trigger,
    reason: input.reason.trim() || "计划已调整",
    beforeItems: snapshotTaskPlanItems(input.beforeItems),
    afterItems: snapshotTaskPlanItems(input.afterItems),
    createdAt: Date.now()
  };
}

async function attachTaskSessionDiffView(session: TaskSession): Promise<TaskSession> {
  const checkpointDiffFiles = [];

  for (const checkpointId of session.checkpointIds || []) {
    try {
      const checkpoint = await getCheckpoint(checkpointId);
      const files = unique(checkpoint.files.map((file) => file.filePath));

      checkpointDiffFiles.push({
        checkpointId,
        patchId: checkpoint.source?.patchId ?? checkpoint.taskId ?? null,
        files
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        continue;
      }

      throw error;
    }
  }

  const checkpointAppliedFiles = unique(checkpointDiffFiles.flatMap((item) => item.files));
  const generatedFiles = unique((session.patchDiagnostics || []).flatMap((item) => item.normalizedFilePaths));
  const appliedFiles = checkpointAppliedFiles.length ? checkpointAppliedFiles : unique(session.filesChanged || []);
  const effectiveGeneratedFiles = generatedFiles.length ? generatedFiles : unique([...appliedFiles, ...(session.filesChanged || [])]);

  return {
    ...session,
    // 历史 diff 的事实来源优先使用 checkpoint；旧数据没有 checkpoint 时保持原有 filesChanged 兼容。
    diffView: {
      generatedFiles: effectiveGeneratedFiles,
      appliedFiles,
      rejectedFiles: withoutValues(effectiveGeneratedFiles, appliedFiles),
      checkpointDiffFiles,
      source: checkpointDiffFiles.length ? "checkpoint" : "legacy"
    }
  };
}

async function readTaskSessionRecord(taskSessionId: string): Promise<TaskSession> {
  const primaryPath = taskSessionPath(taskSessionId);
  const persisted = await readJsonStateFile<TaskSession>(primaryPath, { allowMissing: true, recover: true })
    ?? await readJsonStateFile<TaskSession>(legacyTaskSessionPath(taskSessionId), { allowMissing: true, recover: true });
  if (!persisted) throw new HttpError(404, "Task session not found");
  const session = normalizeTaskSession(persisted);
  lastPersistedTaskSessionHashes.set(taskSessionPath(taskSessionId), hashTaskSessionContent(serializeTaskSession(session)));
  return session;
}

async function readTaskSession(taskSessionId: string): Promise<TaskSession> {
  return attachTaskSessionDiffView(await readTaskSessionRecord(taskSessionId));
}

function serializeTaskSession(session: TaskSession) {
  return `${JSON.stringify(session, null, 2)}\n`;
}

function hashTaskSessionContent(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function writeTaskSession(session: TaskSession) {
  const destination = taskSessionPath(session.id);
  const content = serializeTaskSession(session);
  const contentHash = hashTaskSessionContent(content);
  if (lastPersistedTaskSessionHashes.get(destination) === contentHash) {
    recordTaskSessionPersistenceMetrics(session.id, { taskSessionWriteSkippedCount: 1 });
    return false;
  }
  // 通用状态存储会先验证可序列化性，再以 UTF-8 临时文件原子替换并保留上一份有效备份。
  await writeJsonStateFile(destination, session, {
    rename: (source, target) => renameTaskSessionFileWithRetry(session.id, source, target)
  });
  lastPersistedTaskSessionHashes.set(destination, contentHash);
  recordTaskSessionPersistenceMetrics(session.id, { taskSessionPhysicalWriteCount: 1 });
  return true;
}

export async function createTaskSession(userGoal: string, options: { chatId?: string; messageIds?: string[]; agentMode?: AgentMode; modelSelection?: import("./contracts/model.js").ModelSelection } = {}): Promise<TaskSession> {
  const now = Date.now();
  const session: TaskSession = {
    id: `task-${now.toString(36)}-${crypto.randomUUID()}`,
    userGoal,
    agentMode: options.agentMode || "act",
    modelSelection: options.modelSelection,
    chatId: options.chatId,
    messageIds: options.messageIds,
    status: "running",
    runtimeEvidence: {
      taskRunId: crypto.randomUUID(),
      appliedFilePaths: [],
      generatedPatchIds: []
    },
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    steps: [],
    agentMessages: [],
    pendingToolCall: null,
    planItems: [],
    planRevisions: [],
    planApproval: { required: false, status: "not_required" },
    deliveryUnits: [],
    activeDeliveryUnitId: undefined,
    toolFailureDiagnostics: [],
    recoveryHistory: [],
    continuation: undefined,
    modificationPlan: undefined,
    checkpointIds: [],
    patchDiagnostics: [],
    contextSelectionSnapshots: [],
    patchEvents: [],
    fileEditEvents: [],
    gitCommits: [],
    createdAt: now,
    updatedAt: now
  };

  await writeTaskSession(session);
  return session;
}

export async function setTaskSessionWorkflow(taskSessionId: string | null | undefined, workflow: TaskWorkflowSnapshot) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    // 写入快照副本，避免调用方后续修改模板对象污染已保存的任务历史。
    workflow: {
      ...workflow,
      authorization: workflow.authorization ? { ...workflow.authorization } : undefined,
      steps: workflow.steps.map((step) => ({ ...step }))
    },
    updatedAt: Date.now()
  }));
}

export async function addTaskPlanItem(taskSessionId: string | null | undefined, input: { title: string; status?: TaskPlanItemStatus; note?: string }) {
  if (!taskSessionId) return null;

  const title = input.title.trim();

  if (!title) {
    throw new HttpError(400, "计划标题不能为空");
  }

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const now = Date.now();
    const item: TaskPlanItem = {
      id: `plan-${now.toString(36)}-${crypto.randomUUID()}`,
      title,
      status: input.status || "pending",
      note: input.note?.trim() || undefined,
      evidence: { stepIds: [], files: [], commands: [] },
      createdAt: now,
      updatedAt: now
    };

    return {
      ...session,
      planItems: [...normalizeTaskPlanItems(session.planItems), item],
      updatedAt: now
    };
  });
}

export type TaskPlanItemInput = { id?: string; workflowStepId?: string; title: string; status?: TaskPlanItemStatus; note?: string };
export type TaskPlanDeliveryUnitFactory = (planItems: TaskPlanItem[], previousUnits: DeliveryUnit[], now: number) => DeliveryUnit[];

export async function setTaskPlanItems(taskSessionId: string | null | undefined, items: TaskPlanItemInput[], options: { requireApproval?: boolean; revision?: { trigger: TaskPlanRevisionTrigger; reason: string }; deliveryUnitFactory?: TaskPlanDeliveryUnitFactory } = {}) {
  if (!taskSessionId) return null;

  const now = Date.now();
  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const previousItems = normalizeTaskPlanItems(session.planItems);
    const previousById = new Map(previousItems.map((item) => [item.id, item]));
    const planItems = items
    .map((item, index): TaskPlanItem | null => {
      const title = item.title.trim();

      if (!title) return null;

      // 重写计划时仅复用显式传入的稳定 ID，避免按标题猜测并误关联已完成证据。
      const previous = item.id ? previousById.get(item.id) : undefined;

      return {
        id: previous?.id || `plan-${now.toString(36)}-${index}-${crypto.randomUUID()}`,
        workflowStepId: item.workflowStepId?.trim() || undefined,
        title,
        status: item.status || previous?.status || (index === 0 ? "in_progress" : "pending"),
        note: item.note?.trim() || undefined,
        evidence: previous?.evidence || { stepIds: [], files: [], commands: [] },
        createdAt: previous?.createdAt || now,
        updatedAt: now
      };
    })
    .filter((item): item is TaskPlanItem => Boolean(item));
    const revision = options.revision
      ? createTaskPlanRevision({
          trigger: options.revision.trigger,
          reason: options.revision.reason,
          beforeItems: previousItems,
          afterItems: planItems
        })
      : null;

    const deliveryUnits = options.deliveryUnitFactory
      ? normalizeDeliveryUnits(options.deliveryUnitFactory(planItems, normalizeDeliveryUnits(session.deliveryUnits), now))
      : normalizeDeliveryUnits(session.deliveryUnits);
    const activeDeliveryUnitId = deliveryUnits.some((unit) => unit.id === session.activeDeliveryUnitId)
      ? session.activeDeliveryUnitId
      : deliveryUnits.find((unit) => unit.status === "active")?.id;

    return {
      ...session,
      planItems: options.deliveryUnitFactory ? syncPlanItemsAndDeliveryUnits(planItems, deliveryUnits) : planItems,
      planRevisions: revision ? [revision, ...normalizeTaskPlanRevisions(session.planRevisions)].slice(0, 20) : normalizeTaskPlanRevisions(session.planRevisions),
      planApproval: options.requireApproval
        ? {
            required: true,
            status: "pending",
            requestedAt: now
          }
        : session.planApproval || { required: false, status: "not_required" },
      deliveryUnits,
      activeDeliveryUnitId,
      updatedAt: now
    };
  });
}

export async function approveTaskSessionPlan(taskSessionId: string | null | undefined) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    agentMode: "act",
    status: session.status === "awaiting_replan" ? "running" : session.status,
    planApproval: {
      required: Boolean(session.planApproval?.required),
      status: "approved",
      requestedAt: session.planApproval?.requestedAt,
      approvedAt: Date.now()
    },
    updatedAt: Date.now()
  }));
}

type DeliveryUnitInput = Omit<DeliveryUnit, "version" | "id" | "createdAt" | "updatedAt"> & Partial<Pick<DeliveryUnit, "id" | "createdAt" | "updatedAt">>;
type ToolFailureDiagnosticInput = Omit<ToolFailureDiagnostic, "version" | "id" | "createdAt"> & Partial<Pick<ToolFailureDiagnostic, "id" | "createdAt">>;
type RecoveryDecisionInput = Omit<RecoveryDecision, "version" | "id" | "createdAt"> & Partial<Pick<RecoveryDecision, "id" | "createdAt">>;
type TaskContinuationInput = Omit<TaskContinuation, "version" | "updatedAt"> & Partial<Pick<TaskContinuation, "updatedAt">>;

/** 仅接受结构化单元快照，并在同一写队列中将关联计划状态同步到界面。 */
export async function setTaskSessionDeliveryUnits(taskSessionId: string | null | undefined, units: DeliveryUnitInput[]) {
  if (!taskSessionId) return null;
  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const normalizedUnits = normalizeDeliveryUnits(units.map((unit) => ({ ...unit, version: 1, id: unit.id || `unit-${crypto.randomUUID()}`, createdAt: unit.createdAt || Date.now(), updatedAt: Date.now() })));
    const activeDeliveryUnitId = normalizedUnits.some((unit) => unit.id === session.activeDeliveryUnitId) ? session.activeDeliveryUnitId : normalizedUnits.find((unit) => unit.status === "active")?.id;
    return { ...session, deliveryUnits: normalizedUnits, activeDeliveryUnitId, planItems: syncPlanItemsAndDeliveryUnits(normalizeTaskPlanItems(session.planItems), normalizedUnits), updatedAt: Date.now() };
  });
}

/** 设置当前执行单元；活跃单元必须存在，避免 Runtime 写入悬空 ID。 */
export async function setActiveTaskSessionDeliveryUnit(taskSessionId: string | null | undefined, deliveryUnitId: string | null) {
  if (!taskSessionId) return null;
  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const units = normalizeDeliveryUnits(session.deliveryUnits);
    if (deliveryUnitId && !units.some((unit) => unit.id === deliveryUnitId)) throw new HttpError(404, "交付单元不存在");
    const nextUnits = units.map((unit) => deliveryUnitId && unit.id === deliveryUnitId ? { ...unit, status: "active" as const, updatedAt: Date.now() } : unit.status === "active" ? { ...unit, status: "pending" as const, updatedAt: Date.now() } : unit);
    return { ...session, deliveryUnits: nextUnits, activeDeliveryUnitId: deliveryUnitId || undefined, planItems: syncPlanItemsAndDeliveryUnits(normalizeTaskPlanItems(session.planItems), nextUnits), updatedAt: Date.now() };
  }, { flushImmediately: true });
}

/** 只有显式提供验证结论且不存在待审批操作时，才允许把单元推进为已验证。 */
export async function completeTaskSessionDeliveryUnit(taskSessionId: string | null | undefined, deliveryUnitId: string, validationEvidence: string) {
  if (!taskSessionId) return null;
  if (!sanitizeSessionSummary(validationEvidence)) throw new HttpError(400, "交付单元完成必须提供验证结论");
  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    if (session.pendingToolCall) throw new HttpError(409, "存在待审批操作，不能完成交付单元");
    const units = normalizeDeliveryUnits(session.deliveryUnits);
    if (!units.some((unit) => unit.id === deliveryUnitId)) throw new HttpError(404, "交付单元不存在");
    const now = Date.now();
    const validatedUnits = units.map((unit) => unit.id === deliveryUnitId ? { ...unit, status: "validated" as const, completionCriteria: unique([...unit.completionCriteria, sanitizeSessionSummary(validationEvidence)]), updatedAt: now } : unit);
    // 当前单元完成后仅按既有工作流顺序激活下一个待办单元，不凭标题推断额外依赖。
    const canActivateNext = session.activeDeliveryUnitId === deliveryUnitId || !validatedUnits.some((unit) => unit.status === "active");
    const nextPendingUnit = canActivateNext ? validatedUnits.find((unit) => unit.status === "pending") : undefined;
    const nextUnits = nextPendingUnit
      ? validatedUnits.map((unit) => unit.id === nextPendingUnit.id ? { ...unit, status: "active" as const, updatedAt: now } : unit)
      : validatedUnits;
    const activeDeliveryUnitId = session.activeDeliveryUnitId === deliveryUnitId
      ? nextPendingUnit?.id
      : nextPendingUnit?.id || session.activeDeliveryUnitId;
    return { ...session, deliveryUnits: nextUnits, activeDeliveryUnitId, planItems: syncPlanItemsAndDeliveryUnits(normalizeTaskPlanItems(session.planItems), nextUnits), updatedAt: now };
  }, { flushImmediately: true });
}

export async function appendTaskSessionToolFailureDiagnostic(taskSessionId: string | null | undefined, diagnostic: ToolFailureDiagnosticInput) {
  if (!taskSessionId) return null;
  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const next = normalizeToolFailureDiagnostics([...normalizeToolFailureDiagnostics(session.toolFailureDiagnostics), { ...diagnostic, version: 1, id: diagnostic.id || `tool-failure-${crypto.randomUUID()}`, createdAt: diagnostic.createdAt || Date.now() }]);
    return { ...session, toolFailureDiagnostics: next, updatedAt: Date.now() };
  });
}

export async function appendTaskSessionRecoveryDecision(taskSessionId: string | null | undefined, decision: RecoveryDecisionInput) {
  if (!taskSessionId) return null;
  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({ ...session, recoveryHistory: normalizeRecoveryHistory([...normalizeRecoveryHistory(session.recoveryHistory), { ...decision, version: 1, id: decision.id || `recovery-${crypto.randomUUID()}`, createdAt: decision.createdAt || Date.now() }]), updatedAt: Date.now() }));
}

export async function setTaskSessionContinuation(taskSessionId: string | null | undefined, continuation: TaskContinuationInput | null) {
  if (!taskSessionId) return null;
  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({ ...session, continuation: continuation ? normalizeTaskContinuation({ ...continuation, version: 1, updatedAt: continuation.updatedAt || Date.now() }) : undefined, updatedAt: Date.now() }), { flushImmediately: true });
}

// 执行中允许用户中断并进入重规划，保持与 Claude Code 相近的交互方式。
export async function interruptTaskSessionForReplan(taskSessionId: string | null | undefined, instruction = "") {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const now = Date.now();
    const previousItems = normalizeTaskPlanItems(session.planItems);
    const nextItems = previousItems.map((item) => ({ ...item }));
    const activeIndex = nextItems.findIndex((item) => item.status === "in_progress");

    if (activeIndex !== -1) {
      nextItems[activeIndex] = {
        ...nextItems[activeIndex],
        status: "blocked",
        note: "用户已中断执行，等待调整计划后继续。",
        updatedAt: now
      };
    }

    const revision = createTaskPlanRevision({
      trigger: "user",
      reason: instruction.trim() || "用户要求中断并重新规划。",
      beforeItems: previousItems,
      afterItems: nextItems
    });

    return {
      ...session,
      agentMode: "plan",
      status: "awaiting_replan",
      planItems: nextItems,
      planRevisions: [revision, ...normalizeTaskPlanRevisions(session.planRevisions)].slice(0, 20),
      planApproval: {
        required: true,
        status: "pending",
        requestedAt: now
      },
      updatedAt: now
    };
  });
}

export type TaskPlanProgressPhase = "patch_generated" | "patch_applied" | "validation_failed" | "validation_success" | "task_failed" | "task_cancelled";

export type TaskPlanReconciliationEvidence = {
  runtimeEvidence?: TaskRuntimeEvidence;
  validationStatus?: "success" | "failed" | "running" | "cancelled";
  pendingApprovalCount?: number;
  activeCommandCount?: number;
  failedToolCallCount?: number;
};

function titleMatches(title: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(title));
}

function findPlanItemIndex(items: TaskPlanItem[], patterns: RegExp[]) {
  return items.findIndex((item) => titleMatches(item.title, patterns));
}

function findActivePlanItemIndex(items: TaskPlanItem[]) {
  return items.findIndex((item) => item.status === "in_progress");
}

function findWorkflowPlanItemIndex(items: TaskPlanItem[], workflowStepIds: string[]) {
  return items.findIndex((item) => Boolean(item.workflowStepId && workflowStepIds.includes(item.workflowStepId)));
}

function completeThroughPlanIndex(items: TaskPlanItem[], targetIndex: number, now: number) {
  for (let index = 0; index <= targetIndex && index < items.length; index += 1) {
    if (items[index].status !== "blocked" && items[index].status !== "completed") {
      items[index] = { ...items[index], status: "completed", updatedAt: now };
    }
  }
}

function startNextPendingPlanItem(items: TaskPlanItem[], startIndex: number, now: number) {
  // 重复恢复同一事件时保留当前活动步骤，避免再启动一个后续步骤。
  if (items.some((item, index) => index > startIndex && item.status === "in_progress")) return;
  const pendingIndex = items.findIndex((item, index) => index > startIndex && item.status === "pending");

  if (pendingIndex !== -1) {
    items[pendingIndex] = { ...items[pendingIndex], status: "in_progress", updatedAt: now };
  }
}

function advancePlanToIndex(items: TaskPlanItem[], targetIndex: number, now: number) {
  if (targetIndex < 0) return;

  // 按真实执行阶段推进计划，避免人工审核通过后把后续步骤一次性扫成完成。
  completeThroughPlanIndex(items, targetIndex, now);
  startNextPendingPlanItem(items, targetIndex, now);
}

function hasTaskPlanProgressChanged(beforeItems: TaskPlanItem[], afterItems: TaskPlanItem[]) {
  if (beforeItems.length !== afterItems.length) return true;
  return beforeItems.some((item, index) => {
    const nextItem = afterItems[index];
    return !nextItem || item.id !== nextItem.id || item.status !== nextItem.status || item.note !== nextItem.note;
  });
}

const mutationWorkflowStepIds = new Set(["implement", "minimal-fix", "refactor"]);
const validationWorkflowStepIds = new Set(["validate", "regression-validation", "regression"]);

function reconcileSuccessfulRuntimeEvidence(
  items: TaskPlanItem[],
  evidence: TaskRuntimeEvidence,
  validationStatus: TaskPlanReconciliationEvidence["validationStatus"],
  now: number
) {
  const nextItems = items.map((item) => ({ ...item }));
  const systemItems = nextItems.filter((item) => Boolean(item.workflowStepId));

  // 人工阻塞代表显式决策边界，持久化证据不能越过该边界继续推进。
  if (systemItems.some((item) => item.status === "blocked")) return items;

  const mutationIndex = nextItems.findIndex((item) => Boolean(item.workflowStepId && mutationWorkflowStepIds.has(item.workflowStepId)));
  const hasAppliedMutation = evidence.appliedFilePaths.length > 0
    && typeof evidence.lastMutationAt === "number"
    && evidence.lastMutationAt > 0;

  if (!hasAppliedMutation || mutationIndex === -1) return items;

  for (let index = 0; index <= mutationIndex; index += 1) {
    const item = nextItems[index];
    // 只校准工作流生成的稳定步骤；人工计划、备注和证据字段均原样保留。
    if (item.workflowStepId && item.status !== "completed") {
      nextItems[index] = { ...item, status: "completed", updatedAt: now };
    }
  }

  const validationIndex = nextItems.findIndex((item) => Boolean(item.workflowStepId && validationWorkflowStepIds.has(item.workflowStepId)));
  const validationIsFresh = validationStatus === "success"
    && typeof evidence.lastValidationAt === "number"
    && evidence.lastValidationAt > evidence.lastMutationAt!;
  if (!validationIsFresh || validationIndex === -1) {
    if (validationIndex !== -1 && nextItems[validationIndex].status !== "in_progress") {
      // 新修改会使旧验证失效；计划必须同步退回验证中，不能只依赖完成门禁拒绝。
      nextItems[validationIndex] = { ...nextItems[validationIndex], status: "in_progress", updatedAt: now };
    }
    const staleSummaryIndex = nextItems.findIndex((item) => item.workflowStepId === "summarize");
    if (staleSummaryIndex !== -1 && nextItems[staleSummaryIndex].status === "completed") {
      nextItems[staleSummaryIndex] = { ...nextItems[staleSummaryIndex], status: "pending", updatedAt: now };
    }
    return nextItems;
  }

  for (let index = 0; index <= validationIndex; index += 1) {
    const item = nextItems[index];
    if (item.workflowStepId && item.status !== "completed") {
      nextItems[index] = { ...item, status: "completed", updatedAt: now };
    }
  }

  const summarizeIndex = nextItems.findIndex((item) => item.workflowStepId === "summarize");
  if (summarizeIndex !== -1 && nextItems[summarizeIndex].status !== "completed") {
    nextItems[summarizeIndex] = { ...nextItems[summarizeIndex], status: "completed", updatedAt: now };
  }

  return nextItems;
}

function applyTaskPlanFailureProgress(
  session: TaskSession,
  phase: Extract<TaskPlanProgressPhase, "validation_failed" | "task_failed" | "task_cancelled">
) {
  const items = normalizeTaskPlanItems(session.planItems);
  if (!items.length) return session;
  if (phase === "task_cancelled" && items.some((item) => item.note === "任务已取消，计划暂停。")) return session;
  if (items.some((item) => item.status === "in_progress" && item.note === "系统已插入重规划步骤，请结合失败信息确认下一步。")) {
    return session;
  }

  const now = Date.now();
  const nextItems = items.map((item) => ({ ...item }));
  const activeIndex = nextItems.findIndex((item) => item.status === "in_progress");
  const fallbackIndex = nextItems.findIndex((item) => item.status === "pending");
  const targetIndex = activeIndex === -1 ? fallbackIndex : activeIndex;

  if (targetIndex !== -1) {
    nextItems[targetIndex] = {
      ...nextItems[targetIndex],
      status: "blocked",
      note: phase === "task_cancelled" ? "任务已取消，计划暂停。" : "执行过程中遇到问题，需要处理后继续。",
      updatedAt: now
    };
  }

  let revision: TaskPlanRevision | null = null;
  if (phase === "validation_failed" || phase === "task_failed") {
    nextItems.push({
      id: `plan-${now.toString(36)}-replan-${crypto.randomUUID()}`,
      title: phase === "validation_failed" ? "根据验证反馈调整计划" : "重新评估失败原因并修订方案",
      status: "in_progress",
      note: "系统已插入重规划步骤，请结合失败信息确认下一步。",
      evidence: { stepIds: [], files: [], commands: [] },
      createdAt: now,
      updatedAt: now
    });
    revision = createTaskPlanRevision({
      trigger: phase === "validation_failed" ? "validation" : "agent",
      reason: phase === "validation_failed" ? "验证失败后自动回到计划阶段" : "任务失败后自动回到计划阶段",
      beforeItems: items,
      afterItems: nextItems
    });
  }

  const deliveryUnits = synchronizeDeliveryUnitsForPlanRevision(nextItems, normalizeDeliveryUnits(session.deliveryUnits), now);
  return {
    ...session,
    planItems: syncPlanItemsAndDeliveryUnits(nextItems, deliveryUnits),
    planRevisions: revision ? [revision, ...normalizeTaskPlanRevisions(session.planRevisions)].slice(0, 20) : normalizeTaskPlanRevisions(session.planRevisions),
    deliveryUnits,
    activeDeliveryUnitId: deliveryUnits.find((unit) => unit.status === "active")?.id,
    updatedAt: now
  };
}

/**
 * 使用已经落盘的 Runtime 证据修复系统计划状态；调用方参数只补充瞬时阻塞信息，
 * 不会替代会话文件中的权威证据。
 */
export async function reconcileTaskPlanFromRuntimeEvidence(
  taskSessionId: string | null | undefined,
  input: TaskPlanReconciliationEvidence = {}
) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const evidence = normalizeTaskRuntimeEvidence(session.runtimeEvidence);
    const suppliedEvidence = normalizeTaskRuntimeEvidence(input.runtimeEvidence);
    const evidenceMatches = !suppliedEvidence || suppliedEvidence.taskRunId === evidence?.taskRunId;
    if (!evidence || !evidenceMatches) return session;

    // 成功状态只信任已落盘证据；瞬时失败/运行状态可以收紧门禁，但不能把持久化失败升级为成功。
    const validationStatus = input.validationStatus === "failed"
      || input.validationStatus === "cancelled"
      || input.validationStatus === "running"
      ? input.validationStatus
      : evidence.lastValidationStatus;
    const hasBlocker = Boolean(session.pendingToolCall)
      || (input.pendingApprovalCount ?? 0) > 0
      || (input.activeCommandCount ?? 0) > 0
      || (input.failedToolCallCount ?? 0) > 0
      || validationStatus === "running";
    if (hasBlocker) return session;

    if (validationStatus === "failed" || validationStatus === "cancelled") {
      // 失败证据只能触发既有重规划路径，绝不能完成验证步骤。
      return applyTaskPlanFailureProgress(session, "validation_failed");
    }

    const items = normalizeTaskPlanItems(session.planItems);
    if (!items.length) return session;
    const now = Date.now();
    const nextItems = reconcileSuccessfulRuntimeEvidence(items, evidence, validationStatus, now);
    if (!hasTaskPlanProgressChanged(items, nextItems)) return session;

    return { ...session, planItems: nextItems, updatedAt: now };
  }, { flushImmediately: true });
}

function getPatchGeneratedTargetIndex(items: TaskPlanItem[]) {
  const implementationIndex = findWorkflowPlanItemIndex(items, ["implement", "minimal-fix", "refactor"]);

  // patch 生成时实现仍待用户应用，只完成实现阶段之前的准备工作。
  if (implementationIndex !== -1) return implementationIndex - 1;

  const generatedIndex = findPlanItemIndex(items, [/生成|修改|审查|审阅|补丁|patch|edit/i]);

  if (generatedIndex !== -1) return generatedIndex;

  const activeIndex = findActivePlanItemIndex(items);
  return activeIndex === -1 ? 0 : Math.min(activeIndex + 2, items.length - 1);
}

function getPatchAppliedTargetIndex(items: TaskPlanItem[]) {
  const implementationIndex = findWorkflowPlanItemIndex(items, ["implement", "minimal-fix", "refactor"]);

  if (implementationIndex !== -1) return implementationIndex;

  const appliedIndex = findPlanItemIndex(items, [/应用|检查结果|检查|apply/i]);

  if (appliedIndex !== -1) return appliedIndex;

  const activeIndex = findActivePlanItemIndex(items);

  if (activeIndex !== -1 && !titleMatches(items[activeIndex].title, [/验证|命令|validation|verify|test|build|lint|check/i])) {
    return activeIndex;
  }

  return -1;
}

function getValidationSuccessTargetIndex(items: TaskPlanItem[]) {
  // 成功结果已经包含最终说明，工作流中的收尾阶段应和任务状态一起完成。
  return items.length - 1;
}

export async function advanceTaskPlanProgress(taskSessionId: string | null | undefined, phase: TaskPlanProgressPhase) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    if (phase === "validation_failed" || phase === "task_failed" || phase === "task_cancelled") {
      return applyTaskPlanFailureProgress(session, phase);
    }

    const items = normalizeTaskPlanItems(session.planItems);

    if (!items.length) {
      return session;
    }

    const now = Date.now();
    const nextItems = items.map((item) => ({ ...item }));

    if (phase === "patch_generated") {
      advancePlanToIndex(nextItems, getPatchGeneratedTargetIndex(nextItems), now);
    }

    if (phase === "patch_applied") {
      advancePlanToIndex(nextItems, getPatchAppliedTargetIndex(nextItems), now);
    }

    if (phase === "validation_success") {
      advancePlanToIndex(nextItems, getValidationSuccessTargetIndex(nextItems), now);
    }

    if (!hasTaskPlanProgressChanged(items, nextItems)) return session;

    return {
      ...session,
      planItems: nextItems,
      planRevisions: normalizeTaskPlanRevisions(session.planRevisions),
      updatedAt: now
    };
  });
}

export async function updateTaskPlanItem(taskSessionId: string | null | undefined, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) {
  if (!taskSessionId) return null;

  if (!planItemId.trim()) {
    throw new HttpError(400, "计划步骤 ID 不能为空");
  }

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const items = normalizeTaskPlanItems(session.planItems);
    const target = items.find((item) => item.id === planItemId);

    if (!target) {
      throw new HttpError(404, "计划步骤不存在");
    }

    const title = updates.title === undefined ? target.title : updates.title.trim();

    if (!title) {
      throw new HttpError(400, "计划标题不能为空");
    }

    const now = Date.now();
    const status = updates.status || target.status;

    const planItems = items.map((item) =>
      item.id === planItemId
        ? {
            ...item,
            title,
            status,
            note: updates.note === undefined ? item.note : updates.note.trim() || undefined,
            updatedAt: now
          }
        : item
    );
    // 计划侧只可驱动尚未完成的单元；完成状态仍需经过显式验证接口。
    const deliveryUnits = normalizeDeliveryUnits(session.deliveryUnits).map((unit) => {
      if (!unit.sourcePlanItemIds.includes(planItemId) || status === "completed") return unit;
      const unitStatus: DeliveryUnitStatus = status === "in_progress" ? "active" : status === "blocked" ? "blocked" : "pending";
      return unit.status === "validated" ? { ...unit, title, updatedAt: now } : { ...unit, title, status: unitStatus, updatedAt: now };
    });

    return {
      ...session,
      planItems,
      deliveryUnits,
      activeDeliveryUnitId: deliveryUnits.find((unit) => unit.status === "active")?.id,
      updatedAt: now
    };
  });
}

export async function deleteTaskPlanItem(taskSessionId: string | null | undefined, planItemId: string) {
  if (!taskSessionId) return null;

  if (!planItemId.trim()) {
    throw new HttpError(400, "计划步骤 ID 不能为空");
  }

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const items = normalizeTaskPlanItems(session.planItems);

    if (!items.some((item) => item.id === planItemId)) {
      throw new HttpError(404, "计划步骤不存在");
    }

    return {
      ...session,
      planItems: items.filter((item) => item.id !== planItemId),
      updatedAt: Date.now()
    };
  });
}

export async function getTaskSession(taskSessionId: string) {
  if (!taskSessionId.trim()) {
    throw new HttpError(400, "taskSessionId is required");
  }

  return readTaskSession(taskSessionId);
}

export async function getTaskSessionContextState(taskSessionId: string) {
  if (!taskSessionId.trim()) throw new HttpError(400, "taskSessionId is required");
  const session = await readTaskSessionRecord(taskSessionId);
  return {
    planItems: session.planItems ?? [],
    planApproval: session.planApproval,
    filesChanged: session.filesChanged,
    contextSummary: session.contextSummary,
    pendingToolCall: session.pendingToolCall,
    runtimeEvidence: session.runtimeEvidence,
    deliveryUnits: session.deliveryUnits ?? [],
    activeDeliveryUnitId: session.activeDeliveryUnitId
  };
}

export async function setTaskSessionRuntimeEvidence(taskSessionId: string | null | undefined, runtimeEvidence: TaskRuntimeEvidence) {
  if (!taskSessionId) return null;
  const normalized = normalizeTaskRuntimeEvidence(runtimeEvidence);
  if (!normalized) throw new Error("runtimeEvidence.taskRunId is required");

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const current = normalizeTaskRuntimeEvidence(session.runtimeEvidence);
    const merged = mergeTaskRuntimeEvidence(current, normalized);
    if (JSON.stringify(current) === JSON.stringify(merged)) return session;

    return {
      ...session,
      // 审批暂停前立即保存，服务重启后仍可恢复同一任务运行的完成证据。
      runtimeEvidence: merged,
      updatedAt: Date.now()
    };
  }, { flushImmediately: true });
}

export async function listTaskSessions(options: { includeDiffView?: boolean } = {}) {
  const files = await listJsonFilesWithLegacyFallback(taskSessionDirectory(), legacyTaskSessionDirectory());

  const sessions = await Promise.all(
    files.map(async (filePath) => {
      const persisted = await readJsonStateFile<TaskSession>(filePath, { recover: true });
      const session = normalizeTaskSession(persisted!);
      // Project Memory 等摘要消费者不需要逐个读取 checkpoint，可跳过较重的历史 diff 组装。
      return options.includeDiffView === false ? session : attachTaskSessionDiffView(session);
    })
  );

  return sessions.sort((left, right) => right.createdAt - left.createdAt);
}

// 删除指定任务会话，便于前端清理历史记录面板中的旧任务。
export async function deleteTaskSession(taskSessionId: string) {
  if (!taskSessionId.trim()) {
    throw new HttpError(400, "taskSessionId is required");
  }

  // 删除前先冲刷同一任务，避免延迟批次在 unlink 后重新创建会话文件。
  await flushPendingTaskSessionWrites(taskSessionId);
  const runtimePath = taskSessionPath(taskSessionId);
  const legacyPath = legacyTaskSessionPath(taskSessionId);
  let deleted = false;

  try {
    await fs.unlink(runtimePath);
    deleted = true;
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;

    if (typedError.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fs.unlink(legacyPath);
    deleted = true;
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;

    if (typedError.code !== "ENOENT") {
      throw error;
    }
  }

  if (!deleted) {
    throw new HttpError(404, "Task session not found");
  }

  await deleteStoredContextArtifacts(taskSessionId);
  lastPersistedTaskSessionHashes.delete(runtimePath);

  return listTaskSessions();
}

export async function appendTaskSessionStep(taskSessionId: string | null | undefined, step: AgentStep) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const filesRead = getFilesReadFromStep(step);
    const filesChanged = getFilesChangedFromStep(step);
    const commands = getCommandsFromStep(step);
    const evidenceFiles = unique([...filesRead, ...filesChanged]);
    const items = normalizeTaskPlanItems(session.planItems);
    const activeIndex = items.findIndex((item) => item.status === "in_progress");
    const planItems =
      activeIndex === -1
        ? items
        : items.map((item, index) => {
            if (index !== activeIndex) return item;

            return {
              ...item,
            evidence: {
                stepIds: unique([...(item.evidence?.stepIds || []), step.id]),
                files: unique([...(item.evidence?.files || []), ...evidenceFiles]),
                commands: unique([...(item.evidence?.commands || []), ...commands])
              },
            updatedAt: Date.now()
            };
          });

    return {
      ...session,
      steps: [...session.steps.filter((item) => item.id !== step.id), step].sort((left, right) => left.createdAt - right.createdAt),
      filesRead: unique([...session.filesRead, ...filesRead]),
      filesChanged: unique([...session.filesChanged, ...filesChanged]),
      commandsRun: unique([...session.commandsRun, ...commands]),
      planItems,
      updatedAt: Date.now()
    };
  });
}

type AgentMessageInput = Omit<AgentMessage, "id" | "createdAt"> & Partial<Pick<AgentMessage, "id" | "createdAt">>;
type PendingToolCallInput = Omit<PendingAgentToolCall, "status" | "createdAt"> & Partial<Pick<PendingAgentToolCall, "createdAt">>;

function createPersistedAgentMessage(message: AgentMessageInput): AgentMessage {
  return {
    id: message.id?.trim() || `agent-message-${Date.now().toString(36)}-${crypto.randomUUID()}`,
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId?.trim() || undefined,
    toolCalls: message.toolCalls,
    createdAt: message.createdAt || Date.now()
  };
}

function createPendingToolCall(input: PendingToolCallInput): PendingAgentToolCall {
  return {
    actionId: input.actionId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    arguments: input.arguments,
    riskLevel: input.riskLevel,
    status: "pending",
    createdAt: input.createdAt || Date.now(),
    agentContext: input.agentContext
  };
}

export async function appendTaskSessionAgentMessage(taskSessionId: string | null | undefined, message: AgentMessageInput) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const nextMessage = createPersistedAgentMessage(message);

    return {
      ...session,
      // 连续 Agent 依赖完整消息链恢复上下文，这里按 createdAt 保持稳定顺序。
      agentMessages: [...normalizeAgentMessages(session.agentMessages).filter((item) => item.id !== nextMessage.id), nextMessage].sort((left, right) => left.createdAt - right.createdAt),
      updatedAt: Date.now()
    };
  });
}

export async function setTaskSessionPendingToolCall(taskSessionId: string | null | undefined, input: PendingToolCallInput) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    status: "awaiting_approval",
    pendingToolCall: createPendingToolCall(input),
    updatedAt: Date.now()
  }), { flushImmediately: true });
}

export async function clearTaskSessionPendingToolCall(taskSessionId: string | null | undefined, actionId?: string) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const pendingToolCall = normalizePendingToolCall(session.pendingToolCall);

    if (actionId && pendingToolCall?.actionId !== actionId) {
      throw new HttpError(404, "Pending tool call not found");
    }

    return {
      ...session,
      status: session.status === "awaiting_approval" ? "running" : session.status,
      pendingToolCall: null,
      // 审批实体和上下文摘要必须同步清理，避免 UI 继续展示已经结束的待审批操作。
      contextSummary: session.contextSummary
        ? { ...session.contextSummary, pendingApproval: null }
        : session.contextSummary,
      updatedAt: Date.now()
    };
  });
}

export async function decideTaskSessionApproval(taskSessionId: string | null | undefined, actionId: string, decision: "approved" | "rejected") {
  if (!taskSessionId) return null;

  if (!actionId.trim()) {
    throw new HttpError(400, "actionId is required");
  }

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    let matched = false;
    const steps = session.steps.map((step) => {
      if (step.type !== "approval_request" || step.actionId !== actionId) {
        return step;
      }

      matched = true;
      return {
        ...step,
        status: decision
      };
    });

    if (!matched) {
      throw new HttpError(404, "Approval request not found");
    }

    const pendingToolCall = normalizePendingToolCall(session.pendingToolCall);
    const clearsPendingToolCall = pendingToolCall?.actionId === actionId;

    return {
      ...session,
      status: clearsPendingToolCall && session.status === "awaiting_approval" ? "running" : session.status,
      pendingToolCall: clearsPendingToolCall ? null : pendingToolCall,
      // 只清理与本次决策匹配的审批摘要，后续新产生的审批不会被误删。
      contextSummary: clearsPendingToolCall && session.contextSummary?.pendingApproval?.actionId === actionId
        ? { ...session.contextSummary, pendingApproval: null }
        : session.contextSummary,
      steps,
      updatedAt: Date.now()
    };
  });
}

export async function addTaskSessionFilesRead(taskSessionId: string | null | undefined, files: string[]) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    filesRead: unique([...session.filesRead, ...files]),
    updatedAt: Date.now()
  }));
}

/** 保存当前文件级计划；新计划覆盖旧计划，确保后续补丁只读取最新边界。 */
export async function setTaskSessionModificationPlan(taskSessionId: string | null | undefined, plan: StructuredModificationPlan) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    modificationPlan: structuredClone(plan),
    updatedAt: Date.now()
  }));
}

export async function addTaskSessionFilesChanged(taskSessionId: string | null | undefined, files: string[]) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    filesChanged: unique([...session.filesChanged, ...files]),
    updatedAt: Date.now()
  }));
}

export async function addTaskSessionCommand(taskSessionId: string | null | undefined, command: string) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    commandsRun: unique([...session.commandsRun, command]),
    updatedAt: Date.now()
  }));
}

export async function addTaskSessionCheckpoint(taskSessionId: string | null | undefined, checkpointId: string) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    checkpointIds: unique([...session.checkpointIds, checkpointId]),
    updatedAt: Date.now()
  }));
}

export async function recordTaskSessionPatchDiagnostics(taskSessionId: string | null | undefined, diagnostics: PatchGenerationDiagnostics) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const existing = normalizePatchDiagnostics(session.patchDiagnostics);
    const nextDiagnostics = diagnostics.patchId ? existing.filter((item) => item.patchId !== diagnostics.patchId) : existing;

    return {
      ...session,
      // 同一个 patch 重新记录时按 patchId 覆盖，避免历史详情里出现重复生成过程。
      patchDiagnostics: [diagnostics, ...nextDiagnostics].slice(0, 50),
      updatedAt: Date.now()
    };
  });
}

export async function recordTaskSessionContextSelection(taskSessionId: string | null | undefined, snapshot: ContextSelectionSnapshot) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    // 保留最近 50 次上下文选取快照，既支持复盘又避免任务文件无限膨胀。
    contextSelectionSnapshots: [snapshot, ...normalizeContextSelectionSnapshots(session.contextSelectionSnapshots)].slice(0, 50),
    updatedAt: Date.now()
  }));
}

export async function recordTaskSessionContextBudget(taskSessionId: string | null | undefined, snapshot: ContextBudgetSnapshot, summary?: StructuredContextSummary | null) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    contextBudgetSnapshot: snapshot,
    // 没有发生历史压缩时保留上一份摘要，便于用户继续查看最近一次压缩状态。
    contextSummary: summary ?? session.contextSummary,
    // 仅聚合单元指标，确保会话文件不持久化完整上下文或工具输出。
    deliveryUnits: normalizeDeliveryUnits(session.deliveryUnits).map((unit) => unit.id !== snapshot.deliveryUnit?.deliveryUnitId ? unit : {
      ...unit,
      contextMetrics: {
        inputTokens: snapshot.deliveryUnit.inputTokens,
        compressionCount: snapshot.deliveryUnit.compressionCount,
        toolCallCount: snapshot.deliveryUnit.toolCallCount,
        changedFileCount: (session.filesChanged ?? []).length,
        validationResult: session.runtimeEvidence?.lastValidationStatus === "success" ? "passed" : session.runtimeEvidence?.lastValidationStatus === "failed" ? "failed" : "not_run",
        updatedAt: snapshot.generatedAt
      },
      updatedAt: Date.now()
    }),
    updatedAt: Date.now()
  }));
}

export async function appendTaskSessionPatchEvent(taskSessionId: string | null | undefined, event: Omit<PatchLifecycleEvent, "id" | "createdAt" | "taskSessionId"> & Partial<Pick<PatchLifecycleEvent, "id" | "createdAt" | "taskSessionId">>) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const now = Date.now();
    const nextEvent: PatchLifecycleEvent = {
      ...event,
      // 事件 ID 保持稳定可覆盖，未提供时由存储层生成，避免调用方重复实现。
      id: event.id?.trim() || `patch-event-${now.toString(36)}-${crypto.randomUUID()}`,
      taskSessionId: event.taskSessionId ?? taskSessionId,
      createdAt: event.createdAt || now
    };

    return {
      ...session,
      // 同一事件重复写入时按 id 覆盖，防止重试或并发刷新造成历史噪声。
      patchEvents: [...normalizePatchLifecycleEvents(session.patchEvents).filter((item) => item.id !== nextEvent.id), nextEvent].sort((left, right) => left.createdAt - right.createdAt).slice(-200),
      updatedAt: now
    };
  });
}

export async function appendTaskSessionFileEditEvent(taskSessionId: string | null | undefined, event: Omit<FileEditLifecycleEvent, "id" | "createdAt" | "taskSessionId"> & Partial<Pick<FileEditLifecycleEvent, "id" | "createdAt" | "taskSessionId">>) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const now = Date.now();
    const nextEvent: FileEditLifecycleEvent = {
      ...event,
      // 工具重试或恢复时可传入固定 id 覆盖旧事件，默认由存储层生成稳定审计记录。
      id: event.id?.trim() || `file-edit-event-${now.toString(36)}-${crypto.randomUUID()}`,
      taskSessionId: event.taskSessionId ?? taskSessionId,
      createdAt: event.createdAt || now
    };

    return {
      ...session,
      fileEditEvents: [...normalizeFileEditLifecycleEvents(session.fileEditEvents).filter((item) => item.id !== nextEvent.id), nextEvent].sort((left, right) => left.createdAt - right.createdAt).slice(-200),
      updatedAt: now
    };
  });
}

export async function addTaskSessionGitCommit(taskSessionId: string | null | undefined, commit: GitCommitRecord) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    gitCommits: [...(session.gitCommits || []).filter((item) => item.hash !== commit.hash), commit],
    updatedAt: Date.now()
  }));
}

export async function updateTaskSessionUserGoal(taskSessionId: string | null | undefined, userGoal: string) {
  if (!taskSessionId || !userGoal.trim()) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    userGoal: userGoal.trim(),
    updatedAt: Date.now()
  }));
}

// 为已有任务会话补写关联聊天 ID，保证历史任务可以重新加载对应对话。
export async function updateTaskSessionChatId(taskSessionId: string | null | undefined, chatId: string) {
  if (!taskSessionId || !chatId.trim()) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    chatId: chatId.trim(),
    updatedAt: Date.now()
  }));
}

export async function updateTaskSessionAgentMode(taskSessionId: string | null | undefined, agentMode: AgentMode) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    // Plan/Act 切换只改变后续 Agent 可用工具，不改写历史步骤。
    agentMode,
    updatedAt: Date.now()
  }));
}

export async function updateTaskSessionStatus(
  taskSessionId: string | null | undefined,
  status: TaskSession["status"],
  runtimeOutcome?: {
    runtimeStatus: NonNullable<TaskSession["runtimeStatus"]>;
    requestedStatus?: NonNullable<TaskSession["runtimeStatus"]>;
    reason?: string;
    completionEvidence?: TaskSession["completionEvidence"];
  }
) {
  if (!taskSessionId) return null;

  if (isTerminalTaskSessionStatus(status)) {
    throw new Error(`终态 ${status} 必须通过 finalizeTaskSession 写入`);
  }

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    // 已终结的任务不可被普通状态更新重新激活。
    if (isTerminalTaskSessionStatus(session.status)) return session;

    return {
      ...session,
      status,
      runtimeStatus: runtimeOutcome?.runtimeStatus ?? session.runtimeStatus,
      runtimeStatusReason: runtimeOutcome?.reason ?? session.runtimeStatusReason,
      completionEvidence: runtimeOutcome?.completionEvidence ?? session.completionEvidence,
      runtimeOutcome: runtimeOutcome
        ? {
            requestedStatus: runtimeOutcome.requestedStatus ?? runtimeOutcome.runtimeStatus,
            effectiveStatus: runtimeOutcome.runtimeStatus,
            reason: runtimeOutcome.reason,
            completionEvidence: runtimeOutcome.completionEvidence,
            recordedAt: Date.now()
          }
        : session.runtimeOutcome,
      updatedAt: Date.now()
    };
  }, { flushImmediately: status === "awaiting_approval" });
}

export type CommitTaskSessionFinalizationInput = {
  status: TaskSessionTerminalStatus;
  source: TaskSessionFinalizationSource;
  runtimeOutcome?: {
    runtimeStatus: NonNullable<TaskSession["runtimeStatus"]>;
    requestedStatus?: NonNullable<TaskSession["runtimeStatus"]>;
    reason?: string;
    completionEvidence?: TaskSession["completionEvidence"];
  };
};

/**
 * 仅供 taskSessionFinalizer 使用：在单任务写队列内原子提交第一次终态。
 */
export async function commitTaskSessionFinalization(
  taskSessionId: string | null | undefined,
  input: CommitTaskSessionFinalizationInput
) {
  if (!taskSessionId) return null;

  let transitioned = false;
  let updated = await enqueueTaskSessionUpdate(taskSessionId, (session) => {
    if (isTerminalTaskSessionStatus(session.status)) {
      return session;
    }

    const finalizedAt = Date.now();
    transitioned = true;
    return {
      ...session,
      status: input.status,
      runtimeStatus: input.runtimeOutcome?.runtimeStatus ?? session.runtimeStatus,
      runtimeStatusReason: input.runtimeOutcome?.reason ?? session.runtimeStatusReason,
      completionEvidence: input.runtimeOutcome?.completionEvidence ?? session.completionEvidence,
      runtimeOutcome: input.runtimeOutcome
        ? {
            requestedStatus: input.runtimeOutcome.requestedStatus ?? input.runtimeOutcome.runtimeStatus,
            effectiveStatus: input.runtimeOutcome.runtimeStatus,
            reason: input.runtimeOutcome.reason,
            completionEvidence: input.runtimeOutcome.completionEvidence,
            recordedAt: finalizedAt
          }
        : session.runtimeOutcome,
      finalization: {
        status: input.status,
        source: input.source,
        finalizedAt
      },
      updatedAt: finalizedAt
    };
  }, { flushImmediately: true });

  if (transitioned) {
    const finalMetricStatus = input.status === "success" ? "completed" : input.status;
    const metrics = await getTaskMetricsSnapshot(taskSessionId);
    if (metrics) {
      updated = await enqueueTaskSessionUpdate(taskSessionId, (session) => ({
        ...session,
        modelUsage: metrics.usage,
        estimatedCostUsd: metrics.estimatedCostUsd ?? null,
        updatedAt: Date.now()
      }));
    }
    scheduleTaskMetricsFinalization(taskSessionId, finalMetricStatus);
  }
  return updated;
}
