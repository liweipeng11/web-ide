import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { buildContextualEditRequest, classifyAgentRequest, ensureEditableAgentRequestClassification, generateFileChatReply, inferAgentRequestClassification, shouldGeneratePatchForIntent, streamFileChatReply, type AgentStep } from "./aiClient.js";
import { resumeAgentRuntimeAfterApproval, runAgentRuntime } from "./agentRuntime.js";
import { normalizeAgentMode } from "./agentModes.js";
import { appendFileChatMessage, appendFileChatTurn, branchFileChatMessages, clearFileChatMessages, deleteFileChatHistory, deleteFileChatMessage, ensureFileChatMessages, finishFileChatTurn, getFileChatMessages, listFileChatHistories, startFileChatTurn } from "./chatStore.js";
import { createCheckpoint, getCheckpoint, rollbackCheckpoint } from "./checkpointStore.js";
import { discoverProjectCommands } from "./commandDiscovery.js";
import { evaluateCommandPolicy } from "./commandPolicy.js";
import { getRecentCommandResults } from "./commandResults.js";
import { runProjectCommand } from "./commandRunner.js";
import { createMultiFileDiffHtml } from "./diffTools.js";
import { buildFinalPatchSummary, createEditPatchResponse } from "./editPatchService.js";
import { runAutoValidation } from "./autoValidationService.js";
import { finalizeTaskSession } from "./taskSessionFinalizer.js";
import { listFiles, readWorkspaceFile, writeWorkspaceFile } from "./fileTools.js";
import { createGitWorkflowRouter } from "./gitWorkflow/routes.js";
import { createVue2TemplateRouter } from "./vue2Template/routes.js";
import { createSearchRouter } from "./searchRoutes.js";
import { clearPendingPatches, deletePendingPatch, getPendingPatch, normalizePatchPath, removePendingPatchFile } from "./patchStore.js";
import { applyPendingPatch } from "./patchApplyService.js";
import { discoverProjectRules, ensureGlobalRulesDirectory, ensureProjectRulesDirectory, readAgentRulesSettings, writeAgentRulesSettings } from "./projectRules.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { ApplyPatchRequest, ApprovalDecisionRequest, AutoValidationRequest, FileChatMessage, FileChatRequest, GenerateEditRequest, GenerateEditResponse, InterruptTaskPlanRequest, RejectPatchRequest, RewriteTaskPlanRequest, RollbackCheckpointRequest, RunCommandRequest, SaveFileRequest, TaskPlanItemStatus, TaskSession, UpdateAgentModeRequest, UpdateTaskPlanItemRequest, UpsertTaskPlanItemRequest } from "./types.js";
import { addTaskPlanItem, addTaskSessionCommand, addTaskSessionFilesRead, advanceTaskPlanProgress, appendTaskSessionPatchEvent, appendTaskSessionStep, approveTaskSessionPlan, createTaskSession, decideTaskSessionApproval, deleteTaskPlanItem, deleteTaskSession, flushPendingTaskSessionWrites, getTaskSession, interruptTaskSessionForReplan, listTaskSessions, setTaskSessionRuntimePlanning, updateTaskPlanItem, updateTaskSessionAgentMode, updateTaskSessionChatId, updateTaskSessionUserGoal } from "./taskSessionStore.js";
import { initializeTaskPlan, rewriteTaskPlanWithInstruction } from "./taskPlanService.js";
import { buildTaskPlanContinuationRequest, decideTaskPlanContinuation, MAX_AUTOMATIC_PLAN_CONTINUATIONS } from "./taskPlanContinuation.js";
import { attachTerminalServer } from "./terminalServer.js";
import { pickWorkspaceFolder } from "./workspacePicker.js";
import { getWorkspaceRoot, initializeWorkspaceRoot, setWorkspaceRoot } from "./workspaceStore.js";
import { createProjectMemoryRouter } from "./projectMemory/index.js";
import { createCapabilityRouter } from "./capabilityRoutes.js";
import { createModelRouter } from "./modelRoutes.js";
import { resolveModelSelection } from "./modelSelectionStore.js";
import { configureProviderGateway, ProviderError } from "./providers/index.js";
import { withModelExecution } from "./modelExecutionContext.js";
import { isModelBudgetExceededError } from "./runtime/errors.js";
import { createLanguageServiceRouter, languageServiceGateway } from "./languageService/index.js";
import { createInlineEditRouter } from "./inlineEdit/routes.js";
import { initializeProviderSettings } from "./providerSettingsStore.js";
import { createCommandExecutionRouter } from "./commandExecution/commandExecutionRoutes.js";
import { commandExecutionService } from "./commandExecution/index.js";
import { MainAgentRuntime } from "./agents/main/mainAgentRuntime.js";
import { executeApprovedAgentPipeline, executeDirectMainRequest } from "./agentOrchestrationService.js";

const initialProviders = await initializeProviderSettings();
configureProviderGateway(initialProviders.filter((provider) => provider.enabled));
const app = express();
const server = createServer(app);
const workspaceChatKey = "__workspace_chat__";
const maxChatContextFiles = 8;
const maxChatContextCharsPerFile = 20_000;

async function classifyDirectEditRequest(userRequest: string) {
  return ensureEditableAgentRequestClassification(await classifyAgentRequest([], userRequest));
}

function runWithTaskModel<T>(taskSessionId: string, mode: "chat" | "plan" | "act", selection: import("./contracts/model.js").ModelSelection, callback: () => T) {
  return withModelExecution({ selection, taskSessionId, mode }, callback);
}

/** 预算耗尽是可恢复暂停，不应把既有计划与任务标记为失败。*/
function taskRuntimeStatusForError(error: unknown): "budget_exhausted" | "failed" {
  return isModelBudgetExceededError(error) ? "budget_exhausted" : "failed";
}

