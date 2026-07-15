import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCheckpoint } from "./checkpointStore.js";
import { HttpError } from "./errors.js";
import { legacyProjectRuntimeDirectory, listJsonFilesWithLegacyFallback, projectRuntimeDirectory } from "./statePaths.js";
import type { AgentMessage, AgentMessageRole, AgentMode, AgentStep, FileEditLifecycleEvent, FileEditLifecycleEventType, PatchFilterReason, PatchFilterStage, PatchGenerationDiagnostics, PatchLifecycleEvent, PatchLifecycleEventType, PendingAgentToolCall, TaskPlanItem, TaskPlanItemStatus, TaskPlanRevision, TaskPlanRevisionTrigger, TaskSession } from "./types.js";
import type { CandidateFileRecord, ContextSelectionSnapshot, EvidenceRecord, MissingRequirementRecord, PatchCompletenessReport, RequiredCompanionFile } from "./contextSelection/types.js";
import type { GitCommitRecord } from "./gitWorkflow/types.js";
import type { TaskWorkflowSnapshot, TaskWorkflowSource, TaskWorkflowType } from "./taskWorkflow/index.js";
import { scheduleTaskMetricsFinalization } from "./observability/index.js";

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

function withoutValues(values: string[], excluded: string[]) {
  const excludedSet = new Set(excluded);
  return values.filter((value) => !excludedSet.has(value));
}

const taskSessionWriteQueues = new Map<string, Promise<unknown>>();

async function enqueueTaskSessionUpdate(taskSessionId: string, update: (session: TaskSession) => TaskSession | Promise<TaskSession>) {
  const previous = taskSessionWriteQueues.get(taskSessionId) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const session = await readTaskSession(taskSessionId);
      const updated = await update(session);
      await writeTaskSession(updated);
      return updated;
    });

  taskSessionWriteQueues.set(taskSessionId, next);

  try {
    return await next;
  } finally {
    if (taskSessionWriteQueues.get(taskSessionId) === next) {
      taskSessionWriteQueues.delete(taskSessionId);
    }
  }
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
  return {
    ...session,
    agentMode: isAgentMode(session.agentMode) ? session.agentMode : "act",
    workflow: normalizeTaskWorkflow(session.workflow),
    // 旧任务记录没有 Agent 消息字段，读取时补齐，后续 runtime 可以直接追加和恢复。
    agentMessages: normalizeAgentMessages(session.agentMessages),
    pendingToolCall: normalizePendingToolCall(session.pendingToolCall),
    planItems: normalizeTaskPlanItems(session.planItems),
    planRevisions: normalizeTaskPlanRevisions(session.planRevisions),
    patchDiagnostics: normalizePatchDiagnostics(session.patchDiagnostics),
    contextSelectionSnapshots: normalizeContextSelectionSnapshots(session.contextSelectionSnapshots),
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

async function readTaskSession(taskSessionId: string): Promise<TaskSession> {
  const content = await fs.readFile(taskSessionPath(taskSessionId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return fs.readFile(legacyTaskSessionPath(taskSessionId), "utf8").catch((legacyError: NodeJS.ErrnoException) => {
        if (legacyError.code === "ENOENT") {
          throw new HttpError(404, "Task session not found");
        }
        throw legacyError;
      });
    }

    throw error;
  });

  return attachTaskSessionDiffView(normalizeTaskSession(JSON.parse(content) as TaskSession));
}

