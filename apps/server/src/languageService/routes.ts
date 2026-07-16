import { Router } from "express";
import { HttpError } from "../errors.js";
import type { DocumentSyncRequest, LanguageServiceGateway, SourceLocation, SourceRange, UnifiedDiagnostic } from "../contracts/languageService.js";
import { languageServiceGateway } from "./service.js";
import { createWorkspaceEditPatchResponse } from "./workspaceEditPatchService.js";

function requiredPath(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "path is required");
  return value.trim();
}

function parseLocation(value: unknown): SourceLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "location is required");
  const location = value as Partial<SourceLocation>;
  if (typeof location.filePath !== "string" || !location.filePath.trim() || !Number.isInteger(location.line) || !Number.isInteger(location.column) || (location.line ?? 0) < 1 || (location.column ?? 0) < 1) {
    throw new HttpError(400, "location must contain a path and positive line/column");
  }
  return { filePath: location.filePath, line: location.line!, column: location.column! };
}

function parseRange(value: unknown): SourceRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "range is required");
  const range = value as Partial<SourceRange>;
  const start = parseLocation({ filePath: "range", ...range.start });
  const end = parseLocation({ filePath: "range", ...range.end });
  return { start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column } };
}

export function createLanguageServiceRouter(gateway: LanguageServiceGateway = languageServiceGateway) {
  const router = Router();

  router.get("/language-service/capabilities", async (request, response, next) => {
    try { response.json(await gateway.getCapabilities(requiredPath(request.query.path))); } catch (error) { next(error); }
  });

  router.post("/language-service/documents", async (request, response, next) => {
    try {
      const body = request.body as Partial<DocumentSyncRequest>;
      const validActions = new Set(["open", "change", "save", "close"]);
      if (!Number.isInteger(body.version) || (body.version ?? -1) < 0 || !validActions.has(body.action ?? "") || ((body.action === "open" || body.action === "change") && typeof body.content !== "string")) {
        throw new HttpError(400, "Invalid document synchronization request");
      }
      await gateway.syncDocument({ filePath: requiredPath(body.filePath), version: body.version!, action: body.action!, content: body.content });
      response.json({ success: true, version: body.version });
    } catch (error) { next(error); }
  });

  router.get("/language-service/diagnostics", async (request, response, next) => {
    try {
      const filePath = typeof request.query.path === "string" && request.query.path.trim() ? request.query.path : undefined;
      const version = typeof request.query.version === "string" && request.query.version.trim() ? Number(request.query.version) : undefined;
      if (version !== undefined && (!Number.isInteger(version) || version < 0)) throw new HttpError(400, "version must be a non-negative integer");
      response.json({ diagnostics: await gateway.getDiagnostics(filePath, version) });
    } catch (error) { next(error); }
  });

  for (const [route, method] of [["definition", "findDefinition"], ["references", "findReferences"], ["hover", "getHover"]] as const) {
    router.post(`/language-service/${route}`, async (request, response, next) => {
      try { response.json({ result: await gateway[method](parseLocation(request.body?.location)) }); } catch (error) { next(error); }
    });
  }

  router.get("/language-service/symbols", async (request, response, next) => {
    try {
      const query = typeof request.query.query === "string" ? request.query.query.slice(0, 200) : "";
      response.json({ symbols: await gateway.listWorkspaceSymbols(query) });
    } catch (error) { next(error); }
  });

  router.post("/language-service/code-actions", async (request, response, next) => {
    try {
      const filePath = requiredPath(request.body?.filePath);
      const diagnostics = Array.isArray(request.body?.diagnostics) ? request.body.diagnostics as UnifiedDiagnostic[] : [];
      response.json({ actions: await gateway.getCodeActions(filePath, parseRange(request.body?.range), diagnostics) });
    } catch (error) { next(error); }
  });

  router.post("/language-service/workspace-edit/patch", async (request, response, next) => {
    try {
      const edit = request.body?.edit;
      if (!edit || typeof edit !== "object" || Array.isArray(edit) || !edit.changes || typeof edit.changes !== "object") throw new HttpError(400, "edit.changes is required");
      const summary = typeof request.body?.summary === "string" && request.body.summary.trim() ? request.body.summary.trim().slice(0, 500) : "应用 Language Server 建议修改";
      response.json({ patch: await createWorkspaceEditPatchResponse(edit, summary) });
    } catch (error) { next(error); }
  });

  router.post("/language-service/rename", async (request, response, next) => {
    try {
      const newName = typeof request.body?.newName === "string" ? request.body.newName.trim() : "";
      if (!newName) throw new HttpError(400, "newName is required");
      const edit = await gateway.rename(parseLocation(request.body?.location), newName);
      response.json({ edit, patch: await createWorkspaceEditPatchResponse(edit, `重命名符号为 ${newName}`) });
    } catch (error) { next(error); }
  });

  return router;
}