function getPlannerPauseMessage(session: TaskSession | null | undefined) {
  if (session?.plannerOutcome?.status === "missing_context") {
    return `Planner 需要补充上下文：${session.plannerOutcome.required?.join("；") || "请补充相关项目结构和约束"}`;
  }
  if (session?.plannerOutcome?.status === "failed") {
    return session.plannerOutcome.blockers?.[0] || "Planner 计划生成失败，请稍后重试。";
  }
  return null;
}

function selectInitialModelMode(userRequest: string, requestedMode: "plan" | "act"): "chat" | "plan" | "act" {
  if (requestedMode === "plan") return "plan";
  return shouldGeneratePatchForIntent(inferAgentRequestClassification(userRequest).intent) ? "act" : "chat";
}

app.use(express.json({ limit: "5mb" }));
app.use("/api", createCapabilityRouter({ flags: config.featureFlags }));
if (config.featureFlags.modelProviderGateway) app.use("/api", createModelRouter());
app.use("/api", createSearchRouter());
app.use("/api", createCommandExecutionRouter({
  v2Enabled: config.featureFlags.commandExecutionV2,
  onStarted: (taskSessionId, command) => addTaskSessionCommand(taskSessionId, command).then(() => undefined)
}));

// 生命周期日志只包含 execution ID 和状态，不记录命令输出或敏感输入。
commandExecutionService.subscribe((event) => {
  if (event.type === "output") return;
  const execution = event.execution;
  console.info(`[command-execution] id=${execution.id} event=${event.type} state=${execution.state}`);
});
app.use("/api/git-workflow", createGitWorkflowRouter());
app.use("/api/vue2-template", createVue2TemplateRouter());
app.use("/api/project-memory", createProjectMemoryRouter());
app.use("/api", createLanguageServiceRouter());
if (config.featureFlags.inlineEdit) app.use("/api", createInlineEditRouter());

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

async function resolveRequestModel(requestBody: Partial<FileChatRequest>, mode: "chat" | "plan" | "act") {
  if (!config.featureFlags.modelProviderGateway) {
    return { providerId: "openai-compatible", modelId: config.aiModel };
  }
  return resolveModelSelection(mode, requestBody.modelSelection);
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
  const labels: Record<TaskSession["status"], string> = {
    running: "进行中",
    awaiting_approval: "等待审批",
    awaiting_user: "等待用户",
    paused: "已暂停",
    success: "已完成",
    incomplete: "尚未完成",
    blocked: "已阻塞",
    failed: "执行失败",
    cancelled: "已取消",
    awaiting_replan: "等待重规划"
  };
  return labels[status];
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

function createRuntimeTaskProgressHandler(taskSessionId: string) {
  return async (phase: Parameters<typeof advanceTaskPlanProgress>[1]) => {
    // Runtime 必须等待计划写入完成，避免紧随其后的 completeTask 读取到旧状态。
    await advanceTaskPlanProgress(taskSessionId, phase);
  };
}

function getCommandTaskProgressPhase(status: unknown): Parameters<typeof advanceTaskPlanProgress>[1] | null {
  // 后台命令仍在运行时没有最终验证结论，不能提前完成 validate。
  if (status === "running") return null;
  if (status === "cancelled") return "task_cancelled";
  return status === "success" ? "validation_success" : "validation_failed";
}

async function advanceTaskPlanFromCommandResult(taskSessionId: string | null | undefined, status: unknown) {
  const phase = getCommandTaskProgressPhase(status);
  if (phase) await advanceTaskPlanProgress(taskSessionId, phase);
}

async function persistStreamTaskSessionOutcome(
  taskSessionId: string | null,
  progressEvent: Parameters<typeof advanceTaskPlanProgress>[1] | null,
  status: "budget_exhausted" | "failed" | "cancelled",
  failureSource: "provider_error" | "route_error" = "route_error"
) {
  if (!taskSessionId) return;

  // 错误收尾属于降级路径；即使状态文件仍被占用，也不能让持久化异常再次击穿流式路由。
  const results = await Promise.allSettled([
    progressEvent ? advanceTaskPlanProgress(taskSessionId, progressEvent) : Promise.resolve(),
    finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status },
      clientClosed: status === "cancelled",
      source: status === "cancelled" ? "client_disconnect" : failureSource
    })
  ]);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const operation = index === 0 ? "task plan progress" : "task session status";
      console.error("Failed to persist stream cleanup operation:", operation, result.reason);
    }
  });
}

function summarizeTaskSessionList(title: string, values: string[]) {
  if (!values.length) return "";

  return [title + "?", ...values.slice(0, 8).map((value) => "- " + value), values.length > 8 ? "- ?? " + (values.length - 8) + " ?" : ""].filter(Boolean).join("\n");
}

