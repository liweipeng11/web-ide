import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { buildContextualEditRequest, classifyAgentRequest, generateFileChatReply, shouldGeneratePatchForIntent, streamFileChatReply, type AgentStep } from "./aiClient.js";
import { appendFileChatTurn, branchFileChatMessages, clearFileChatMessages, deleteFileChatHistory, deleteFileChatMessage, ensureFileChatMessages, finishFileChatTurn, getFileChatMessages, listFileChatHistories, startFileChatTurn } from "./chatStore.js";
import { createCheckpoint, getCheckpoint, rollbackCheckpoint } from "./checkpointStore.js";
import { searchWorkspaceCode } from "./codeSearch.js";
import { discoverProjectCommands } from "./commandDiscovery.js";
import { evaluateCommandPolicy } from "./commandPolicy.js";
import { getRecentCommandResults } from "./commandResults.js";
import { runProjectCommand } from "./commandRunner.js";
import { createEditPatchResponse } from "./editPatchService.js";
import { runAutoValidation } from "./autoValidationService.js";
import { createWorkspaceFile, listFiles, readWorkspaceFile, workspacePathExists, writeWorkspaceFile } from "./fileTools.js";
import { createGitWorkflowRouter } from "./gitWorkflow/routes.js";
import { clearPendingPatches, deletePendingPatch, getPendingPatch, normalizePatchPath, removePendingPatchFile } from "./patchStore.js";
import { discoverProjectRules, ensureGlobalRulesDirectory, ensureProjectRulesDirectory } from "./projectRules.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { ApplyPatchRequest, ApprovalDecisionRequest, AutoValidationRequest, FileChatMessage, FileChatRequest, GenerateEditRequest, InterruptTaskPlanRequest, RejectPatchRequest, RewriteTaskPlanRequest, RollbackCheckpointRequest, RunCommandRequest, SaveFileRequest, TaskPlanItemStatus, TaskSession, UpdateTaskPlanItemRequest, UpsertTaskPlanItemRequest } from "./types.js";
import { addTaskPlanItem, addTaskSessionCheckpoint, addTaskSessionCommand, addTaskSessionFilesChanged, addTaskSessionFilesRead, advanceTaskPlanProgress, appendTaskSessionStep, approveTaskSessionPlan, createTaskSession, decideTaskSessionApproval, deleteTaskPlanItem, deleteTaskSession, getTaskSession, interruptTaskSessionForReplan, listTaskSessions, updateTaskPlanItem, updateTaskSessionChatId, updateTaskSessionStatus, updateTaskSessionUserGoal } from "./taskSessionStore.js";
import { initializeTaskPlan, rewriteTaskPlanWithInstruction } from "./taskPlanService.js";
import { attachTerminalServer } from "./terminalServer.js";
import { pickWorkspaceFolder } from "./workspacePicker.js";
import { getWorkspaceRoot, initializeWorkspaceRoot, setWorkspaceRoot } from "./workspaceStore.js";

const app = express();
const server = createServer(app);
const workspaceChatKey = "__workspace_chat__";
const maxChatContextFiles = 8;
const maxChatContextCharsPerFile = 20_000;

app.use(express.json({ limit: "5mb" }));
app.use("/api/git-workflow", createGitWorkflowRouter());

function createStreamRunId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function logStreamRoute(runId: string, event: string, detail?: unknown) {
  console.log(`[route:${runId}] ${event}`, detail ?? "");
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function getRequestedContextPaths(requestBody: Partial<FileChatRequest>) {
  const paths = Array.isArray(requestBody.paths) ? requestBody.paths : [];
  const legacyPath = typeof requestBody.path === "string" && requestBody.path.trim() ? [requestBody.path] : [];

  return [...new Set([...paths, ...legacyPath].filter((filePath): filePath is string => typeof filePath === "string" && Boolean(filePath.trim())))].slice(0, maxChatContextFiles);
}

function getChatKey(requestBody?: Partial<FileChatRequest>, query?: Request["query"]) {
  const bodyChatId = typeof requestBody?.chatId === "string" && requestBody.chatId.trim() ? requestBody.chatId.trim() : "";
  const queryChatId = typeof query?.chatId === "string" && query.chatId.trim() ? query.chatId.trim() : "";

  return bodyChatId || queryChatId || workspaceChatKey;
}

function requireChatKey(requestBody?: Partial<FileChatRequest>, query?: Request["query"]) {
  const bodyChatId = typeof requestBody?.chatId === "string" && requestBody.chatId.trim() ? requestBody.chatId.trim() : "";
  const queryChatId = typeof query?.chatId === "string" && query.chatId.trim() ? query.chatId.trim() : "";
  const chatKey = bodyChatId || queryChatId;

  if (!chatKey) {
    throw new HttpError(400, "chatId is required");
  }

  return chatKey;
}

// 统一校验计划状态，避免接口写入前端无法识别的状态值。
function parseTaskPlanStatus(value: unknown): TaskPlanItemStatus | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "blocked") return value;
  throw new HttpError(400, "计划状态无效");
}