async function writeTaskSession(session: TaskSession) {
  await fs.mkdir(taskSessionDirectory(), { recursive: true });
  await fs.writeFile(taskSessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function createTaskSession(userGoal: string, options: { chatId?: string; messageIds?: string[]; agentMode?: AgentMode } = {}): Promise<TaskSession> {
  const now = Date.now();
  const session: TaskSession = {
    id: `task-${now.toString(36)}-${crypto.randomUUID()}`,
    userGoal,
    agentMode: options.agentMode || "act",
    chatId: options.chatId,
    messageIds: options.messageIds,
    status: "running",
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    steps: [],
    agentMessages: [],
    pendingToolCall: null,
    planItems: [],
    planRevisions: [],
    planApproval: { required: false, status: "not_required" },
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

export async function setTaskPlanItems(taskSessionId: string | null | undefined, items: { workflowStepId?: string; title: string; status?: TaskPlanItemStatus; note?: string }[], options: { requireApproval?: boolean; revision?: { trigger: TaskPlanRevisionTrigger; reason: string } } = {}) {
  if (!taskSessionId) return null;

  const now = Date.now();
  const planItems = items
    .map((item, index): TaskPlanItem | null => {
      const title = item.title.trim();

      if (!title) return null;

      return {
        id: `plan-${now.toString(36)}-${index}-${crypto.randomUUID()}`,
        workflowStepId: item.workflowStepId?.trim() || undefined,
        title,
      status: item.status || (index === 0 ? "in_progress" : "pending"),
      note: item.note?.trim() || undefined,
      evidence: { stepIds: [], files: [], commands: [] },
      createdAt: now,
      updatedAt: now
      };
    })
    .filter((item): item is TaskPlanItem => Boolean(item));

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const previousItems = normalizeTaskPlanItems(session.planItems);
    const revision = options.revision
      ? createTaskPlanRevision({
          trigger: options.revision.trigger,
          reason: options.revision.reason,
          beforeItems: previousItems,
          afterItems: planItems
        })
      : null;

    return {
      ...session,
      planItems,
      planRevisions: revision ? [revision, ...normalizeTaskPlanRevisions(session.planRevisions)].slice(0, 20) : normalizeTaskPlanRevisions(session.planRevisions),
      planApproval: options.requireApproval
        ? {
            required: true,
            status: "pending",
            requestedAt: now
          }
        : session.planApproval || { required: false, status: "not_required" },
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

// ???????????????? Claude Code ????????????
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
        note: "?????????????????????",
        updatedAt: now
      };
    }

    const revision = createTaskPlanRevision({
      trigger: "user",
      reason: instruction.trim() || "???????????????",
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
    if (items[index].status !== "blocked") {
      items[index] = { ...items[index], status: "completed", updatedAt: now };
    }
  }
}

function startNextPendingPlanItem(items: TaskPlanItem[], startIndex: number, now: number) {
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
    const items = normalizeTaskPlanItems(session.planItems);

    if (!items.length) {
      return session;
    }

    const now = Date.now();
    const nextItems = items.map((item) => ({ ...item }));
    let autoRevisionReason = "";

    if (phase === "patch_generated") {
      advancePlanToIndex(nextItems, getPatchGeneratedTargetIndex(nextItems), now);
    }

    if (phase === "patch_applied") {
      advancePlanToIndex(nextItems, getPatchAppliedTargetIndex(nextItems), now);
    }

    if (phase === "validation_success") {
      advancePlanToIndex(nextItems, getValidationSuccessTargetIndex(nextItems), now);
    }

    if (phase === "validation_failed" || phase === "task_failed" || phase === "task_cancelled") {
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

      if (phase === "validation_failed" || phase === "task_failed") {
        // 失败后自动回到计划阶段，模拟主流 AI IDE 的滚动重规划检查点。
        nextItems.push({
          id: `plan-${now.toString(36)}-replan-${crypto.randomUUID()}`,
          title: phase === "validation_failed" ? "根据验证反馈调整计划" : "重新评估失败原因并修订方案",
          status: "in_progress",
        note: "系统已插入重规划步骤，请结合失败信息确认下一步。",
        evidence: { stepIds: [], files: [], commands: [] },
        createdAt: now,
        updatedAt: now
        });
        autoRevisionReason = phase === "validation_failed" ? "验证失败后自动回到计划阶段" : "任务失败后自动回到计划阶段";
      }
    }

    const revision = autoRevisionReason
      ? createTaskPlanRevision({
          trigger: phase === "validation_failed" ? "validation" : "agent",
          reason: autoRevisionReason,
          beforeItems: items,
          afterItems: nextItems
        })
      : null;

    return {
      ...session,
      planItems: nextItems,
      planRevisions: revision ? [revision, ...normalizeTaskPlanRevisions(session.planRevisions)].slice(0, 20) : normalizeTaskPlanRevisions(session.planRevisions),
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

    return {
      ...session,
      planItems: items.map((item) =>
        item.id === planItemId
          ? {
              ...item,
              title,
              status,
            note: updates.note === undefined ? item.note : updates.note.trim() || undefined,
            updatedAt: now
            }
          : item
      ),
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

export async function listTaskSessions(options: { includeDiffView?: boolean } = {}) {
  const files = await listJsonFilesWithLegacyFallback(taskSessionDirectory(), legacyTaskSessionDirectory());

  const sessions = await Promise.all(
    files.map(async (filePath) => {
      const content = await fs.readFile(filePath, "utf8");
      const session = normalizeTaskSession(JSON.parse(content) as TaskSession);
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
  }));
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

export async function updateTaskSessionStatus(taskSessionId: string | null | undefined, status: TaskSession["status"]) {
  if (!taskSessionId) return null;

  const updated = await enqueueTaskSessionUpdate(taskSessionId, (session) => {
    if (!["running", "awaiting_approval", "awaiting_user", "paused"].includes(session.status) && status === "cancelled") {
      return session;
    }

    return {
      ...session,
      status,
      updatedAt: Date.now()
    };
  });

  if (updated.status === "success" || updated.status === "failed" || updated.status === "cancelled") {
    scheduleTaskMetricsFinalization(taskSessionId, updated.status === "success" ? "completed" : updated.status);
  }
  return updated;
}