function createPatchStreamResponse(patchId: string | undefined, taskSessionId: string, summary: string, agentSteps: AgentStep[]): GenerateEditResponse | null {
  if (!patchId) return null;

  const patch = getPendingPatch(patchId);
  const selectedFileChange = patch?.files[0];

  if (!patch || !selectedFileChange) return null;
  const finalSummary = buildFinalPatchSummary({ files: patch.files, commandsToRun: patch.commandsToRun });

  // Runtime 中的 proposePatch 仍生成 pending patch，这里把它还原成前端现有 diff 面板能消费的响应结构。
  return {
    taskSessionId,
    patchId: patch.patchId,
    modelSummary: summary,
    finalSummary,
    rawPatchCount: patch.files.length,
    finalPatchCount: patch.files.length,
    diagnostics: patch.diagnostics,
    summary: finalSummary,
    files: patch.files,
    commandsToRun: patch.commandsToRun,
    oldContent: selectedFileChange.oldContent,
    newContent: selectedFileChange.newContent,
    diffHtml: createMultiFileDiffHtml(patch.files),
    agentSteps
  };
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

function buildRuntimeFollowupAnswer(runtimeResult: Awaited<ReturnType<typeof runAgentRuntime>>, runtimePatch: GenerateEditResponse | null) {
  if (runtimePatch) {
    const changedFiles = runtimePatch.files.map((file) => `- ${file.path}`).join("\n");

    // 聊天主回复优先使用最终 patch 摘要，避免 runtime 文本里的数量与实际 diff 不一致。
    return [runtimePatch.finalSummary, "", "请在下方审核后应用：", changedFiles].join("\n");
  }

  return runtimeResult.content || "审批已处理，任务继续执行完成。";
}

function buildDeferredRuntimeAnswer(runtimeResult: Awaited<ReturnType<typeof runAgentRuntime>>, runtimePatch: GenerateEditResponse | null) {
  // 补丁尚待审批时仍需写入简短的聊天摘要，避免用户只能从工具调用区域得知结果。
  // 实际改动依然必须经过审批，摘要不会改变任务或补丁的审批状态。
  if (runtimeResult.status === "awaiting_approval") {
    return runtimePatch ? buildRuntimeFollowupAnswer(runtimeResult, runtimePatch) : null;
  }

  return buildRuntimeFollowupAnswer(runtimeResult, runtimePatch);
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
    const previousWorkspaceRoot = getWorkspaceRoot();
    const nextWorkspaceRoot = await setWorkspaceRoot(workspaceRoot);
    if (previousWorkspaceRoot && previousWorkspaceRoot !== nextWorkspaceRoot) await languageServiceGateway.disposeWorkspace(previousWorkspaceRoot);
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

    const previousWorkspaceRoot = getWorkspaceRoot();
    const nextWorkspaceRoot = await setWorkspaceRoot(selectedPath);
    if (previousWorkspaceRoot && previousWorkspaceRoot !== nextWorkspaceRoot) await languageServiceGateway.disposeWorkspace(previousWorkspaceRoot);
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

app.get(
  "/api/agent-rules",
  asyncRoute(async (_request, response) => {
    response.json({ settings: await readAgentRulesSettings() });
  })
);

app.put(
  "/api/agent-rules",
  asyncRoute(async (request, response) => {
    response.json({ settings: await writeAgentRulesSettings(request.body || {}) });
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
    const stepStatus = result.status === "cancelled" ? "cancelled" : result.status === "running" ? "running" : result.status === "success" ? "success" : "failed";
    await appendTaskSessionStep(taskSessionId, createAgentStep({ type: "command", command: result.command, status: stepStatus, result }));
    await advanceTaskPlanFromCommandResult(taskSessionId, result.status);
    response.json({ result });
  })
);

app.post(
  "/api/ai/validate-and-fix",
  asyncRoute(async (request, response) => {
    const { command, selectedPath, taskSessionId, attempts, maxAttempts, changedFiles, failureCategories, changeContext, confirmed } = request.body as Partial<AutoValidationRequest>;

    response.json(
      await runAutoValidation({
        command: command?.trim() || null,
        selectedPath,
        taskSessionId,
        attempts,
        maxAttempts,
        changedFiles,
        failureCategories,
        changeContext,
        confirmed
      })
    );
  })
);

app.post(
  "/api/file",
  asyncRoute(async (request, response) => {
    const { path: filePath, content, baseContent } = request.body as Partial<SaveFileRequest>;

    if (!filePath || typeof content !== "string") {
      throw new HttpError(400, "path and content are required");
    }

    const currentContent = await readWorkspaceFile(filePath);

    // 保存前校验客户端基线，避免 Inline Edit 接受后覆盖磁盘上的并发修改。
    if (typeof baseContent === "string" && currentContent !== baseContent) {
      throw new HttpError(409, `${filePath} 已在磁盘上发生变化，请重新加载后再保存`);
    }

    if (currentContent === content) {
      response.json({ success: true, path: filePath, checkpoint: null });
      return;
    }

    const checkpoint = await createCheckpoint(`file-save:${filePath}`, [{ filePath, oldContent: currentContent, newContent: content, summary: "保存编辑器修改" }], {
      source: { toolName: "saveFile", reason: "editor_save" }
    });
    await writeWorkspaceFile(filePath, content);
    response.json({ success: true, path: filePath, checkpoint });
  })
);

app.post(
  "/api/ai/generate-edit",
  asyncRoute(async (request, response) => {
    const { path: filePath, userRequest } = request.body as Partial<GenerateEditRequest>;

    if (!userRequest) {
      throw new HttpError(400, "userRequest is required");
    }

    const modelSelection = await resolveRequestModel({}, "act");
    const taskSession = await createTaskSession(userRequest.trim(), { agentMode: "act", modelSelection });
    const classification = await runWithTaskModel(taskSession.id, "act", modelSelection, () => classifyDirectEditRequest(userRequest.trim()));
    const plannedTaskSession = await runWithTaskModel(taskSession.id, "act", modelSelection, () => initializeTaskPlan(taskSession, classification, { forceApproval: true, selectedPath: filePath, runtimePlanning: true }));
    const plannerPauseMessage = getPlannerPauseMessage(plannedTaskSession);
    if (plannerPauseMessage) {
      response.status(202).json({
        taskSessionId: taskSession.id,
        plannerBlocked: true,
        summary: plannerPauseMessage,
        agentSteps: []
      });
      return;
    }

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
      const patchResponse = await runWithTaskModel(taskSession.id, "act", modelSelection, () => createEditPatchResponse(filePath, userRequest, pushAgentStep, taskSession.id));
      await advanceTaskPlanProgress(taskSession.id, "patch_generated");
      await Promise.all(taskStepWrites);
      response.json({
        ...patchResponse,
        taskSessionId: plannedTaskSession?.id || taskSession.id,
        agentSteps
      });
    } catch (error) {
      await Promise.allSettled(taskStepWrites);
      const runtimeStatus = taskRuntimeStatusForError(error);
      if (runtimeStatus === "failed") await advanceTaskPlanProgress(taskSession.id, "task_failed");
      await finalizeTaskSession({ taskSessionId: taskSession.id, runtimeResult: { status: runtimeStatus, statusReason: error instanceof Error ? error.message : undefined }, source: "route_error" });
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
    void finalizeTaskSession({ taskSessionId, clientClosed: true, source: "client_disconnect" });
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

    const modelSelection = await resolveRequestModel({}, "act");
    const taskSession = await createTaskSession(userRequest.trim(), { agentMode: "act", modelSelection });
    taskSessionId = taskSession.id;
    const classification = await runWithTaskModel(taskSession.id, "act", modelSelection, () => classifyDirectEditRequest(userRequest.trim()));
    const plannedTaskSession = await runWithTaskModel(taskSession.id, "act", modelSelection, () => initializeTaskPlan(taskSession, classification, { forceApproval: true, selectedPath: filePath, runtimePlanning: true }));

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

    const plannerPauseMessage = getPlannerPauseMessage(plannedTaskSession);
    if (plannerPauseMessage) {
      completed = true;
      sendEvent("planner_blocked", { taskSessionId: taskSession.id, message: plannerPauseMessage });
      response.end();
      return;
    }

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

    const patchResponse = await runWithTaskModel(taskSession.id, "act", modelSelection, () => createEditPatchResponse(filePath, userRequest, (step) => {
      pushAgentStep(step);
    }, taskSession.id));
    const progressedTaskSession = await advanceTaskPlanProgress(taskSession.id, "patch_generated");

    pushAgentStep({
      id: `${streamRunId}:done`,
      createdAt: Date.now(),
      type: "message",
      content: patchResponse.finalSummary
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
        await finalizeTaskSession({ taskSessionId, clientClosed: true, source: "client_disconnect" });
      }
    } else {
      const runtimeStatus = taskRuntimeStatusForError(error);
      if (runtimeStatus === "failed") await advanceTaskPlanProgress(taskSessionId, "task_failed");
      await finalizeTaskSession({ taskSessionId, runtimeResult: { status: runtimeStatus, statusReason: error instanceof Error ? error.message : undefined }, source: error instanceof ProviderError ? "provider_error" : "route_error" });
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
        status: result?.status === "cancelled" ? "cancelled" : result?.status === "running" ? "running" : result?.status === "success" ? "success" : result ? "failed" : "cancelled",
        result: result || null
      })
    );
    await advanceTaskPlanFromCommandResult(taskSessionId, result?.status ?? "cancelled");
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
    const selection = await resolveModelSelection(session.agentMode === "plan" ? "plan" : "act", session.modelSelection);
    response.json({ session: await runWithTaskModel(session.id, session.agentMode === "plan" ? "plan" : "act", selection, () => rewriteTaskPlanWithInstruction(session, instruction.trim())) });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/plan/replan",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const { instruction } = request.body as Partial<InterruptTaskPlanRequest>;
    let session = await interruptTaskSessionForReplan(taskSessionId, instruction || "");
    if (session?.runtimePlan) {
      const selection = await resolveModelSelection(session.agentMode === "plan" ? "plan" : "act", session.modelSelection);
      const planning = await runWithTaskModel(session.id, session.agentMode === "plan" ? "plan" : "act", selection, () => new MainAgentRuntime().replan({
        oldPlan: session!.runtimePlan!,
        completedTasks: session!.runtimePlan!.tasks.filter((task) => task.status === "completed").map((task) => task.id),
        newFacts: [instruction?.trim() || "用户请求重新规划", ...session!.filesRead.map((filePath) => `已读取文件：${filePath}`)],
        readScope: [...new Set(session!.runtimePlan!.tasks.flatMap((task) => task.readScope))],
        writeScope: [...new Set(session!.runtimePlan!.tasks.flatMap((task) => task.writeScope))]
      }));
      session = (await setTaskSessionRuntimePlanning(session.id, planning)) || session;
    }
    response.json({ session });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/plan/approve",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const session = await getTaskSession(taskSessionId);
    const plannerPauseMessage = getPlannerPauseMessage(session);
    if (plannerPauseMessage) throw new HttpError(409, plannerPauseMessage);
    response.json({ session: await approveTaskSessionPlan(taskSessionId) });
  })
);