async function readChatContextFiles(paths: string[]) {
  return Promise.all(
    paths.map(async (filePath) => ({
      path: filePath,
      content: (await readWorkspaceFile(filePath)).slice(0, maxChatContextCharsPerFile)
    }))
  );
}

function formatTaskSessionStatus(status: TaskSession["status"]) {
  return status === "running" ? "?????" : status === "success" ? "???" : status === "failed" ? "???" : status === "awaiting_replan" ? "??????" : "?????";
}

async function shouldAutoCancelTaskSession(taskSessionId: string | null) {
  if (!taskSessionId) return true;

  try {
    const session = await getTaskSession(taskSessionId);
    return session.status !== "awaiting_replan";
  } catch {
    return true;
  }
}

function summarizeTaskSessionList(title: string, values: string[]) {
  if (!values.length) return "";

  return [`${title}：`, ...values.slice(0, 8).map((value) => `- ${value}`), values.length > 8 ? `- 另有 ${values.length - 8} 项` : ""].filter(Boolean).join("\n");
}

function createTaskSessionFallbackMessages(session: TaskSession): FileChatMessage[] {
  const createdAt = new Date(session.createdAt).toISOString();
  const updatedAt = new Date(session.updatedAt).toISOString();
  const summaries = [
    "已恢复这条任务历史，可以在这里继续围绕该任务对话。",
    `任务状态：${formatTaskSessionStatus(session.status)}`,
    summarizeTaskSessionList("读取过的文件", session.filesRead),
    summarizeTaskSessionList("改动过的文件", session.filesChanged),
    summarizeTaskSessionList("执行过的命令", session.commandsRun)
  ].filter(Boolean);

  // 旧任务可能没有真实聊天记录，这里用任务元数据生成最小上下文，保证继续提问时有明确起点。
  return [
    {
      id: `task-resume-user:${session.id}`,
      role: "user",
      content: session.userGoal || "恢复历史任务",
      createdAt
    },
    {
      id: `task-resume-assistant:${session.id}`,
      role: "assistant",
      content: summaries.join("\n\n"),
      createdAt: updatedAt
    }
  ];
}

app.get(
  "/api/workspace",
  asyncRoute(async (_request, response) => {
    response.json({ workspaceRoot: getWorkspaceRoot() });
  })
);

app.post(
  "/api/workspace/open",
  asyncRoute(async (request, response) => {
    const workspaceRoot = typeof request.body?.workspaceRoot === "string" ? request.body.workspaceRoot : "";
    const nextWorkspaceRoot = await setWorkspaceRoot(workspaceRoot);
    await ensureProjectRulesDirectory(nextWorkspaceRoot);

    clearPendingPatches();
    response.json({ workspaceRoot: nextWorkspaceRoot });
  })
);

app.post(
  "/api/workspace/pick",
  asyncRoute(async (_request, response) => {
    const selectedPath = await pickWorkspaceFolder();

    if (!selectedPath) {
      response.json({ workspaceRoot: getWorkspaceRoot(), cancelled: true });
      return;
    }

    const nextWorkspaceRoot = await setWorkspaceRoot(selectedPath);
    await ensureProjectRulesDirectory(nextWorkspaceRoot);

    clearPendingPatches();
    response.json({ workspaceRoot: nextWorkspaceRoot, cancelled: false });
  })
);

app.get(
  "/api/files",
  asyncRoute(async (request, response) => {
    const dir = typeof request.query.dir === "string" ? request.query.dir : "";
    const includeIgnored = request.query.includeIgnored === "true";
    response.json(await listFiles(dir, includeIgnored));
  })
);

app.get(
  "/api/file",
  asyncRoute(async (request, response) => {
    const filePath = typeof request.query.path === "string" ? request.query.path : "";

    if (!filePath) {
      throw new HttpError(400, "path is required");
    }

    const includeIgnored = request.query.includeIgnored === "true";
    response.json({
      path: filePath,
      content: await readWorkspaceFile(filePath, { allowIgnored: includeIgnored })
    });
  })
);

