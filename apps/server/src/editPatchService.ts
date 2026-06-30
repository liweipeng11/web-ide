import path from "node:path";
import { generateAiEdit, type AgentStep, type EditPathRetryContext } from "./aiClient.js";
import { createDiffHtml, createEditHunks, createMultiFileDiffHtml } from "./diffTools.js";
import { buildEditScope, validatePatchesAgainstEditScope } from "./editScope.js";
import { HttpError } from "./errors.js";
import { listFiles, readWorkspaceFile, safeResolve } from "./fileTools.js";
import { createPendingPatch } from "./patchStore.js";
import { createAgentStep, createApprovalRequestStep } from "./routeAgentSteps.js";
import { resolvePatchNewContent, StaleFullFileRewriteError } from "./searchReplacePatch.js";
import type { AiEditResult, FileTreeNode, PatchFileChange } from "./types.js";
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

function validateEditScope(aiResult: AiEditResult, selectedFilePath: string | null, validatedPaths: Awaited<ReturnType<typeof validateEditResultPaths>>) {
  const scope =
    aiResult.editScope ||
    buildEditScope({
      selectedFilePath,
      filesRead: selectedFilePath ? [selectedFilePath] : [],
      allowNewFiles: false
    });
  const normalizedPatches =
    validatedPaths.files?.map((change) => ({
      filePath: change.path,
      oldContent: change.status === "create" ? "" : change.oldContent,
      newContent: change.newContent,
      summary: change.summary,
      edits: change.edits
    })) || null;

  return validatePatchesAgainstEditScope(normalizedPatches, scope);
}

type ValidatedFileChange = NonNullable<Awaited<ReturnType<typeof validateEditResultPaths>>["files"]>[number];

async function buildPatchFileChanges(changes: ValidatedFileChange[], userRequest: string): Promise<PatchFileChange[]> {
  const files = (
    await Promise.all(
      changes.map(async (change) => {
        const previousContent = change.status === "create" ? "" : await readWorkspaceFile(change.path);
        const newContent = change.status === "create" ? change.newContent : resolvePatchNewContent(change.path, change, previousContent, userRequest);

        if (previousContent === newContent) {
          return null;
        }

        return {
          path: change.path,
          filePath: change.path,
          status: change.status,
          oldContent: previousContent,
          newContent,
          summary: change.summary,
          diffHtml: createDiffHtml(previousContent, newContent),
          editHunks: createEditHunks(previousContent, newContent)
        };
      })
    )
  ).filter((change): change is NonNullable<typeof change> => Boolean(change));

  if (!files.length) {
    throw new HttpError(422, "AI did not return any file changes");
  }

  return files;
}

export async function createEditPatchResponse(filePath: string | null | undefined, userRequest: string, onAgentStep?: (step: AgentStep) => void, taskSessionId?: string) {
  const runId = createRouteRunId("edit");
  const startedAt = Date.now();
  const selectedFilePath = typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
  logRoute(runId, "start", { selectedFilePath, userRequest });
  let oldContent = "";

  if (selectedFilePath) {
    onAgentStep?.(
      createApprovalRequestStep({
        actionType: "read_file",
        title: "读取当前文件",
        summary: `准备用作编辑上下文读取 ${selectedFilePath}。`,
        status: "auto_approved",
        targets: [selectedFilePath],
        details: { selected: true }
      })
    );
    onAgentStep?.(createAgentStep({ type: "tool_call", toolName: "readFile", input: { filePath: selectedFilePath, selected: true } }));
    oldContent = await readWorkspaceFile(selectedFilePath);
    onAgentStep?.(createAgentStep({ type: "tool_result", toolName: "readFile", output: { filePath: selectedFilePath, chars: oldContent.length, selected: true } }));
  }

  let retryContext: EditPathRetryContext | undefined;
  let aiResult: AiEditResult | null = null;
  let validatedPaths: Awaited<ReturnType<typeof validateEditResultPaths>> | null = null;
  let files: PatchFileChange[] | null = null;

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

    if (validatedPaths.invalidFilePaths.length) {
      retryContext = {
        invalidFilePaths: validatedPaths.invalidFilePaths,
        validFilePaths: validatedPaths.validFilePaths,
        reason: "invalid_paths"
      };

      console.warn("AI returned non-existent edit paths, retrying with valid paths:", retryContext);
      logRoute(runId, "paths.retry", retryContext);
      continue;
    }

    const scopeValidation = validateEditScope(aiResult, selectedFilePath, validatedPaths);

    if (!scopeValidation.ok) {
      retryContext = {
        invalidFilePaths: scopeValidation.blockedFiles,
        validFilePaths: scopeValidation.allowedExistingFiles,
        reason: "scope_violation",
        previousSummary: aiResult.summary
      };

      console.warn("AI returned out-of-scope edit paths, retrying with approved scope:", retryContext);
      logRoute(runId, "scope.retry", retryContext);
      continue;
    }

    try {
      files = await buildPatchFileChanges([...new Map((validatedPaths.files || []).map((change) => [change.path, change])).values()], userRequest);
    } catch (error) {
      if (error instanceof StaleFullFileRewriteError && attempt < 2) {
        retryContext = {
          invalidFilePaths: [],
          validFilePaths: (validatedPaths.files || []).map((file) => file.path),
          reason: "stale_full_rewrite",
          previousSummary: aiResult.summary
        };

        console.warn("AI returned stale full-file rewrite, retrying with search/replace instruction:", retryContext);
        logRoute(runId, "staleFullRewrite.retry", retryContext);
        continue;
      }

      throw error;
    }

    break;
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

  if (!files) {
    throw new HttpError(422, "AI did not return any file changes");
  }

  const finalScopeValidation = validateEditScope(aiResult, selectedFilePath, validatedPaths);

  if (!finalScopeValidation.ok) {
    throw new HttpError(422, `AI tried to modify files outside the approved edit scope: ${finalScopeValidation.blockedFiles.join(", ")}`);
  }

  const uniqueChanges = [...new Map((validatedPaths.files || []).map((change) => [change.path, change])).values()];
  logRoute(runId, "patch.prepare", { files: uniqueChanges.map((change) => change.path) });
  onAgentStep?.(
    createApprovalRequestStep({
      actionType: "edit_files",
      title: "生成文件修改",
      summary: `准备生成 ${uniqueChanges.length} 个文件的补丁，用户审核后才会写入工作区。`,
      riskLevel: "medium",
      status: "pending",
      targets: uniqueChanges.map((change) => change.path),
      details: {
        files: uniqueChanges.map((change) => ({ path: change.path, status: change.status, summary: change.summary })),
        editScope: aiResult.editScope || null
      }
    })
  );
  onAgentStep?.(createAgentStep({ type: "edit", files: uniqueChanges.map((change) => change.path) }));

  if (!files.length) {
    logRoute(runId, "patch.empty");
    throw new HttpError(422, "AI did not return any file changes");
  }

  const defaultValidationCommand = await selectDefaultValidationCommand();
  const suggestedValidationCommands = aiResult.commandsToRun?.filter(isValidationCommand) || [];
  const commandsToRun = suggestedValidationCommands.length ? suggestedValidationCommands : defaultValidationCommand ? [defaultValidationCommand] : undefined;
  for (const command of commandsToRun || []) {
    onAgentStep?.(
      createApprovalRequestStep({
        actionType: "run_command",
        title: "建议运行验证命令",
        summary: "补丁生成后建议运行验证命令，执行前仍由用户确认。",
        riskLevel: "medium",
        status: "pending",
        command,
        details: { source: suggestedValidationCommands.includes(command) ? "ai" : "default" }
      })
    );
  }
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