app.post(
  "/api/task-sessions/:taskSessionId/mode",
  asyncRoute(async (request, response) => {
    const taskSessionId = String(request.params.taskSessionId || "");
    const { mode } = request.body as Partial<UpdateAgentModeRequest>;

    response.json({ session: await updateTaskSessionAgentMode(taskSessionId, normalizeAgentMode(mode)) });
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

    const sessionBeforeDecision = await getTaskSession(taskSessionId);
    const pendingToolCall = sessionBeforeDecision.pendingToolCall?.actionId === actionId ? sessionBeforeDecision.pendingToolCall : null;
    const decidedSession = await decideTaskSessionApproval(taskSessionId, actionId, decision);

    if (!pendingToolCall) {
      response.json({ session: decidedSession });
      return;
    }

    const taskStepWrites: Promise<unknown>[] = [];
    const runtimeResult = await resumeAgentRuntimeAfterApproval({
      taskSessionId,
      userRequest: sessionBeforeDecision.userGoal,
      mode: sessionBeforeDecision.agentMode || "act",
      workflow: sessionBeforeDecision.workflow,
      providerId: sessionBeforeDecision.modelSelection?.providerId,
      modelId: sessionBeforeDecision.modelSelection?.modelId,
      persistedMessages: sessionBeforeDecision.agentMessages || [],
      runtimeEvidence: sessionBeforeDecision.runtimeEvidence,
      pendingToolCall,
      decision,
      onTaskProgress: createRuntimeTaskProgressHandler(taskSessionId),
      onAgentStep(step) {
        taskStepWrites.push(appendTaskSessionStep(taskSessionId, step));
      }
    });

    await Promise.all(taskStepWrites);
    const resumedSession = await getTaskSession(taskSessionId);
    const runtimePatch = createPatchStreamResponse(runtimeResult.generatedPatchIds.at(-1), taskSessionId, runtimeResult.content || "已生成待审核补丁。", resumedSession?.steps || []);
    let runtimeStatus;
    if (runtimePatch) {
      await advanceTaskPlanProgress(taskSessionId, "patch_generated");
      runtimeStatus = await finalizeTaskSession({
        taskSessionId,
        runtimeResult: { ...runtimeResult, status: "awaiting_approval" },
        source: "agent_runtime"
      });
    } else {
      runtimeStatus = await finalizeTaskSession({
        taskSessionId,
        runtimeResult,
        source: "agent_runtime"
      });
    }
    const chatId = sessionBeforeDecision.chatId?.trim() || `chat:${taskSessionId}`;
    const runtimeAnswer = buildDeferredRuntimeAnswer(runtimeResult, runtimePatch);
    const messages = runtimeAnswer
      ? await appendFileChatMessage(chatId, {
          role: "assistant",
          // 审批恢复后只有在工具链真正完成时，才补充最终说明。
          content: runtimeAnswer
        })
      : undefined;
    const finalSession = runtimeStatus || (await getTaskSession(taskSessionId));

    response.json({
      session: finalSession,
      messages,
      patch: runtimePatch,
      runtime: {
        status: runtimeResult.status,
        content: runtimeResult.content,
        pendingToolCall: runtimeResult.pendingToolCall || null
      }
    });
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

    const requestedAgentMode = normalizeAgentMode((request.body as Partial<FileChatRequest>).agentMode);
    const initialModelMode = selectInitialModelMode(userRequest.trim(), requestedAgentMode);
    const modelSelection = await resolveRequestModel(request.body as Partial<FileChatRequest>, initialModelMode);
    const taskSession = await createTaskSession(userRequest.trim(), { chatId: chatKey, agentMode: requestedAgentMode, modelSelection });

    try {
      const contextPaths = getRequestedContextPaths(request.body as Partial<FileChatRequest>);
      const contextFiles = await readChatContextFiles(contextPaths);
      await addTaskSessionFilesRead(taskSession.id, contextFiles.map((file) => file.path));
      const history = await getFileChatMessages(chatKey);
      const classification = await runWithTaskModel(taskSession.id, initialModelMode, modelSelection, () => classifyAgentRequest(history, userRequest.trim()));
      const plannedTaskSession = await runWithTaskModel(taskSession.id, initialModelMode, modelSelection, () => initializeTaskPlan(taskSession, classification, { contextFileCount: contextPaths.length, runtimePlanning: true }));
      const plannerPauseMessage = getPlannerPauseMessage(plannedTaskSession);
      if (plannerPauseMessage) {
        const messages = await appendFileChatTurn(chatKey, userRequest.trim(), plannerPauseMessage);
        response.status(202).json({ messages, taskSessionId: taskSession.id, plannerBlocked: true });
        return;
      }

      if (plannedTaskSession?.planApproval?.status === "pending") {
        const answer = "已根据你的需求生成执行计划，请批准后再开始修改代码。";
        const messages = await appendFileChatTurn(chatKey, userRequest.trim(), answer);
        response.status(202).json({ messages, taskSessionId: taskSession.id, planPending: true });
        return;
      }
      const directMain = await runWithTaskModel(taskSession.id, initialModelMode, modelSelection, () =>
        executeDirectMainRequest(plannedTaskSession || taskSession, {
          goal: userRequest.trim(),
          knownFacts: contextFiles.map((file) => `文件 ${file.path}：\n${file.content}`)
        })
      );
      if (directMain.outcome === "executed") {
        const messages = await appendFileChatTurn(chatKey, userRequest.trim(), directMain.summary);
        const directStatus = directMain.execution.outcome === "executed"
          ? directMain.execution.execution.result.status
          : "blocked";
        await finalizeTaskSession({
          taskSessionId: taskSession.id,
          runtimeResult: {
            status: directStatus === "success" ? "completed" : directStatus === "failed" ? "failed" : "blocked",
            statusReason: directStatus === "success" ? undefined : directMain.summary
          },
          source: "agent_runtime"
        });
        response.json({ messages, taskSessionId: taskSession.id });
        return;
      }
      const taskStepWrites: Promise<unknown>[] = [];
      const answer = await runWithTaskModel(taskSession.id, initialModelMode, modelSelection, () => generateFileChatReply(contextFiles, history, userRequest.trim(), chatKey, (step) => {
        taskStepWrites.push(appendTaskSessionStep(taskSession.id, step));
      }, modelSelection.modelId));
      const messages = await appendFileChatTurn(chatKey, userRequest.trim(), answer);
      await Promise.all(taskStepWrites);
      await advanceTaskPlanProgress(taskSession.id, "validation_success");
      await finalizeTaskSession({ taskSessionId: taskSession.id, runtimeResult: { status: "completed" }, source: "legacy_chat" });

      response.json({ messages, taskSessionId: taskSession.id });
    } catch (error) {
      const runtimeStatus = taskRuntimeStatusForError(error);
      if (runtimeStatus === "failed") await advanceTaskPlanProgress(taskSession.id, "task_failed");
      await finalizeTaskSession({ taskSessionId: taskSession.id, runtimeResult: { status: runtimeStatus, statusReason: error instanceof Error ? error.message : undefined }, source: error instanceof ProviderError ? "provider_error" : "route_error" });
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
      await persistStreamTaskSessionOutcome(taskSessionId, "task_cancelled", "cancelled");
    })();
  });

  const sendEvent = (event: string, data: unknown) => {
    if (clientClosed || response.writableEnded) return;
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { path: selectedPath, userRequest, replayFromMessageId, approvedTaskSessionId } = request.body as Partial<FileChatRequest>;
    const requestedAgentMode = normalizeAgentMode((request.body as Partial<FileChatRequest>).agentMode);
    const chatKey = requireChatKey(request.body as Partial<FileChatRequest>);
    streamChatKey = chatKey;

    if (!userRequest?.trim()) {
      throw new HttpError(400, "userRequest is required");
    }

    const initialModelMode = selectInitialModelMode(userRequest.trim(), requestedAgentMode);
    const requestedModelSelection = approvedTaskSessionId ? null : await resolveRequestModel(request.body as Partial<FileChatRequest>, initialModelMode);
    const taskSession =
      approvedTaskSessionId
        ? await approveTaskSessionPlan(approvedTaskSessionId)
            .then((session) => session || getTaskSession(approvedTaskSessionId))
            .then((session) => updateTaskSessionChatId(session.id, chatKey).then((updated) => updated || session))
        : await createTaskSession(userRequest.trim(), { chatId: chatKey, agentMode: requestedAgentMode, modelSelection: requestedModelSelection || undefined });
    const modelSelection = await resolveModelSelection(
      taskSession.modelSelection ? (taskSession.agentMode === "plan" ? "plan" : initialModelMode) : initialModelMode,
      taskSession.modelSelection || requestedModelSelection
    );
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

    const executionMode = taskSession.agentMode === "plan" ? "plan" : "act";
    const classification = await runWithTaskModel(taskSession.id, executionMode, modelSelection, () => classifyAgentRequest(turn.history, userRequest.trim()));
    const plannedTaskSession = approvedTaskSessionId
      ? taskSession
      : await runWithTaskModel(taskSession.id, executionMode, modelSelection, () => initializeTaskPlan(taskSession, classification, {
          contextFileCount: contextPaths.length,
          selectedPath,
          forceApproval: requestedAgentMode === "plan" ? false : undefined,
          runtimePlanning: true
        }));
    sendEvent("task_session", { session: plannedTaskSession || taskSession });
    const plannerPauseMessage = getPlannerPauseMessage(plannedTaskSession);
    if (plannerPauseMessage) {
      sendEvent("delta", { id: turn.assistantMessage.id, delta: plannerPauseMessage });
      const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, plannerPauseMessage);
      completed = true;
      await Promise.all(taskStepWrites);
      sendEvent("planner_blocked", { taskSessionId: taskSession.id, message: plannerPauseMessage });
      sendEvent("done", { messages });
      response.end();
      return;
    }
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

    const activeAgentMode = plannedTaskSession?.agentMode || taskSession.agentMode || requestedAgentMode;

    if (activeAgentMode === "plan") {
      pushAgentStep(
        createAgentStep({
          type: "message",
          content: "Plan Mode: using read-only tools to inspect context and produce an execution plan."
        })
      );

      const runtimeResult = await runAgentRuntime({
        taskSessionId: taskSession.id,
        userRequest: userRequest.trim(),
        mode: "plan",
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        signal: controller.signal,
        workflow: plannedTaskSession?.workflow || taskSession.workflow,
        runtimeEvidence: taskSession.runtimeEvidence,
        onTaskProgress: createRuntimeTaskProgressHandler(taskSession.id),
        onAgentStep: pushAgentStep,
        onContextBudget: ({ snapshot, summary }) => sendEvent("context_budget", { taskSessionId: taskSession.id, snapshot, summary })
      });
      const answer = buildDeferredRuntimeAnswer(runtimeResult, null) || "";
      if (answer) {
        sendEvent("delta", { id: turn.assistantMessage.id, delta: answer });
      }
      const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, answer);
      const workflowType = plannedTaskSession?.workflow?.type || taskSession.workflow?.type;

      if (runtimeResult.status === "completed" && workflowType === "analysis-only") {
        await advanceTaskPlanProgress(taskSession.id, "validation_success");
      }
      const completedTaskSession = await finalizeTaskSession({
        taskSessionId: taskSession.id,
        runtimeResult,
        source: "plan_runtime",
        mode: "plan",
        workflowType
      });

      completed = true;
      await Promise.all(taskStepWrites);
      if (completedTaskSession) {
        sendEvent("task_session", { session: completedTaskSession });
      }
      sendEvent("done", { messages });
      response.end();
      return;
    }

    if (approvedTaskSessionId && plannedTaskSession?.runtimePlan) {
      const pipelineResult = await runWithTaskModel(
        taskSession.id,
        "act",
        modelSelection,
        () => executeApprovedAgentPipeline(plannedTaskSession, {
          signal: controller.signal,
          // 新编排与旧 Runtime 共用 AgentStep：既实时推送，也持久化为可恢复的会话证据。
          onLifecycleEvent(event) {
            pushAgentStep(createAgentStep({ type: "orchestration", ...event }));
          },
          // Graph 步骤已在服务层按稳定 ID 落盘，此处只桥接到当前 SSE 连接。
          onGraphStep(step) {
            agentSteps.push(step);
            sendEvent("agent_step", { step });
          }
        })
      );
      if (pipelineResult.outcome === "executed") {
        const { orchestration } = pipelineResult;
        for (const item of orchestration.executions) {
          if (item.agent !== "developer") continue;
          for (const checkpointId of item.execution.checkpointIds) {
            pushAgentStep(createAgentStep({
              type: "checkpoint",
              checkpointId,
              files: item.execution.result.changedFiles,
              source: {
                taskSessionId: taskSession.id,
                toolName: "apply_patch",
                reason: "developer_runtime_apply_patch"
              }
            }));
          }
        }
        const developerExecution = orchestration.executions.find((item) => item.agent === "developer");
        const testerExecution = orchestration.executions.find((item) => item.agent === "tester");
        if (developerExecution?.execution.result.status === "success") {
          await advanceTaskPlanProgress(taskSession.id, "patch_applied");
        } else if (developerExecution?.execution.result.status === "failed") {
          await advanceTaskPlanProgress(taskSession.id, "task_failed");
        }
        if (testerExecution?.execution.result.status === "success") {
          await advanceTaskPlanProgress(taskSession.id, "validation_success");
        } else if (testerExecution?.execution.result.status === "failed") {
          await advanceTaskPlanProgress(taskSession.id, "validation_failed");
        }
        const answer = orchestration.summary;
        sendEvent("delta", { id: turn.assistantMessage.id, delta: answer });
        const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, answer);
        const completedTaskSession = await finalizeTaskSession({
          taskSessionId: taskSession.id,
          runtimeResult: {
            status: orchestration.status,
            statusReason: orchestration.status === "completed" ? undefined : orchestration.summary
          },
          source: "agent_runtime"
        });

        completed = true;
        await Promise.all(taskStepWrites);
        if (completedTaskSession) sendEvent("task_session", { session: completedTaskSession });
        sendEvent("orchestration_result", {
          taskSessionId: taskSession.id,
          status: orchestration.status,
          trace: orchestration.trace,
          results: orchestration.results
        });
        sendEvent("done", { messages });
        response.end();
        return;
      }
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

      const runTaskRuntime = (goal: string, runtimeEvidence: TaskSession["runtimeEvidence"], agentContext?: Awaited<ReturnType<typeof runAgentRuntime>>["agentContext"]) =>
        runAgentRuntime({
          taskSessionId: taskSession.id,
          userRequest: goal,
          mode: "act",
          providerId: modelSelection.providerId,
          modelId: modelSelection.modelId,
          signal: controller.signal,
          workflow: plannedTaskSession?.workflow || taskSession.workflow,
          runtimeEvidence,
          agentContext,
          // Plan → Act 必须复用同一任务的调研结论和对话轨迹，行为与 Cline 的模式切换一致。
          resumeFromPlan: Boolean(approvedTaskSessionId) && !agentContext,
          onTaskProgress: createRuntimeTaskProgressHandler(taskSession.id),
          onAgentStep: pushAgentStep,
          onContextBudget: ({ snapshot, summary }) => sendEvent("context_budget", { taskSessionId: taskSession.id, snapshot, summary })
        });

      let runtimeResult = await runTaskRuntime(editRequest, taskSession.runtimeEvidence);
      for (let continuationCount = 0; continuationCount < MAX_AUTOMATIC_PLAN_CONTINUATIONS; continuationCount += 1) {
        const sessionAfterRun = await getTaskSession(taskSession.id);
        const continuation = decideTaskPlanContinuation({
          runtimeStatus: runtimeResult.status,
          continuationCount,
          hasPendingToolCall: Boolean(runtimeResult.pendingToolCall),
          generatedPatchCount: runtimeResult.generatedPatchIds.length,
          planItems: sessionAfterRun.planItems
        });
        if (!continuation.shouldContinue || !continuation.planItem) break;

        // incomplete 仅代表本轮未交付；计划已推进时继续执行新的当前步骤。
        pushAgentStep(createAgentStep({
          type: "strategy",
          event: "no_progress_recovery",
          message: `上一轮未形成可交付结果，正在继续执行计划步骤：${continuation.planItem.title}（${continuationCount + 1}/${MAX_AUTOMATIC_PLAN_CONTINUATIONS}）`
        }));
        runtimeResult = await runTaskRuntime(
          buildTaskPlanContinuationRequest(editRequest, continuation.planItem),
          runtimeResult.runtimeEvidence,
          runtimeResult.agentContext
        );
      }
      const runtimePatch = createPatchStreamResponse(runtimeResult.generatedPatchIds.at(-1), taskSession.id, runtimeResult.content || "已生成待审核补丁。", agentSteps);
      let runtimeProgressedTaskSession;
      if (runtimePatch) {
        await advanceTaskPlanProgress(taskSession.id, "patch_generated");
        runtimeProgressedTaskSession = await finalizeTaskSession({
          taskSessionId: taskSession.id,
          runtimeResult: { ...runtimeResult, status: "awaiting_approval" },
          source: "agent_runtime"
        });
      } else {
        runtimeProgressedTaskSession = await finalizeTaskSession({
          taskSessionId: taskSession.id,
          runtimeResult,
          source: "agent_runtime"
        });
      }
      const runtimeAnswer = buildDeferredRuntimeAnswer(runtimeResult, runtimePatch) || "";
      if (runtimeAnswer) {
        sendEvent("delta", { id: turn.assistantMessage.id, delta: runtimeAnswer });
      }
      const runtimeMessages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, runtimeAnswer);

      completed = true;
      await Promise.all(taskStepWrites);
      if (runtimeProgressedTaskSession) {
        sendEvent("task_session", { session: runtimeProgressedTaskSession });
      }
      if (runtimePatch) {
        sendEvent("patch", { patch: runtimePatch });
      }
      sendEvent("done", { messages: runtimeMessages });
      response.end();
      return;

    }

    const directMain = await runWithTaskModel(taskSession.id, "chat", modelSelection, () =>
      executeDirectMainRequest(plannedTaskSession || taskSession, {
        goal: userRequest.trim(),
        knownFacts: contextFiles.map((file) => `文件 ${file.path}：\n${file.content}`),
        signal: controller.signal
      })
    );
    if (directMain.outcome === "executed") {
      sendEvent("delta", { id: turn.assistantMessage.id, delta: directMain.summary });
      const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, directMain.summary);
      const directStatus = directMain.execution.outcome === "executed"
        ? directMain.execution.execution.result.status
        : "blocked";
      const completedTaskSession = await finalizeTaskSession({
        taskSessionId: taskSession.id,
        runtimeResult: {
          status: directStatus === "success" ? "completed" : directStatus === "failed" ? "failed" : "blocked",
          statusReason: directStatus === "success" ? undefined : directMain.summary
        },
        source: "agent_runtime"
      });

      completed = true;
      await Promise.all(taskStepWrites);
      if (completedTaskSession) sendEvent("task_session", { session: completedTaskSession });
      const trace = completedTaskSession?.orchestrationTrace;
      if (trace) {
        sendEvent("orchestration_result", {
          taskSessionId: taskSession.id,
          status: directStatus === "success" ? "completed" : directStatus === "failed" ? "failed" : "blocked",
          trace,
          results: directMain.execution.outcome === "executed" ? [directMain.execution.execution.result] : []
        });
      }
      sendEvent("done", { messages });
      response.end();
      return;
    }

    const answer = await runWithTaskModel(taskSession.id, "chat", modelSelection, () => streamFileChatReply(
      contextFiles,
      turn.history,
      userRequest.trim(),
      (delta) => sendEvent("delta", { id: turn.assistantMessage.id, delta }),
      controller.signal,
      chatKey,
      pushAgentStep,
      modelSelection.modelId
    ));
    const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, answer);

    completed = true;
    await Promise.all(taskStepWrites);
    await advanceTaskPlanProgress(taskSession.id, "validation_success");
    const completedTaskSession = await finalizeTaskSession({
      taskSessionId: taskSession.id,
      runtimeResult: { status: "completed" },
      clientClosed,
      source: "legacy_chat"
    });
    if (completedTaskSession) {
      sendEvent("task_session", { session: completedTaskSession });
    }
    sendEvent("done", { messages });
    response.end();
  } catch (error) {
    completed = true;
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error(message);
    const runtimeStatus = clientClosed ? "cancelled" : taskRuntimeStatusForError(error);
    await persistStreamTaskSessionOutcome(
      taskSessionId,
      clientClosed ? "task_cancelled" : runtimeStatus === "failed" ? "task_failed" : null,
      runtimeStatus,
      error instanceof ProviderError ? "provider_error" : "route_error"
    );

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
    const { patchId, filePath, acknowledgeSafeEditRisk } = request.body as Partial<ApplyPatchRequest>;

    if (!patchId) {
      throw new HttpError(400, "patchId is required");
    }

    const result = await applyPendingPatch({ patchId, filePath, acknowledgeSafeEditRisk });
    response.json({ success: true, checkpoint: result.checkpoint });
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

      const rejectedFile = patch.files.find((file) => normalizePatchPath(file.path) === normalizedFilePath);
      const remainingPatch = removePendingPatchFile(patchId, filePath);
      await appendTaskSessionPatchEvent(patch.taskSessionId, {
        type: "patch_file_rejected",
        patchId,
        filePath: rejectedFile?.path || filePath,
        filePaths: [rejectedFile?.path || filePath],
        message: `已拒绝 ${rejectedFile?.path || filePath}`,
        detail: {
          status: rejectedFile?.status,
          summary: rejectedFile?.summary
        }
      });

      if (!remainingPatch) {
        await appendTaskSessionPatchEvent(patch.taskSessionId, {
          type: "patch_completed",
          patchId,
          filePaths: [rejectedFile?.path || filePath],
          message: "patch 已处理完成。",
          detail: {
            completedBy: "reject"
          }
        });
        await advanceTaskPlanProgress(patch.taskSessionId, "task_cancelled");
        await finalizeTaskSession({ taskSessionId: patch.taskSessionId, runtimeResult: { status: "cancelled" }, source: "patch_rejection" });
      }
    } else {
      const patch = getPendingPatch(patchId);
      deletePendingPatch(patchId);
      if (patch) {
        await Promise.all(
          patch.files.map((file) =>
            appendTaskSessionPatchEvent(patch.taskSessionId, {
              type: "patch_file_rejected",
              patchId,
              filePath: file.path,
              filePaths: [file.path],
              message: `已拒绝 ${file.path}`,
              detail: {
                status: file.status,
                summary: file.summary
              }
            })
          )
        );
        await appendTaskSessionPatchEvent(patch.taskSessionId, {
          type: "patch_completed",
          patchId,
          filePaths: patch.files.map((file) => file.path),
          message: "patch 已处理完成。",
          detail: {
            completedBy: "reject"
          }
        });
      }
      await advanceTaskPlanProgress(patch?.taskSessionId, "task_cancelled");
      await finalizeTaskSession({ taskSessionId: patch?.taskSessionId, runtimeResult: { status: "cancelled" }, source: "patch_rejection" });
    }

    response.json({ success: true });
  })
);

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const providerStatus = error instanceof ProviderError
    ? error.status || (error.code === "authentication" ? 401 : error.code === "rate_limit" ? 429 : error.code === "unavailable" || error.code === "timeout" ? 503 : error.code === "cancelled" ? 499 : 400)
    : undefined;
  const status = error instanceof HttpError ? error.status : providerStatus || 500;
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // 先停止可能继续产生状态更新的后台服务，再冲刷 20ms 合并窗口，避免关闭竞态丢失最后一批更新。
    void Promise.allSettled([languageServiceGateway.disposeAll(), commandExecutionService.shutdown()])
      .then(() => flushPendingTaskSessionWrites())
      .finally(() => server.close(() => process.exit(0)));
  });
}