app.get(
  "/api/search",
  asyncRoute(async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    response.json({ results: await searchWorkspaceCode(query) });
  })
);

app.get(
  "/api/commands",
  asyncRoute(async (_request, response) => {
    const workspaceRoot = getWorkspaceRoot();
    const commands = workspaceRoot ? await discoverProjectCommands(workspaceRoot) : [];
    const results = await getRecentCommandResults();

    response.json({ commands, results });
  })
);

app.get(
  "/api/project-rules",
  asyncRoute(async (request, response) => {
    const rawPaths = request.query.path;
    const contextPaths = (Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : []).filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    response.json(await discoverProjectRules(contextPaths));
  })
);

app.post(
  "/api/commands/policy",
  asyncRoute(async (request, response) => {
    const command = typeof request.body?.command === "string" ? request.body.command : "";

    if (!command.trim()) {
      throw new HttpError(400, "command is required");
    }

    response.json({ policy: evaluateCommandPolicy(command) });
  })
);

app.post(
  "/api/commands/run",
  asyncRoute(async (request, response) => {
    const { command, cwd, chatId, taskSessionId, confirmed } = request.body as Partial<RunCommandRequest>;

    if (!command?.trim()) {
      throw new HttpError(400, "command is required");
    }

    const result = await runProjectCommand(command, cwd, chatId, Boolean(confirmed));
    await addTaskSessionCommand(taskSessionId, result.command);
    await appendTaskSessionStep(taskSessionId, createAgentStep({ type: "command", command: result.command, status: result.status === "success" || result.status === "running" ? "success" : "failed", result }));
    await advanceTaskPlanProgress(taskSessionId, result.status === "success" || result.status === "running" ? "validation_success" : "validation_failed");
    response.json({ result });
  })
);

app.post(
  "/api/ai/validate-and-fix",
  asyncRoute(async (request, response) => {
    const { command, selectedPath, taskSessionId, attempts, maxAttempts, confirmed } = request.body as Partial<AutoValidationRequest>;

    if (!command?.trim()) {
      throw new HttpError(400, "command is required");
    }

    response.json(
      await runAutoValidation({
        command,
        selectedPath,
        taskSessionId,
        attempts,
        maxAttempts,
        confirmed
      })
    );
  })
);

app.post(
  "/api/file",
  asyncRoute(async (request, response) => {
    const { path: filePath, content } = request.body as Partial<SaveFileRequest>;

    if (!filePath || typeof content !== "string") {
      throw new HttpError(400, "path and content are required");
    }

    await writeWorkspaceFile(filePath, content);
    response.json({ success: true, path: filePath });
  })
);

app.post(
  "/api/ai/generate-edit",
  asyncRoute(async (request, response) => {
    const { path: filePath, userRequest } = request.body as Partial<GenerateEditRequest>;

    if (!userRequest) {
      throw new HttpError(400, "userRequest is required");
    }

    const taskSession = await createTaskSession(userRequest.trim());
    const plannedTaskSession = await initializeTaskPlan(taskSession, {
      intent: "edit",
      confidence: 1,
      normalizedGoal: userRequest.trim(),
      reason: "Direct edit endpoint"
    }, { forceApproval: true });

    if (plannedTaskSession?.planApproval?.status === "pending") {
      response.status(202).json({
        taskSessionId: plannedTaskSession.id,
        planPending: true,
        summary: "已生成文件修改计划，请先批准计划后再执行代码修改。",
        agentSteps: []
      });
      return;
    }
    const agentSteps: AgentStep[] = [];
    const taskStepWrites: Promise<unknown>[] = [];
    const pushAgentStep = (step: AgentStep) => {
      agentSteps.push(step);
      taskStepWrites.push(appendTaskSessionStep(taskSession.id, step));
    };

    try {
      const patchResponse = await createEditPatchResponse(filePath, userRequest, pushAgentStep, taskSession.id);
      await advanceTaskPlanProgress(taskSession.id, "patch_generated");
      await Promise.all(taskStepWrites);
      response.json({
        ...patchResponse,
        taskSessionId: plannedTaskSession?.id || taskSession.id,
        agentSteps
      });
    } catch (error) {
      await Promise.allSettled(taskStepWrites);
      await advanceTaskPlanProgress(taskSession.id, "task_failed");
      await updateTaskSessionStatus(taskSession.id, "failed");
      throw error;
    }
  })
);

