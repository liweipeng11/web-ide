import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { generateAiEdit, generateFileChatReply, streamFileChatReply, type AgentStep, type EditPathRetryContext } from "./aiClient.js";
import { appendFileChatTurn, branchFileChatMessages, clearFileChatMessages, deleteFileChatHistory, deleteFileChatMessage, finishFileChatTurn, getFileChatMessages, listFileChatHistories, startFileChatTurn } from "./chatStore.js";
import { searchWorkspaceCode } from "./codeSearch.js";
import { discoverProjectCommands } from "./commandDiscovery.js";
import { getRecentCommandResults } from "./commandResults.js";
import { runProjectCommand } from "./commandRunner.js";
import { createDiffHtml, createMultiFileDiffHtml } from "./diffTools.js";
import { createWorkspaceFile, listFiles, readWorkspaceFile, safeResolve, workspacePathExists, writeWorkspaceFile } from "./fileTools.js";
import { createPendingPatch, deletePendingPatch, getPendingPatch, clearPendingPatches } from "./patchStore.js";
import type { AiEditResult, ApplyPatchRequest, FileChatRequest, FileTreeNode, GenerateEditRequest, RejectPatchRequest, RunCommandRequest, SaveFileRequest } from "./types.js";
import { attachTerminalServer } from "./terminalServer.js";
import { pickWorkspaceFolder } from "./workspacePicker.js";
import { getWorkspaceRoot, initializeWorkspaceRoot, setWorkspaceRoot } from "./workspaceStore.js";

const app = express();
const server = createServer(app);
const workspaceChatKey = "__workspace_chat__";
const maxChatContextFiles = 8;
const maxChatContextCharsPerFile = 20_000;
const routeLogPreviewChars = 500;

app.use(express.json({ limit: "5mb" }));

