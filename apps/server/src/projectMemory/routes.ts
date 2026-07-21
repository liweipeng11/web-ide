import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "../errors.js";
import { getProjectMemory, refreshProjectMemoryAnalysis, updateProjectMemory } from "./projectMemoryService.js";
import type { UpdateProjectMemoryInput } from "./types.js";

function normalizeEditableInput(value: unknown): UpdateProjectMemoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Project memory update must be an object");
  const record = value as Record<string, unknown>;
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

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
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

  return router;
}
