import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "../errors.js";
import { addTaskSessionGitCommit, getTaskSession } from "../taskSessionStore.js";
import { commitGitChanges, createGitBranch, createSuggestedCommitMessage, getGitStatus } from "./gitService.js";
import type { CreateGitBranchRequest, GenerateCommitMessageRequest, GitCommitRequest } from "./types.js";

function getRequestFiles(value: unknown) {
  return Array.isArray(value) ? value.filter((file): file is string => typeof file === "string") : [];
}

export function createGitWorkflowRouter() {
  const router = Router();

  const asyncRoute = (handler: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };

  router.get("/status", asyncRoute(async (_request, response) => {
    response.json({ status: await getGitStatus() });
  }));

  router.post("/branches", asyncRoute(async (request, response) => {
    const { branchName, allowDirty } = request.body as Partial<CreateGitBranchRequest>;

    if (!branchName?.trim()) {
      throw new HttpError(400, "branchName is required");
    }

    response.json({ status: await createGitBranch(branchName, { allowDirty: Boolean(allowDirty) }) });
  }));

  router.post("/commit-message", asyncRoute(async (request, response) => {
    const { taskSessionId } = request.body as Partial<GenerateCommitMessageRequest>;
    const requestFiles = getRequestFiles(request.body?.files);
    const session = taskSessionId ? await getTaskSession(taskSessionId) : null;
    const files = requestFiles.length ? requestFiles : session?.filesChanged || [];

    response.json({
      message: createSuggestedCommitMessage({
        userGoal: session?.userGoal,
        files
      })
    });
  }));

  router.post("/commits", asyncRoute(async (request, response) => {
    const { taskSessionId, message } = request.body as Partial<GitCommitRequest>;
    const requestFiles = getRequestFiles(request.body?.files);
    const session = taskSessionId ? await getTaskSession(taskSessionId) : null;
    const files = requestFiles.length ? requestFiles : session?.filesChanged || [];

    if (!message?.trim()) {
      throw new HttpError(400, "message is required");
    }

    const result = await commitGitChanges(files, message);
    await addTaskSessionGitCommit(taskSessionId, {
      ...result.commit,
      files: result.files,
      createdAt: Date.now()
    });

    response.json(result);
  }));

  return router;
}