app.post("/api/ai/generate-edit/stream", async (request, response) => {
  let completed = false;
  let clientClosed = false;
  let taskSessionId: string | null = null;
  const streamRunId = createStreamRunId("edit-stream");

  response.on("close", () => {
    if (completed) return;
    clientClosed = true;
    void advanceTaskPlanProgress(taskSessionId, "task_cancelled");
    void updateTaskSessionStatus(taskSessionId, "cancelled");
  });

  const sendEvent = (event: string, data: unknown) => {
    if (clientClosed || response.writableEnded) return;
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { path: filePath, userRequest } = request.body as Partial<GenerateEditRequest>;
    logStreamRoute(streamRunId, "start", { filePath: filePath || null, hasUserRequest: Boolean(userRequest) });

    if (!userRequest) {
      throw new HttpError(400, "userRequest is required");
    }

    const taskSession = await createTaskSession(userRequest.trim());
    taskSessionId = taskSession.id;
    const plannedTaskSession = await initializeTaskPlan(taskSession, {
      intent: "edit",
      confidence: 1,
      normalizedGoal: userRequest.trim(),
      reason: "Direct edit stream endpoint"
    }, { forceApproval: true });

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const agentSteps: AgentStep[] = [];
    const taskStepWrites: Promise<unknown>[] = [];
    const pushAgentStep = (step: AgentStep) => {
      agentSteps.push(step);
      taskStepWrites.push(appendTaskSessionStep(taskSession.id, step));
      sendEvent("agent_step", { step });
    };

    sendEvent("task_session", { session: plannedTaskSession || taskSession });

    if (plannedTaskSession?.planApproval?.status === "pending") {
      completed = true;
      sendEvent("plan_pending", {
        taskSessionId: plannedTaskSession.id,
        message: "已生成文件修改计划，请先批准计划后再执行代码修改。"
      });
      response.end();
      return;
    }

    pushAgentStep({
      id: `${streamRunId}:start`,
      createdAt: Date.now(),
      type: "message",
      content: filePath ? `准备编辑：${filePath}` : "准备处理工作区编辑请求"
    });

    const patchResponse = await createEditPatchResponse(filePath, userRequest, (step) => {
      pushAgentStep(step);
    }, taskSession.id);
    const progressedTaskSession = await advanceTaskPlanProgress(taskSession.id, "patch_generated");

    pushAgentStep({
      id: `${streamRunId}:done`,
      createdAt: Date.now(),
      type: "message",
      content: `已生成 ${patchResponse.files.length} 个文件的修改`
    });

    completed = true;
    await Promise.all(taskStepWrites);
    logStreamRoute(streamRunId, "done", { patchId: patchResponse.patchId, files: patchResponse.files.map((file) => file.path) });
    if (progressedTaskSession) {
      sendEvent("task_session", { session: progressedTaskSession });
    }
    sendEvent("done", { patch: { ...patchResponse, taskSessionId: taskSession.id, agentSteps } });
    response.end();
  } catch (error) {
    completed = true;
    const message = error instanceof Error ? error.message : "Internal server error";
    logStreamRoute(streamRunId, "error", { message });
    console.error(message);
    if (clientClosed) {
      if (await shouldAutoCancelTaskSession(taskSessionId)) {
        await advanceTaskPlanProgress(taskSessionId, "task_cancelled");
        await updateTaskSessionStatus(taskSessionId, "cancelled");
      }
    } else {
      await advanceTaskPlanProgress(taskSessionId, "task_failed");
      await updateTaskSessionStatus(taskSessionId, "failed");
    }

    if (!response.headersSent) {
      response.status(error instanceof HttpError ? error.status : 500).json({ error: message });
      return;
    }

    sendEvent("agent_step", { step: createAgentStep({ type: "error", message }) });
    sendEvent("error", { error: message });
    response.end();
  }
});

app.get(
  "/api/ai/file-chat",
  asyncRoute(async (request, response) => {
    response.json({ messages: await getFileChatMessages(getChatKey(undefined, request.query)) });
  })
);

app.get(
  "/api/task-sessions",
  asyncRoute(async (_request, response) => {
    response.json({ sessions: await listTaskSessions() });
  })
);

