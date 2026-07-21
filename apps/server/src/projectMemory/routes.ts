import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "../errors.js";
import { acceptMemoryCandidate, createMemoryCandidate, deleteMemoryItem, deleteMemoryItems, listMemoryCandidates, listMemoryItems, rejectMemoryCandidate, updateActiveMemoryItem, updateMemoryCandidate } from "./memoryCandidateService.js";
import { normalizePromotionInput, promoteMemoryToRule } from "./memoryPromotionService.js";
import { listMemoryUsageRecords } from "./memoryUsageService.js";
import { normalizeMemoryConfidence, normalizeMemorySourceRefs } from "./memorySanitizer.js";
import { getProjectMemory, refreshProjectMemoryAnalysis, updateProjectMemory } from "./projectMemoryService.js";
import type { CreateMemoryCandidateInput, ProjectMemorySourceRef, UpdateMemoryCandidateInput, UpdateProjectMemoryInput } from "./types.js";

function asInputRecord(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, message);
  return value as Record<string, unknown>;
}

function ensureAllowedFields(record: Record<string, unknown>, allowedFields: string[]) {
  const allowed = new Set(allowedFields);
  const unsupported = Object.keys(record).find((field) => !allowed.has(field));
  if (unsupported) throw new HttpError(400, `Field ${unsupported} cannot be set by the client`);
}

function normalizeEditableInput(value: unknown): UpdateProjectMemoryInput {
  const record = asInputRecord(value, "Project memory update must be an object");
  const input: UpdateProjectMemoryInput = {};

  if ("projectSummary" in record) {
    if (typeof record.projectSummary !== "string") throw new HttpError(400, "projectSummary must be a string");
    input.projectSummary = record.projectSummary;
  }

  for (const field of ["currentGoals", "confirmedRisks"] as const) {
    if (!(field in record)) continue;
    if (!Array.isArray(record[field]) || !record[field].every((item) => typeof item === "string")) {
      throw new HttpError(400, `${field} must be an array of strings`);
    }
    input[field] = record[field] as string[];
  }

  return input;
}

function normalizeUserCandidateInput(value: unknown): CreateMemoryCandidateInput {
  const record = asInputRecord(value, "Memory candidate must be an object");
  ensureAllowedFields(record, ["kind", "content", "scope", "sourceRefs", "confidence"]);
  const sourceRefs = record.sourceRefs === undefined
    ? [{ type: "user", value: "manual-api" } satisfies ProjectMemorySourceRef]
    : normalizeMemorySourceRefs(record.sourceRefs);
  if (!sourceRefs.length || sourceRefs.some((sourceRef) => sourceRef.type !== "user")) {
    throw new HttpError(400, "Client-created memory can only use user sources");
  }
  return {
    kind: record.kind as CreateMemoryCandidateInput["kind"],
    content: record.content as string,
    scope: record.scope as CreateMemoryCandidateInput["scope"],
    sourceRefs,
    createdBy: "user",
    confidence: record.confidence === undefined ? 1 : normalizeMemoryConfidence(record.confidence)
  };
}

function normalizeCandidateUpdate(value: unknown): UpdateMemoryCandidateInput {
  const record = asInputRecord(value, "Memory candidate update must be an object");
  ensureAllowedFields(record, ["kind", "content", "scope"]);
  if (!Object.keys(record).length) throw new HttpError(400, "Memory candidate update cannot be empty");
  return {
    ...(record.kind === undefined ? {} : { kind: record.kind as UpdateMemoryCandidateInput["kind"] }),
    ...(record.content === undefined ? {} : { content: record.content as string }),
    ...(record.scope === undefined ? {} : { scope: record.scope as UpdateMemoryCandidateInput["scope"] })
  };
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function requireRouteId(value: string | string[]) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new HttpError(400, "Memory id is invalid");
  return value;
}

function normalizeBulkDeleteInput(value: unknown) {
  const record = asInputRecord(value, "Bulk delete input must be an object");
  ensureAllowedFields(record, ["ids", "confirmed"]);
  if (record.confirmed !== true) throw new HttpError(400, "Bulk delete requires explicit confirmation");
  if (!Array.isArray(record.ids) || !record.ids.length || record.ids.length > 100 || !record.ids.every((id) => typeof id === "string" && id.trim() && id.length <= 200)) {
    throw new HttpError(400, "ids must contain 1 to 100 valid memory ids");
  }
  return [...new Set(record.ids as string[])];
}

export function createProjectMemoryRouter() {
  const router = Router();

  router.get("/", asyncRoute(async (_request, response) => {
    response.json({ memory: await getProjectMemory() });
  }));

  router.patch("/", asyncRoute(async (request, response) => {
    response.json({ memory: await updateProjectMemory(normalizeEditableInput(request.body)) });
  }));

  router.post("/refresh", asyncRoute(async (_request, response) => {
    response.json({ memory: await refreshProjectMemoryAnalysis() });
  }));

  router.get("/candidates", asyncRoute(async (_request, response) => {
    response.json({ candidates: await listMemoryCandidates() });
  }));

  router.get("/items", asyncRoute(async (_request, response) => {
    response.json({ items: await listMemoryItems() });
  }));

  router.get("/usage", asyncRoute(async (request, response) => {
    const rawLimit = typeof request.query.limit === "string" ? Number(request.query.limit) : 10;
    response.json({ records: await listMemoryUsageRecords(undefined, Number.isFinite(rawLimit) ? rawLimit : 10) });
  }));

  router.post("/candidates", asyncRoute(async (request, response) => {
    const result = await createMemoryCandidate(normalizeUserCandidateInput(request.body));
    response.status(result.created ? 201 : 200).json(result);
  }));

  router.patch("/candidates/:id", asyncRoute(async (request, response) => {
    response.json({ candidate: await updateMemoryCandidate(requireRouteId(request.params.id), normalizeCandidateUpdate(request.body)) });
  }));

  router.post("/candidates/:id/accept", asyncRoute(async (request, response) => {
    response.json({ candidate: await acceptMemoryCandidate(requireRouteId(request.params.id)) });
  }));

  router.post("/candidates/:id/reject", asyncRoute(async (request, response) => {
    await rejectMemoryCandidate(requireRouteId(request.params.id));
    response.status(204).end();
  }));

  router.post("/items/bulk-delete", asyncRoute(async (request, response) => {
    response.json({ deletedCount: await deleteMemoryItems(normalizeBulkDeleteInput(request.body)) });
  }));

  router.patch("/items/:id", asyncRoute(async (request, response) => {
    response.json({ item: await updateActiveMemoryItem(requireRouteId(request.params.id), normalizeCandidateUpdate(request.body)) });
  }));

  router.post("/items/:id/promote", asyncRoute(async (request, response) => {
    response.status(201).json(await promoteMemoryToRule(requireRouteId(request.params.id), normalizePromotionInput(request.body)));
  }));

  router.delete("/items/:id", asyncRoute(async (request, response) => {
    await deleteMemoryItem(requireRouteId(request.params.id));
    response.status(204).end();
  }));

  return router;
}
