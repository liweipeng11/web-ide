import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import { legacyProjectRuntimeDirectory, listJsonFilesWithLegacyFallback, projectRuntimeDirectory } from "./statePaths.js";
import type { AgentStep, TaskPlanItem, TaskPlanItemStatus, TaskSession } from "./types.js";
import type { GitCommitRecord } from "./gitWorkflow/types.js";

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
  return step.type === "edit" ? step.files : [];
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

  const session = JSON.parse(content) as TaskSession;
  return {
    ...session,
    // 旧任务记录没有计划字段，读取时补齐可以让前端和 API 逻辑保持简单。
    planItems: normalizeTaskPlanItems(session.planItems)
  };
}

async function writeTaskSession(session: TaskSession) {
  await fs.mkdir(taskSessionDirectory(), { recursive: true });
  await fs.writeFile(taskSessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function createTaskSession(userGoal: string, options: { chatId?: string; messageIds?: string[] } = {}): Promise<TaskSession> {
  const now = Date.now();
  const session: TaskSession = {
    id: `task-${now.toString(36)}-${crypto.randomUUID()}`,
    userGoal,
    chatId: options.chatId,
    messageIds: options.messageIds,
    status: "running",
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    steps: [],
    planItems: [],
    planApproval: { required: false, status: "not_required" },
    checkpointIds: [],
    gitCommits: [],
    createdAt: now,
    updatedAt: now
  };

  await writeTaskSession(session);
  return session;
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

export async function setTaskPlanItems(taskSessionId: string | null | undefined, items: { title: string; status?: TaskPlanItemStatus; note?: string }[], options: { requireApproval?: boolean } = {}) {
  if (!taskSessionId) return null;

  const now = Date.now();
  const planItems = items
    .map((item, index): TaskPlanItem | null => {
      const title = item.title.trim();

      if (!title) return null;

      return {
        id: `plan-${now.toString(36)}-${index}-${crypto.randomUUID()}`,
        title,
        status: item.status || (index === 0 ? "in_progress" : "pending"),
        note: item.note?.trim() || undefined,
        evidence: { stepIds: [], files: [], commands: [] },
        createdAt: now,
        updatedAt: now
      };
    })
    .filter((item): item is TaskPlanItem => Boolean(item));

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    planItems,
    planApproval: options.requireApproval
      ? {
          required: true,
          status: "pending",
          requestedAt: now
        }
      : session.planApproval || { required: false, status: "not_required" },
    updatedAt: now
  }));
}

export async function approveTaskSessionPlan(taskSessionId: string | null | undefined) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => ({
    ...session,
    planApproval: {
      required: Boolean(session.planApproval?.required),
      status: "approved",
      requestedAt: session.planApproval?.requestedAt,
      approvedAt: Date.now()
    },
    updatedAt: Date.now()
  }));
}

export type TaskPlanProgressPhase = "patch_generated" | "patch_applied" | "validation_failed" | "validation_success" | "task_failed" | "task_cancelled";

export async function advanceTaskPlanProgress(taskSessionId: string | null | undefined, phase: TaskPlanProgressPhase) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    const items = normalizeTaskPlanItems(session.planItems);

    if (!items.length) {
      return session;
    }

    const now = Date.now();
    const nextItems = items.map((item) => ({ ...item }));
    const completeActiveAndStartNext = () => {
      const activeIndex = nextItems.findIndex((item) => item.status === "in_progress");
      const targetIndex = activeIndex === -1 ? nextItems.findIndex((item) => item.status === "pending") : activeIndex;

      if (targetIndex !== -1) {
        nextItems[targetIndex] = { ...nextItems[targetIndex], status: "completed", updatedAt: now };
      }

      const pendingIndex = nextItems.findIndex((item) => item.status === "pending");

      if (pendingIndex !== -1) {
        nextItems[pendingIndex] = { ...nextItems[pendingIndex], status: "in_progress", updatedAt: now };
      }
    };

    if (phase === "patch_generated" || phase === "patch_applied") {
      completeActiveAndStartNext();
    }

    if (phase === "validation_success") {
      for (let index = 0; index < nextItems.length; index += 1) {
        if (nextItems[index].status !== "blocked") {
          nextItems[index] = { ...nextItems[index], status: "completed", updatedAt: now };
        }
      }
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
    }

    return {
      ...session,
      planItems: nextItems,
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

export async function listTaskSessions() {
  const files = await listJsonFilesWithLegacyFallback(taskSessionDirectory(), legacyTaskSessionDirectory());

  const sessions = await Promise.all(
    files.map(async (filePath) => {
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content) as TaskSession;
    })
  );

  return sessions.sort((left, right) => right.createdAt - left.createdAt);
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

export async function updateTaskSessionStatus(taskSessionId: string | null | undefined, status: TaskSession["status"]) {
  if (!taskSessionId) return null;

  return enqueueTaskSessionUpdate(taskSessionId, (session) => {
    if (session.status !== "running" && status === "cancelled") {
      return session;
    }

    return {
      ...session,
      status,
      updatedAt: Date.now()
    };
  });
}