app.get(
  "/api/task-sessions/:taskSessionId",
  asyncRoute(async (request, response) => {
    response.json({ session: await getTaskSession(String(request.params.taskSessionId || "")) });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/resume-chat",
  asyncRoute(async (request, response) => {
    const session = await getTaskSession(String(request.params.taskSessionId || ""));
    const chatId = session.chatId?.trim() || `chat:${session.id}`;
    const messages = await ensureFileChatMessages(chatId, createTaskSessionFallbackMessages(session));
    const linkedSession = session.chatId === chatId ? session : (await updateTaskSessionChatId(session.id, chatId)) || session;

    response.json({ session: linkedSession, chatId, messages });
  })
);

app.delete(
  "/api/task-sessions/:taskSessionId",
  asyncRoute(async (request, response) => {
    response.json({ sessions: await deleteTaskSession(String(request.params.taskSessionId || "")) });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/commands",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const command = typeof request.body?.command === "string" ? request.body.command : "";
    const result = request.body?.result;

    if (!command.trim()) {
      throw new HttpError(400, "command is required");
    }

    await addTaskSessionCommand(taskSessionId, command);
    await appendTaskSessionStep(
      taskSessionId,
      createAgentStep({
        type: "command",
        command,
        status: result?.status === "success" || result?.status === "running" ? "success" : result ? "failed" : "cancelled",
        result: result || null
      })
    );
    await advanceTaskPlanProgress(taskSessionId, result?.status === "success" || result?.status === "running" ? "validation_success" : "validation_failed");
    response.json({ success: true });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/plan-items",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const { title, note } = request.body as Partial<UpsertTaskPlanItemRequest>;

    if (!title?.trim()) {
      throw new HttpError(400, "计划标题不能为空");
    }

    const session = await addTaskPlanItem(taskSessionId, {
      title,
      status: parseTaskPlanStatus(request.body?.status),
      note
    });
    response.json({ session });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/plan-items/rewrite",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const { instruction } = request.body as Partial<RewriteTaskPlanRequest>;

    if (!instruction?.trim()) {
      throw new HttpError(400, "计划调整要求不能为空");
    }

    const session = await getTaskSession(taskSessionId);
    response.json({ session: await rewriteTaskPlanWithInstruction(session, instruction.trim()) });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/plan/replan",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const { instruction } = request.body as Partial<InterruptTaskPlanRequest>;
    response.json({ session: await interruptTaskSessionForReplan(taskSessionId, instruction || "") });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/plan/approve",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    response.json({ session: await approveTaskSessionPlan(taskSessionId) });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/approvals/:actionId",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const actionId = String(request.params.actionId || "");
    const { decision } = request.body as Partial<ApprovalDecisionRequest>;

    if (decision !== "approved" && decision !== "rejected") {
      throw new HttpError(400, "decision must be approved or rejected");
    }

    response.json({ session: await decideTaskSessionApproval(taskSessionId, actionId, decision) });
  })
);

app.patch(
  "/api/task-sessions/:taskSessionId/plan-items/:planItemId",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const planItemId = String(request.params.planItemId || "");
    const { title, note } = request.body as Partial<UpdateTaskPlanItemRequest>;

    const session = await updateTaskPlanItem(taskSessionId, planItemId, {
      title,
      status: parseTaskPlanStatus(request.body?.status),
      note
    });
    response.json({ session });
  })
);

app.delete(
  "/api/task-sessions/:taskSessionId/plan-items/:planItemId",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const planItemId = String(request.params.planItemId || "");
    const session = await deleteTaskPlanItem(taskSessionId, planItemId);
    response.json({ session });
  })
);

app.get(
  "/api/ai/file-chat/histories",
  asyncRoute(async (_request, response) => {
    response.json({ histories: await listFileChatHistories() });
  })
);

app.delete(
  "/api/ai/file-chat/histories",
  asyncRoute(async (request, response) => {
    const pathToDelete = typeof request.query.path === "string" && request.query.path.trim() ? request.query.path : "";

    if (!pathToDelete) {
      throw new HttpError(400, "path is required");
    }

    response.json({ histories: await deleteFileChatHistory(pathToDelete) });
  })
);

