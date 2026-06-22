import path from "node:path";
import { generateAiEdit, type AgentStep, type EditPathRetryContext } from "./aiClient.js";
import { createDiffHtml, createMultiFileDiffHtml } from "./diffTools.js";
import { HttpError } from "./errors.js";
import { listFiles, readWorkspaceFile, safeResolve } from "./fileTools.js";
import { createPendingPatch } from "./patchStore.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { AiEditResult, FileTreeNode } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { isValidationCommand, selectDefaultValidationCommand } from "./validationCommand.js";

const routeLogPreviewChars = 500;

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
  if (aiResult.patches === null) {
    return { files: null, invalidFilePaths: [], validFilePaths: [] };
  }

  const existingPaths = flattenFilePaths(await listFiles(""));
  const existingPathSet = new Set(existingPaths.map((filePath) => filePath.toLowerCase()));
  const invalidFilePaths: string[] = [];
  const files = aiResult.patches
    .map((change) => {
      const existingPath = resolveExistingEditPath(change.filePath, existingPaths);

      if (existingPath) {
        return {
          ...change,
          path: existingPath,
          filePath: existingPath,
          status: "modify" as const
        };
      }

      const createPath = normalizeCandidateEditPath(change.filePath);

      try {
        safeResolve(createPath);
      } catch {
        invalidFilePaths.push(change.filePath);
        return null;
      }

      if (!createPath || existingPathSet.has(createPath.toLowerCase())) {
        invalidFilePaths.push(change.filePath);
        return null;
      }

      return {
        ...change,
        path: createPath,
        filePath: createPath,
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

export async function createEditPatchResponse(filePath: string | null | undefined, userRequest: string, onAgentStep?: (step: AgentStep) => void, taskSessionId?: string) {
  const runId = createRouteRunId("edit");
  const startedAt = Date.now();
  const selectedFilePath = typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
  logRoute(runId, "start", { selectedFilePath, userRequest });
  let oldContent = "";

  if (selectedFilePath) {
    onAgentStep?.(createAgentStep({ type: "tool_call", toolName: "readFile", input: { filePath: selectedFilePath, selected: true } }));
    oldContent = await readWorkspaceFile(selectedFilePath);
    onAgentStep?.(createAgentStep({ type: "tool_result", toolName: "readFile", output: { filePath: selectedFilePath, chars: oldContent.length, selected: true } }));
  }

  let retryContext: EditPathRetryContext | undefined;
  let aiResult: AiEditResult | null = null;
  let validatedPaths: Awaited<ReturnType<typeof validateEditResultPaths>> | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    logRoute(runId, "ai.generate.start", { attempt, retryContext });
    aiResult = await generateAiEdit(selectedFilePath, oldContent, userRequest, onAgentStep, retryContext);
    logRoute(runId, "ai.generate.done", { attempt, summary: aiResult.summary, patches: aiResult.patches?.map((file) => file.filePath) || null });
    validatedPaths = await validateEditResultPaths(aiResult, selectedFilePath);
    logRoute(runId, "paths.validated", { attempt, validFiles: validatedPaths.files?.map((file) => file.path) || null, invalidFilePaths: validatedPaths.invalidFilePaths });

    if (aiResult.patches === null) {
      if (attempt >= 1) {
        break;
      }

      const existingPaths = flattenFilePaths(await listFiles(""));
      retryContext = {
        invalidFilePaths: [],
        validFilePaths: getPathRetryCandidates([], existingPaths, selectedFilePath),
        reason: "no_file_changes",
        previousSummary: aiResult.summary
      };

      console.warn("AI returned no editable file changes, retrying with stronger edit instruction:", retryContext);
      logRoute(runId, "files.null.retry", retryContext);
      continue;
    }

    if (!validatedPaths.invalidFilePaths.length) {
      break;
    }

    retryContext = {
      invalidFilePaths: validatedPaths.invalidFilePaths,
      validFilePaths: validatedPaths.validFilePaths,
      reason: "invalid_paths"
    };

    console.warn("AI returned non-existent edit paths, retrying with valid paths:", retryContext);
    logRoute(runId, "paths.retry", retryContext);
  }

  if (!aiResult || !validatedPaths) {
    throw new HttpError(502, "AI did not return an edit response");
  }

  if (aiResult.patches === null) {
    throw new HttpError(422, `AI did not return any file changes. Summary: ${aiResult.summary}`);
  }

  if (validatedPaths.invalidFilePaths.length) {
    throw new HttpError(422, `AI returned file paths that do not exist: ${validatedPaths.invalidFilePaths.join(", ")}`);
  }

  const uniqueChanges = [...new Map((validatedPaths.files || []).map((change) => [change.path, change])).values()];
  logRoute(runId, "patch.prepare", { files: uniqueChanges.map((change) => change.path) });
  onAgentStep?.(createAgentStep({ type: "edit", files: uniqueChanges.map((change) => change.path) }));
  const files = (
    await Promise.all(
      uniqueChanges.map(async (change) => {
        const previousContent = change.status === "create" ? "" : await readWorkspaceFile(change.path);

        if (previousContent === change.newContent) {
          return null;
        }

        return {
          path: change.path,
          filePath: change.path,
          status: change.status,
          oldContent: previousContent,
          newContent: change.newContent,
          summary: change.summary,
          diffHtml: createDiffHtml(previousContent, change.newContent)
        };
      })
    )
  ).filter((change): change is NonNullable<typeof change> => Boolean(change));

  if (!files.length) {
    logRoute(runId, "patch.empty");
    throw new HttpError(422, "AI did not return any file changes");
  }

  const defaultValidationCommand = await selectDefaultValidationCommand();
  const suggestedValidationCommands = aiResult.commandsToRun?.filter(isValidationCommand) || [];
  const commandsToRun = suggestedValidationCommands.length ? suggestedValidationCommands : defaultValidationCommand ? [defaultValidationCommand] : undefined;
  const patch = createPendingPatch(files, taskSessionId, commandsToRun);
  const selectedFileChange = (selectedFilePath ? files.find((change) => change.path === selectedFilePath) : null) || files[0];
  logRoute(runId, "done", { elapsedMs: Date.now() - startedAt, patchId: patch.patchId, files: files.map((file) => file.path) });

  return {
    taskSessionId,
    patchId: patch.patchId,
    summary: aiResult.summary,
    files,
    commandsToRun,
    oldContent: selectedFileChange.oldContent,
    newContent: selectedFileChange.newContent,
    diffHtml: createMultiFileDiffHtml(files)
  };
}
