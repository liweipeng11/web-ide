import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { generateAiEdit, generateFileChatReply, streamFileChatReply } from "./aiClient.js";
import { appendFileChatTurn, branchFileChatMessages, clearFileChatMessages, deleteFileChatMessage, finishFileChatTurn, getFileChatMessages, listFileChatHistories, startFileChatTurn } from "./chatStore.js";
import { searchWorkspaceCode } from "./codeSearch.js";
import { createDiffHtml } from "./diffTools.js";
import { listFiles, readWorkspaceFile, writeWorkspaceFile } from "./fileTools.js";
import { createPendingPatch, deletePendingPatch, getPendingPatch, clearPendingPatches } from "./patchStore.js";
import type { ApplyPatchRequest, FileChatRequest, GenerateEditRequest, RejectPatchRequest, SaveFileRequest } from "./types.js";
import { attachTerminalServer } from "./terminalServer.js";
import { pickWorkspaceFolder } from "./workspacePicker.js";
import { getWorkspaceRoot, initializeWorkspaceRoot, setWorkspaceRoot } from "./workspaceStore.js";

const app = express();
const server = createServer(app);

app.use(express.json({ limit: "5mb" }));

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
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
    response.json(await listFiles(dir));
  })
);

app.get(
  "/api/file",
  asyncRoute(async (request, response) => {
    const filePath = typeof request.query.path === "string" ? request.query.path : "";

    if (!filePath) {
      throw new HttpError(400, "path is required");
    }

    response.json({
      path: filePath,
      content: await readWorkspaceFile(filePath)
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

    if (!filePath || !userRequest) {
      throw new HttpError(400, "path and userRequest are required");
    }

    const oldContent = await readWorkspaceFile(filePath);
    const aiResult = await generateAiEdit(filePath, oldContent, userRequest);

    if (aiResult.newContent === null) {
      response.status(422).json({ summary: aiResult.summary, error: aiResult.summary });
      return;
    }

    const patch = createPendingPatch(filePath, oldContent, aiResult.newContent);

    response.json({
      patchId: patch.patchId,
      summary: aiResult.summary,
      oldContent,
      newContent: aiResult.newContent,
      diffHtml: createDiffHtml(oldContent, aiResult.newContent)
    });
  })
);

app.get(
  "/api/ai/file-chat",
  asyncRoute(async (request, response) => {
    const filePath = typeof request.query.path === "string" ? request.query.path : "";

    if (!filePath) {
      throw new HttpError(400, "path is required");
    }

    await readWorkspaceFile(filePath);
    response.json({ messages: await getFileChatMessages(filePath) });
  })
);

app.get(
  "/api/ai/file-chat/histories",
  asyncRoute(async (_request, response) => {
    response.json({ histories: await listFileChatHistories() });
  })
);

app.post(
  "/api/ai/file-chat",
  asyncRoute(async (request, response) => {
    const { path: filePath, userRequest } = request.body as Partial<FileChatRequest>;

    if (!filePath || !userRequest?.trim()) {
      throw new HttpError(400, "path and userRequest are required");
    }

    const content = await readWorkspaceFile(filePath);
    const history = await getFileChatMessages(filePath);
    const answer = await generateFileChatReply(filePath, content, history, userRequest.trim());
    const messages = await appendFileChatTurn(filePath, userRequest.trim(), answer);

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
    const { path: filePath, userRequest, replayFromMessageId } = request.body as Partial<FileChatRequest>;

    if (!filePath || !userRequest?.trim()) {
      throw new HttpError(400, "path and userRequest are required");
    }

    const content = await readWorkspaceFile(filePath);
    const turn = await startFileChatTurn(filePath, userRequest.trim(), replayFromMessageId);

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    sendEvent("user", { message: turn.userMessage });
    sendEvent("assistant_start", { message: turn.assistantMessage });

    const answer = await streamFileChatReply(filePath, content, turn.history, userRequest.trim(), (delta) => sendEvent("delta", { id: turn.assistantMessage.id, delta }), controller.signal);
    const messages = await finishFileChatTurn(filePath, turn.assistantMessage.id, answer);

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
    const filePath = typeof request.query.path === "string" ? request.query.path : "";

    if (!filePath) {
      throw new HttpError(400, "path is required");
    }

    const messageId = String(request.params.messageId || "");
    response.json({ messages: await deleteFileChatMessage(filePath, messageId) });
  })
);

app.post(
  "/api/ai/file-chat/messages/:messageId/branch",
  asyncRoute(async (request, response) => {
    const filePath = typeof request.body?.path === "string" ? request.body.path : "";

    if (!filePath) {
      throw new HttpError(400, "path is required");
    }

    const messageId = String(request.params.messageId || "");
    response.json({ messages: await branchFileChatMessages(filePath, messageId) });
  })
);

app.delete(
  "/api/ai/file-chat",
  asyncRoute(async (request, response) => {
    const filePath = typeof request.query.path === "string" ? request.query.path : "";

    if (!filePath) {
      throw new HttpError(400, "path is required");
    }

    await clearFileChatMessages(filePath);
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

    const currentContent = await readWorkspaceFile(patch.filePath);

    if (currentContent !== patch.oldContent) {
      throw new HttpError(409, "File has changed since patch was generated");
    }

    await writeWorkspaceFile(patch.filePath, patch.newContent);
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