function createRouteRunId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function previewRouteLog(value: unknown, maxLength = routeLogPreviewChars) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength} chars>` : text;
}

function logRoute(runId: string, event: string, detail?: unknown) {
  const suffix = detail === undefined ? "" : ` ${previewRouteLog(detail)}`;
  console.log(`[route:${runId}] ${event}${suffix}`);
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

async function readChatContextFiles(paths: string[]) {
  return Promise.all(
    paths.map(async (filePath) => ({
      path: filePath,
      content: (await readWorkspaceFile(filePath)).slice(0, maxChatContextCharsPerFile)
    }))
  );
}

function flattenFilePaths(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node.path] : flattenFilePaths(node.children || [])));
}

function normalizeWorkspacePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function normalizeCandidateEditPath(rawPath: string) {
  const workspaceRoot = getWorkspaceRoot();
  const trimmedPath = rawPath.trim();

  if (workspaceRoot && path.isAbsolute(trimmedPath)) {
    const relative = path.relative(workspaceRoot, trimmedPath);

    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return normalizeWorkspacePath(relative);
    }
  }

  return normalizeWorkspacePath(trimmedPath);
}

function resolveExistingEditPath(rawPath: string, existingPaths: string[]) {
  const workspaceRoot = getWorkspaceRoot();
  const normalizedExistingPaths = new Map(existingPaths.map((filePath) => [filePath.toLowerCase(), filePath]));
  const candidates: string[] = [];
  const trimmedPath = rawPath.trim();

  if (trimmedPath) {
    candidates.push(trimmedPath);
  }

  if (workspaceRoot && path.isAbsolute(trimmedPath)) {
    const relative = path.relative(workspaceRoot, trimmedPath);

    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      candidates.push(relative);
    }
  }

  candidates.push(normalizeWorkspacePath(trimmedPath));

  for (const candidate of candidates) {
    const normalized = normalizeWorkspacePath(candidate);
    const exact = normalizedExistingPaths.get(normalized.toLowerCase());

    if (exact) {
      return exact;
    }
  }

  const suffix = normalizeWorkspacePath(trimmedPath).toLowerCase();
  const suffixMatches = suffix ? existingPaths.filter((filePath) => filePath.toLowerCase().endsWith(`/${suffix}`) || filePath.toLowerCase() === suffix) : [];

  return suffixMatches.length === 1 ? suffixMatches[0] : null;
}

function getPathRetryCandidates(invalidPaths: string[], existingPaths: string[], selectedFilePath: string | null) {
  const candidateSet = new Set<string>();

  if (selectedFilePath) {
    candidateSet.add(selectedFilePath);
  }

  for (const invalidPath of invalidPaths) {
    const baseName = path.basename(invalidPath.replace(/\\/g, "/")).toLowerCase();

    for (const existingPath of existingPaths) {
      if (existingPath.toLowerCase().endsWith(`/${baseName}`) || existingPath.toLowerCase() === baseName) {
        candidateSet.add(existingPath);
      }
    }
  }

  for (const existingPath of existingPaths) {
    if (candidateSet.size >= 80) break;
    candidateSet.add(existingPath);
  }

  return [...candidateSet];
}

async function validateEditResultPaths(aiResult: AiEditResult, selectedFilePath: string | null) {
  if (aiResult.files === null) {
    return { files: null, invalidFilePaths: [], validFilePaths: [] };
  }

  const existingPaths = flattenFilePaths(await listFiles(""));
  const existingPathSet = new Set(existingPaths.map((filePath) => filePath.toLowerCase()));
  const invalidFilePaths: string[] = [];
  const files = aiResult.files
    .map((change) => {
      const existingPath = resolveExistingEditPath(change.path, existingPaths);

      if (existingPath) {
        return {
          ...change,
          path: existingPath,
          status: "modify" as const
        };
      }

      const createPath = normalizeCandidateEditPath(change.path);

      try {
        safeResolve(createPath);
      } catch {
        invalidFilePaths.push(change.path);
        return null;
      }

      if (!createPath || existingPathSet.has(createPath.toLowerCase())) {
        invalidFilePaths.push(change.path);
        return null;
      }

      return {
        ...change,
        path: createPath,
        status: "create" as const
      };
    })
    .filter((change): change is NonNullable<typeof change> => Boolean(change));

  return {
    files,
    invalidFilePaths,
    validFilePaths: invalidFilePaths.length ? getPathRetryCandidates(invalidFilePaths, existingPaths, selectedFilePath) : []
  };
}

async function createEditPatchResponse(filePath: string | null | undefined, userRequest: string, onAgentStep?: (step: AgentStep) => void) {
  const runId = createRouteRunId("edit");
  const startedAt = Date.now();
  const selectedFilePath = typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
  logRoute(runId, "start", { selectedFilePath, userRequest });
  const oldContent = selectedFilePath ? await readWorkspaceFile(selectedFilePath) : "";
  let retryContext: EditPathRetryContext | undefined;
  let aiResult: AiEditResult | null = null;
  let validatedPaths: Awaited<ReturnType<typeof validateEditResultPaths>> | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    logRoute(runId, "ai.generate.start", { attempt, retryContext });
    aiResult = await generateAiEdit(selectedFilePath, oldContent, userRequest, onAgentStep, retryContext);
    logRoute(runId, "ai.generate.done", { attempt, summary: aiResult.summary, files: aiResult.files?.map((file) => file.path) || null });
    validatedPaths = await validateEditResultPaths(aiResult, selectedFilePath);
    logRoute(runId, "paths.validated", { attempt, validFiles: validatedPaths.files?.map((file) => file.path) || null, invalidFilePaths: validatedPaths.invalidFilePaths });

    if (aiResult.files === null || !validatedPaths.invalidFilePaths.length) {
      break;
    }

    retryContext = {
      invalidFilePaths: validatedPaths.invalidFilePaths,
      validFilePaths: validatedPaths.validFilePaths
    };

    console.warn("AI returned non-existent edit paths, retrying with valid paths:", retryContext);
    logRoute(runId, "paths.retry", retryContext);
  }

  if (!aiResult || !validatedPaths) {
    throw new HttpError(502, "AI did not return an edit response");
  }

  if (aiResult.files === null) {
    throw new HttpError(422, aiResult.summary);
  }

  if (validatedPaths.invalidFilePaths.length) {
    throw new HttpError(422, `AI returned file paths that do not exist: ${validatedPaths.invalidFilePaths.join(", ")}`);
  }

  const uniqueChanges = [...new Map((validatedPaths.files || []).map((change) => [change.path, change])).values()];
  logRoute(runId, "patch.prepare", { files: uniqueChanges.map((change) => change.path) });
  const files = (
    await Promise.all(
      uniqueChanges.map(async (change) => {
        const previousContent = change.status === "create" ? "" : selectedFilePath && change.path === selectedFilePath ? oldContent : await readWorkspaceFile(change.path);

        if (previousContent === change.newContent) {
          return null;
        }

        return {
          path: change.path,
          status: change.status,
          oldContent: previousContent,
          newContent: change.newContent,
          diffHtml: createDiffHtml(previousContent, change.newContent)
        };
      })
    )
  ).filter((change): change is NonNullable<typeof change> => Boolean(change));

  if (!files.length) {
    logRoute(runId, "patch.empty");
    throw new HttpError(422, "AI did not return any file changes");
  }

  const patch = createPendingPatch(files);
  const selectedFileChange = (selectedFilePath ? files.find((change) => change.path === selectedFilePath) : null) || files[0];
  logRoute(runId, "done", { elapsedMs: Date.now() - startedAt, patchId: patch.patchId, files: files.map((file) => file.path) });

  return {
    patchId: patch.patchId,
    summary: aiResult.summary,
    files,
    oldContent: selectedFileChange.oldContent,
    newContent: selectedFileChange.newContent,
    diffHtml: createMultiFileDiffHtml(files)
  };
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

app.post(
  "/api/commands/run",
  asyncRoute(async (request, response) => {
    const { command, cwd, chatId } = request.body as Partial<RunCommandRequest>;

    if (!command?.trim()) {
      throw new HttpError(400, "command is required");
    }

    response.json({ result: await runProjectCommand(command, cwd, chatId) });
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

    const agentSteps: AgentStep[] = [];
    const patchResponse = await createEditPatchResponse(filePath, userRequest, (step) => agentSteps.push(step));

    response.json({
      ...patchResponse,
      agentSteps
    });
  })
);

app.post("/api/ai/generate-edit/stream", async (request, response) => {
  let completed = false;
  let clientClosed = false;

  response.on("close", () => {
    if (completed) return;
    clientClosed = true;
  });

  const sendEvent = (event: string, data: unknown) => {
    if (clientClosed || response.writableEnded) return;
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { path: filePath, userRequest } = request.body as Partial<GenerateEditRequest>;

    if (!userRequest) {
      throw new HttpError(400, "userRequest is required");
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const agentSteps: AgentStep[] = [];
    const patchResponse = await createEditPatchResponse(filePath, userRequest, (step) => {
      agentSteps.push(step);
      sendEvent("agent_step", { step });
    });

    completed = true;
    sendEvent("done", { patch: { ...patchResponse, agentSteps } });
    response.end();
  } catch (error) {
    completed = true;
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error(message);

    if (!response.headersSent) {
      response.status(error instanceof HttpError ? error.status : 500).json({ error: message });
      return;
    }

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

    const contextFiles = await readChatContextFiles(getRequestedContextPaths(request.body as Partial<FileChatRequest>));
    const history = await getFileChatMessages(chatKey);
    const answer = await generateFileChatReply(contextFiles, history, userRequest.trim(), chatKey);
    const messages = await appendFileChatTurn(chatKey, userRequest.trim(), answer);

    response.json({ messages });
  })
);

app.post("/api/ai/file-chat/stream", async (request, response) => {
  let completed = false;
  let clientClosed = false;
  const controller = new AbortController();

  response.on("close", () => {
    if (completed) return;
    clientClosed = true;
    controller.abort();
  });

  const sendEvent = (event: string, data: unknown) => {
    if (clientClosed || response.writableEnded) return;
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { userRequest, replayFromMessageId } = request.body as Partial<FileChatRequest>;
    const chatKey = requireChatKey(request.body as Partial<FileChatRequest>);

    if (!userRequest?.trim()) {
      throw new HttpError(400, "userRequest is required");
    }

    const contextFiles = await readChatContextFiles(getRequestedContextPaths(request.body as Partial<FileChatRequest>));
    const turn = await startFileChatTurn(chatKey, userRequest.trim(), replayFromMessageId);

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    sendEvent("user", { message: turn.userMessage });
    sendEvent("assistant_start", { message: turn.assistantMessage });
    sendEvent("chat", { chatId: chatKey, historyCount: turn.history.length });

    const answer = await streamFileChatReply(
      contextFiles,
      turn.history,
      userRequest.trim(),
      (delta) => sendEvent("delta", { id: turn.assistantMessage.id, delta }),
      controller.signal,
      chatKey,
      (step: AgentStep) => sendEvent("agent_step", { step })
    );
    const messages = await finishFileChatTurn(chatKey, turn.assistantMessage.id, answer);

    completed = true;
    sendEvent("done", { messages });
    response.end();
  } catch (error) {
    completed = true;
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error(message);

    if (!response.headersSent) {
      response.status(error instanceof HttpError ? error.status : 500).json({ error: message });
      return;
    }

    sendEvent("error", { error: message });
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
    const { patchId } = request.body as Partial<ApplyPatchRequest>;

    if (!patchId) {
      throw new HttpError(400, "patchId is required");
    }

    const patch = getPendingPatch(patchId);

    if (!patch) {
      throw new HttpError(404, "Patch not found");
    }

    for (const file of patch.files) {
      if (file.status === "create") {
        if (await workspacePathExists(file.path)) {
          throw new HttpError(409, `${file.path} already exists`);
        }
        continue;
      }

      const currentContent = await readWorkspaceFile(file.path);

      if (currentContent !== file.oldContent) {
        throw new HttpError(409, `${file.path} has changed since patch was generated`);
      }
    }

    await Promise.all([
      ...patch.files.filter((file) => file.status === "modify").map((file) => writeWorkspaceFile(file.path, file.newContent)),
      ...patch.files.filter((file) => file.status === "create").map((file) => createWorkspaceFile(file.path, file.newContent))
    ]);
    deletePendingPatch(patch.patchId);

    response.json({ success: true });
  })
);

app.post(
  "/api/patch/reject",
  asyncRoute(async (request, response) => {
    const { patchId } = request.body as Partial<RejectPatchRequest>;

    if (!patchId) {
      throw new HttpError(400, "patchId is required");
    }

    deletePendingPatch(patchId);
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
attachTerminalServer(server);

server.listen(config.serverPort, () => {
  console.log(`Mini AI Web Editor server running on http://localhost:${config.serverPort}`);
  console.log(`Workspace root: ${getWorkspaceRoot() || "(none)"}`);
});