app.post(
  "/api/ai/file-chat",
  asyncRoute(async (request, response) => {
    const { userRequest } = request.body as Partial<FileChatRequest>;
    const chatKey = requireChatKey(request.body as Partial<FileChatRequest>);

    if (!userRequest?.trim()) {
      throw new HttpError(400, "userRequest is required");
    }

    const taskSession = await createTaskSession(userRequest.trim(), { chatId: chatKey });

    try {
      const contextPaths = getRequestedContextPaths(request.body as Partial<FileChatRequest>);
      const contextFiles = await readChatContextFiles(contextPaths);
      await addTaskSessionFilesRead(taskSession.id, contextFiles.map((file) => file.path));
      const history = await getFileChatMessages(chatKey);
      const classification = await classifyAgentRequest(history, userRequest.trim());
      await initializeTaskPlan(taskSession, classification, { contextFileCount: contextPaths.length });
      const taskStepWrites: Promise<unknown>[] = [];
      const answer = await generateFileChatReply(contextFiles, history, userRequest.trim(), chatKey, (step) => {
        taskStepWrites.push(appendTaskSessionStep(taskSession.id, step));
      });
      const messages = await appendFileChatTurn(chatKey, userRequest.trim(), answer);
      await Promise.all(taskStepWrites);
      await advanceTaskPlanProgress(taskSession.id, "validation_success");
      await updateTaskSessionStatus(taskSession.id, "success");

      response.json({ messages, taskSessionId: taskSession.id });
    } catch (error) {
      await advanceTaskPlanProgress(taskSession.id, "task_failed");
      await updateTaskSessionStatus(taskSession.id, "failed");
      throw error;
    }
  })
);

app.post("/api/ai/file-chat/stream", async (request, response) => {
  let completed = false;
  let clientClosed = false;
  let taskSessionId: string | null = null;
  let streamChatKey: string | null = null;
  let assistantMessageId: string | null = null;
  const controller = new AbortController();

  response.on("close", () => {
    if (completed) return;
    clientClosed = true;
    controller.abort();
    void (async () => {
      if (!(await shouldAutoCancelTaskSession(taskSessionId))) return;
      await advanceTaskPlanProgress(taskSessionId, "task_cancelled");
      await updateTaskSessionStatus(taskSessionId, "cancelled");
    })();
  });

  const sendEvent = (event: string, data: unknown) => {
    if (clientClosed || response.writableEnded) return;
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { path: selectedPath, userRequest, replayFromMessageId, approvedTaskSessionId } = request.body as Partial<FileChatRequest>;
    const chatKey = requireChatKey(request.body as Partial<FileChatRequest>);
    streamChatKey = chatKey;

    if (!userRequest?.trim()) {
      throw new HttpError(400, "userRequest is required");
    }

    const taskSession =
      approvedTaskSessionId
        ? await approveTaskSessionPlan(approvedTaskSessionId)
            .then((session) => session || getTaskSession(approvedTaskSessionId))
            .then((session) => updateTaskSessionChatId(session.id, chatKey).then((updated) => updated || session))
        : await createTaskSession(userRequest.trim(), { chatId: chatKey });
    taskSessionId = taskSession.id;
    const contextPaths = getRequestedContextPaths(request.body as Partial<FileChatRequest>);
    const contextFiles = await readChatContextFiles(contextPaths);
    await addTaskSessionFilesRead(taskSession.id, contextFiles.map((file) => file.path));
    const turn = await startFileChatTurn(chatKey, userRequest.trim(), replayFromMessageId);
    assistantMessageId = turn.assistantMessage.id;

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    sendEvent("user", { message: turn.userMessage });
    sendEvent("assistant_start", { message: turn.assistantMessage });
    sendEvent("chat", { chatId: chatKey, historyCount: turn.history.length, taskSessionId: taskSession.id });
    const taskStepWrites: Promise<unknown>[] = [];
    const agentSteps: AgentStep[] = [];
    const pushAgentStep = (step: AgentStep) => {
      agentSteps.push(step);
      taskStepWrites.push(appendTaskSessionStep(taskSession.id, step));
      sendEvent("agent_step", { step });
    };

    const classification = await classifyAgentRequest(turn.history, userRequest.trim());
    const plannedTaskSession = approvedTaskSessionId ? taskSession : await initializeTaskPlan(taskSession, classification, { contextFileCount: contextPaths.length, selectedPath });
    sendEvent("task_session", { session: plannedTaskSession || taskSession });
    pushAgentStep(
      createAgentStep({
        type: "message",
        content: `Intent recognized: ${classification.intent} (${Math.round(classification.confidence * 100)}%). ${classification.reason || ""}`.trim()
      })
    );

    if (!approvedTaskSessionId && plannedTaskSession?.planApproval?.status === "pending") {
      const answer = "已根据你的需求生成执行计划。请先审阅右侧任务计划，确认后点击“批准执行”，我再开始修改代码。";
      sendEvent("delta", { id: turn.assistantMessage.id, delta: answer });
      const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, answer);

      completed = true;
      await Promise.all(taskStepWrites);
      sendEvent("done", { messages });
      response.end();
      return;
    }

    if (shouldGeneratePatchForIntent(classification.intent)) {
      const editRequest = buildContextualEditRequest(turn.history, userRequest.trim(), classification.normalizedGoal);

      if (editRequest !== userRequest.trim()) {
        await updateTaskSessionUserGoal(taskSession.id, editRequest);
        pushAgentStep(
          createAgentStep({
            type: "message",
            content: "Resolved request into a contextual edit goal from intent routing and recent conversation history."
          })
        );
      }

      const patch = await createEditPatchResponse(selectedPath, editRequest, pushAgentStep, taskSession.id);
      const progressedTaskSession = await advanceTaskPlanProgress(taskSession.id, "patch_generated");
      const changedFiles = patch.files.map((file) => `- ${file.path}`).join("\n");
      const answer = [patch.summary, "", `已生成 ${patch.files.length} 个文件的修改，请在下方审核后应用：`, changedFiles].join("\n");
      sendEvent("delta", { id: turn.assistantMessage.id, delta: answer });
      const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, answer);

      completed = true;
      await Promise.all(taskStepWrites);
      if (progressedTaskSession) {
        sendEvent("task_session", { session: progressedTaskSession });
      }
      sendEvent("patch", { patch: { ...patch, taskSessionId: taskSession.id, agentSteps } });
      sendEvent("done", { messages });
      response.end();
      return;
    }

    const answer = await streamFileChatReply(
      contextFiles,
      turn.history,
      userRequest.trim(),
      (delta) => sendEvent("delta", { id: turn.assistantMessage.id, delta }),
      controller.signal,
      chatKey,
      pushAgentStep
    );
    const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, answer);

    completed = true;
    await Promise.all(taskStepWrites);
    const completedTaskSession = await advanceTaskPlanProgress(taskSession.id, "validation_success");
    await updateTaskSessionStatus(taskSession.id, clientClosed ? "cancelled" : "success");
    if (completedTaskSession) {
      sendEvent("task_session", { session: completedTaskSession });
    }
    sendEvent("done", { messages });
    response.end();
  } catch (error) {
    completed = true;
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error(message);
    await advanceTaskPlanProgress(taskSessionId, clientClosed ? "task_cancelled" : "task_failed");
    await updateTaskSessionStatus(taskSessionId, clientClosed ? "cancelled" : "failed");

    if (!response.headersSent) {
      response.status(error instanceof HttpError ? error.status : 500).json({ error: message });
      return;
    }

    // 使用字符串拼接回填错误，避免模板字符串在编码异常时丢失真实报错内容。
    const assistantError = "本次请求失败：" + message;
    const messages =
      streamChatKey && assistantMessageId
        ? await finishFileChatTurn(streamChatKey, assistantMessageId, assistantError).catch(() => null)
        : null;

    sendEvent("agent_step", { step: createAgentStep({ type: "error", message: assistantError }) });
    if (assistantMessageId) {
      sendEvent("delta", { id: assistantMessageId, delta: assistantError });
    }
    if (messages) {
      sendEvent("done", { messages });
    } else {
      sendEvent("error", { error: assistantError });
    }
    response.end();
  }
});

app.delete(
  "/api/ai/file-chat/messages/:messageId",
  asyncRoute(async (request, response) => {
    const messageId = String(request.params.messageId || "");
    response.json({ messages: await deleteFileChatMessage(getChatKey(undefined, request.query), messageId) });
  })
);

app.post(
  "/api/ai/file-chat/messages/:messageId/branch",
  asyncRoute(async (request, response) => {
    const messageId = String(request.params.messageId || "");
    response.json({ messages: await branchFileChatMessages(getChatKey(request.body as Partial<FileChatRequest>), messageId) });
  })
);

app.delete(
  "/api/ai/file-chat",
  asyncRoute(async (request, response) => {
    await clearFileChatMessages(getChatKey(undefined, request.query));
    response.json({ messages: [] });
  })
);

app.post(
  "/api/patch/apply",
  asyncRoute(async (request, response) => {
    const { patchId, filePath } = request.body as Partial<ApplyPatchRequest>;

    if (!patchId) {
      throw new HttpError(400, "patchId is required");
    }

    const patch = getPendingPatch(patchId);

    if (!patch) {
      throw new HttpError(404, "Patch not found");
    }

    const normalizedFilePath = filePath ? normalizePatchPath(filePath) : null;
    const targetFiles = normalizedFilePath
      ? patch.files.filter((file) => normalizePatchPath(file.path) === normalizedFilePath)
      : patch.files;

    if (!targetFiles.length) {
      throw new HttpError(404, "Patch file not found");
    }

    for (const file of targetFiles) {
      if (file.status === "create") {
        if (await workspacePathExists(file.path)) {
          throw new HttpError(409, `${file.path} already exists`);
        }
        continue;
      }

      const currentContent = await readWorkspaceFile(file.path);

      if (currentContent !== file.oldContent) {
        throw new HttpError(409, `${file.path} has changed since patch was generated. Regenerate the patch before applying.`);
      }
    }

    const checkpoint = await createCheckpoint(patch.patchId, targetFiles);

    await Promise.all([
      ...targetFiles.filter((file) => file.status === "modify").map((file) => writeWorkspaceFile(file.path, file.newContent)),
      ...targetFiles.filter((file) => file.status === "create").map((file) => createWorkspaceFile(file.path, file.newContent))
    ]);

    for (const file of targetFiles) {
      const writtenContent = await readWorkspaceFile(file.path);

      if (writtenContent !== file.newContent) {
        throw new HttpError(500, `${file.path} was not written correctly. Apply the patch again after refreshing the workspace.`);
      }
    }

    await addTaskSessionFilesChanged(patch.taskSessionId, targetFiles.map((file) => file.path));
    await addTaskSessionCheckpoint(patch.taskSessionId, checkpoint.id);
    await advanceTaskPlanProgress(patch.taskSessionId, "patch_applied");

    if (filePath) {
      const remainingPatch = removePendingPatchFile(patch.patchId, filePath);

      if (!remainingPatch && !patch.commandsToRun?.length) {
        await advanceTaskPlanProgress(patch.taskSessionId, "validation_success");
        await updateTaskSessionStatus(patch.taskSessionId, "success");
      }
    } else {
      deletePendingPatch(patch.patchId);

      if (!patch.commandsToRun?.length) {
        await advanceTaskPlanProgress(patch.taskSessionId, "validation_success");
        await updateTaskSessionStatus(patch.taskSessionId, "success");
      }
    }

    response.json({ success: true, checkpoint });
  })
);

app.get(
  "/api/checkpoints/:checkpointId",
  asyncRoute(async (request, response) => {
    response.json({ checkpoint: await getCheckpoint(String(request.params.checkpointId || "")) });
  })
);

app.post(
  "/api/checkpoints/rollback",
  asyncRoute(async (request, response) => {
    const { checkpointId } = request.body as Partial<RollbackCheckpointRequest>;

    if (!checkpointId) {
      throw new HttpError(400, "checkpointId is required");
    }

    await rollbackCheckpoint(checkpointId);
    response.json({ success: true });
  })
);

app.post(
  "/api/patch/reject",
  asyncRoute(async (request, response) => {
    const { patchId, filePath } = request.body as Partial<RejectPatchRequest>;

    if (!patchId) {
      throw new HttpError(400, "patchId is required");
    }

    if (filePath) {
      const patch = getPendingPatch(patchId);

      if (!patch) {
        throw new HttpError(404, "Patch not found");
      }

      const normalizedFilePath = normalizePatchPath(filePath);

      if (!patch.files.some((file) => normalizePatchPath(file.path) === normalizedFilePath)) {
        throw new HttpError(404, "Patch file not found");
      }

      const remainingPatch = removePendingPatchFile(patchId, filePath);

      if (!remainingPatch) {
        await advanceTaskPlanProgress(patch.taskSessionId, "task_cancelled");
        await updateTaskSessionStatus(patch.taskSessionId, "cancelled");
      }
    } else {
      const patch = getPendingPatch(patchId);
      deletePendingPatch(patchId);
      await advanceTaskPlanProgress(patch?.taskSessionId, "task_cancelled");
      await updateTaskSessionStatus(patch?.taskSessionId, "cancelled");
    }

    response.json({ success: true });
  })
);

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal server error";

  console.error(message);
  response.status(status).json({ error: message });
});

await initializeWorkspaceRoot();
await ensureGlobalRulesDirectory();
await ensureProjectRulesDirectory();
attachTerminalServer(server);

server.listen(config.serverPort, () => {
  console.log(`Mini AI Web Editor server running on http://localhost:${config.serverPort}`);
  console.log(`Workspace root: ${getWorkspaceRoot() || "(none)"}`);
});
