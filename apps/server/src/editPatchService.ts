import path from "node:path";
import { generateAiEdit, type AgentStep, type EditPathRetryContext } from "./aiClient.js";
import { buildPatchCompletenessReport, createContextSelectionSnapshot, formatContextSelectionNeed, type ContextSelectionSnapshot, type PatchCompletenessReport } from "./contextSelection/index.js";
import { createBinaryDiffHtml, createDiffHtml, createEditHunks, createMultiFileDiffHtml } from "./diffTools.js";
import { buildEditScope, validatePatchesAgainstEditScope } from "./editScope.js";
import { HttpError } from "./errors.js";
import { buildPlannedFileGraph, checkPatchImports, type PlannedFileGraph } from "./existenceChecker/index.js";
import { listFiles, readWorkspaceFile, readWorkspaceFileForDiff, safeResolve } from "./fileTools.js";
import { createPendingPatch } from "./patchStore.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { resolvePatchNewContent, StaleFullFileRewriteError } from "./searchReplacePatch.js";
import { buildSafeEditRecommendation, evaluateSafeEdit } from "./safeEditor/index.js";
import { appendTaskSessionPatchEvent, getTaskSession, recordTaskSessionContextSelection, recordTaskSessionPatchDiagnostics } from "./taskSessionStore.js";
import type { AiEditResult, FileTreeNode, PatchFileChange, PatchFilterRecord, PatchGenerationDiagnostics } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { isValidationCommand, selectDefaultValidationCommand } from "./validationCommand.js";
import { config } from "./config.js";
import { recordFeatureDecisionDifference } from "./featureFlags.js";
import {
  preparePatchSafeEditRecommendation,
  recoverPatchSafeEditReport,
  type EditPatchSafeEditOptions,
  type SafeEditCandidate,
} from "./safeEditor/index.js";

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

function isDeletePatch(change: { status?: string }) {
  return change.status === "delete";
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
        if (change.status === "create") {
          invalidFilePaths.push(change.filePath);
          return null;
        }
        return {
          ...change,
          path: existingPath,
          filePath: existingPath,
          status: isDeletePatch(change) ? ("delete" as const) : ("modify" as const)
        };
      }

      if (isDeletePatch(change)) {
        invalidFilePaths.push(change.filePath);
        return null;
      }
      if (change.status === "modify") {
        invalidFilePaths.push(change.filePath);
        return null;
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
      newContent: change.status === "delete" ? "" : change.newContent,
      status: change.status,
      summary: change.summary,
      edits: change.edits
    })) || null;

  return validatePatchesAgainstEditScope(normalizedPatches, scope);
}

type ValidatedFileChange = NonNullable<Awaited<ReturnType<typeof validateEditResultPaths>>["files"]>[number];

/** 在 pending patch 入库前校验最终内容，确保所有阻断型 import 都能在补丁后文件图中解析。 */
export async function validateFinalPatchImports(
  workspaceRoot: string,
  files: Parameters<typeof checkPatchImports>[1],
  plannedFileGraph?: PlannedFileGraph
) {
  const legacyValidation = await checkPatchImports(workspaceRoot, files);
  const plannedValidation = plannedFileGraph
    ? await checkPatchImports(workspaceRoot, files, plannedFileGraph)
    : legacyValidation;
  if (plannedFileGraph) {
    recordFeatureDecisionDifference({
      feature: "plannedFileResolution",
      legacyDecision: { unresolvedCount: legacyValidation.unresolved.length },
      nextDecision: { unresolvedCount: plannedValidation.unresolved.length }
    });
  }
  const validation = config.featureFlags.plannedFileResolution
    ? plannedValidation
    : legacyValidation;
  if (validation.unresolved.length) {
    const details = validation.unresolved
      .map(({ filePath, check }) => `${filePath}: ${check.target.value} (${check.resolution.status})`)
      .join(", ");
    throw new HttpError(422, `Generated patch contains unresolved import references: ${details}`);
  }
  return validation;
}

export function buildFinalPatchSummary(options: { files: Pick<PatchFileChange, "path">[]; rawPatchCount?: number; commandsToRun?: string[] }) {
  const finalPatchCount = options.files.length;
  const rawPatchCount = options.rawPatchCount ?? finalPatchCount;
  const ignoredCount = Math.max(0, rawPatchCount - finalPatchCount);
  const validationText = options.commandsToRun?.length ? "，并已附带建议验证命令" : "";

  // 主摘要只描述最终可审核 diff，避免模型原始说明和真实文件数量不一致。
  if (ignoredCount > 0) {
    return `已生成 ${finalPatchCount} 个文件的修改${validationText}，其中 ${ignoredCount} 个模型候选变更未进入最终 diff。`;
  }

  return `已生成 ${finalPatchCount} 个文件的修改${validationText}。`;
}

function createPatchFilterRecord(input: PatchFilterRecord): PatchFilterRecord {
  return input;
}

function dedupeValidatedChanges(changes: ValidatedFileChange[], attempt: number) {
  const latestByPath = new Map<string, ValidatedFileChange>();
  const duplicateRecords: PatchFilterRecord[] = [];

  for (const change of changes) {
    const previous = latestByPath.get(change.path);

    if (previous) {
      duplicateRecords.push(
        createPatchFilterRecord({
          reason: "duplicate_path",
          stage: "dedupe",
          attempt,
          filePath: previous.filePath,
          normalizedPath: previous.path,
          detail: "同一路径出现多条候选修改，已保留最后一条候选。"
        })
      );
    }

    latestByPath.set(change.path, change);
  }

  return {
    uniqueChanges: [...latestByPath.values()],
    duplicateRecords
  };
}

export function buildPatchGenerationDiagnostics(input: {
  patchId?: string;
  modelSummary?: string;
  rawPatchCount: number;
  normalizedFilePaths: string[];
  preDedupeCount: number;
  postDedupeCount: number;
  finalPatchCount: number;
  records: PatchFilterRecord[];
  contextSelection?: ContextSelectionSnapshot;
  patchCompleteness?: PatchCompletenessReport;
  safeEditReport?: PatchGenerationDiagnostics["safeEditReport"];
  safeEditTelemetry?: PatchGenerationDiagnostics["safeEditTelemetry"];
}): PatchGenerationDiagnostics {
  const noEffectCount = input.records.filter((record) => record.reason === "no_effect_change").length;

  // diagnostics 是历史解释的事实源，统计值都从最终清洗过程和结构化记录推导。
  return {
    patchId: input.patchId,
    modelSummary: input.modelSummary,
    rawPatchCount: input.rawPatchCount,
    normalizedFilePaths: input.normalizedFilePaths,
    preDedupeCount: input.preDedupeCount,
    postDedupeCount: input.postDedupeCount,
    finalPatchCount: input.finalPatchCount,
    filteredCount: input.records.length,
    noEffectCount,
    records: input.records,
    contextSelection: input.contextSelection,
    patchCompleteness: input.patchCompleteness,
    safeEditReport: input.safeEditReport,
    safeEditTelemetry: input.safeEditTelemetry,
    generatedAt: Date.now()
  };
}

function getStringRecordField(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return typeof record[field] === "string" ? record[field] : "";
}

function getSearchResultFilesFromStep(step: AgentStep) {
  if (step.type !== "tool_result" || !["searchCode", "searchCodeRegex", "searchFilesByName"].includes(step.toolName)) {
    return [];
  }

  const output = step.output;
  const values = Array.isArray(output) ? output : output && typeof output === "object" && Array.isArray((output as Record<string, unknown>).results) ? ((output as Record<string, unknown>).results as unknown[]) : [];

  return values
    .map((item) => getStringRecordField(item, "filePath") || getStringRecordField(item, "path"))
    .filter(Boolean);
}

async function createPrePatchContextSnapshot(input: { taskSessionId?: string; userRequest: string; selectedFilePath: string | null }) {
  const session = input.taskSessionId
    ? await getTaskSession(input.taskSessionId).catch((error) => {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      })
    : null;
  const sessionFilesRead = session?.filesRead || [];
  const selectedFilesRead = input.selectedFilePath ? [input.selectedFilePath] : [];
  const searchResultFiles = session?.steps.flatMap(getSearchResultFilesFromStep) || [];

  return createContextSelectionSnapshot({
    taskSessionId: input.taskSessionId || null,
    userGoal: input.userRequest,
    selectedFilePath: input.selectedFilePath,
    filesRead: [...sessionFilesRead, ...selectedFilesRead],
    searchResultFiles
  });
}

function assertNoDeletePatches(aiResult: AiEditResult) {
  const deletePaths = aiResult.patches?.filter((patch) => patch.status === "delete").map((patch) => patch.filePath) || [];

  if (deletePaths.length) {
    throw new HttpError(422, `Whole-file deletion must use runCommand with user approval, not a diff patch: ${deletePaths.join(", ")}`);
  }
}

async function buildPatchFileChanges(changes: ValidatedFileChange[], userRequest: string, attempt: number): Promise<{ files: PatchFileChange[]; noEffectRecords: PatchFilterRecord[] }> {
  const noEffectRecords: PatchFilterRecord[] = [];
  const files = (
    await Promise.all(
      changes.map(async (change) => {
        const previousFile = change.status === "create" ? null : await readWorkspaceFileForDiff(change.path);

        if (previousFile?.isBinary && change.status !== "delete") {
          throw new HttpError(415, `Cannot modify binary file through text diff: ${change.path}`);
        }

        const previousContent = previousFile?.content || "";
        const newContent = change.status === "delete" ? "" : change.status === "create" ? change.newContent : resolvePatchNewContent(change.path, change, previousContent, userRequest);

        if (change.status !== "delete" && previousContent === newContent) {
          noEffectRecords.push(
            createPatchFilterRecord({
              reason: "no_effect_change",
              stage: "content_diff",
              attempt,
              filePath: change.filePath,
              normalizedPath: change.path,
              detail: "候选修改计算后的内容与当前文件一致，未进入最终 diff。"
            })
          );
          return null;
        }

        const isBinary = Boolean(previousFile?.isBinary);

        return {
          path: change.path,
          filePath: change.path,
          status: change.status,
          oldContent: previousContent,
          newContent,
          oldContentBase64: previousFile?.contentBase64,
          newContentBase64: isBinary ? "" : undefined,
          isBinary,
          summary: change.summary,
          diffHtml: isBinary ? createBinaryDiffHtml(change.status) : createDiffHtml(previousContent, newContent),
          editHunks: isBinary ? [] : createEditHunks(previousContent, newContent)
        };
      })
    )
  ).filter((change): change is NonNullable<typeof change> => Boolean(change));

  if (!files.length) {
    throw new HttpError(422, "AI did not return any file changes");
  }

  return { files, noEffectRecords };
}

export async function createEditPatchResponse(
  filePath: string | null | undefined,
  userRequest: string,
  onAgentStep?: (step: AgentStep) => void,
  taskSessionId?: string,
  safeEditRecommendationOverride?: import("./safeEditor/index.js").SafeEditRecommendation,
  modificationPlanOverride?: import("./safeEditor/index.js").StructuredModificationPlan,
  safeEditOptions: EditPatchSafeEditOptions = {},
  subagentInfo?: { delegationId?: string; subagentId?: string }
) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) throw new HttpError(400, "No workspace selected");
  const runId = createRouteRunId("edit");
  const startedAt = Date.now();
  const selectedFilePath = typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
  logRoute(runId, "start", { selectedFilePath, userRequest });
  let oldContent = "";

  if (selectedFilePath) {
    // 读取选中文件只用于构造补丁上下文，不生成审批卡。
    onAgentStep?.(createAgentStep({ type: "tool_call", toolName: "readFile", input: { filePath: selectedFilePath, selected: true } }));
    oldContent = await readWorkspaceFile(selectedFilePath);
    onAgentStep?.(createAgentStep({ type: "tool_result", toolName: "readFile", output: { filePath: selectedFilePath, chars: oldContent.length, selected: true } }));
  }

  const contextSelection = await createPrePatchContextSnapshot({ taskSessionId, userRequest, selectedFilePath });
  await recordTaskSessionContextSelection(taskSessionId, contextSelection);
  logRoute(runId, "contextSelection.ready", {
    readyForPatch: contextSelection.readyForPatch,
    candidateFiles: contextSelection.candidateFiles.map((file) => file.filePath),
    missingRequirements: contextSelection.missingRequirements.map((item) => item.requirement)
  });

  if ((taskSessionId || selectedFilePath) && !contextSelection.readyForPatch) {
    const contextNeed = formatContextSelectionNeed(contextSelection);

    onAgentStep?.(
      createAgentStep({
        type: "message",
        content: contextNeed.message
      })
    );
    throw new HttpError(428, contextNeed.message);
  }

  // 计划证据和必要的影响分析必须先于模型补丁生成，后续候选结果不能反向扩大安全范围。
  let patchSafeEditState = await preparePatchSafeEditRecommendation({
    workspaceRoot,
    selectedFilePath,
    modificationPlan: modificationPlanOverride,
    recommendationOverride: safeEditRecommendationOverride,
    previousAnalyses: safeEditOptions.previousAnalyses,
    executeImpactAnalysis: safeEditOptions.executeImpactAnalysis
  });
  logRoute(runId, "safeEdit.preflight", {
    evidenceSources: patchSafeEditState.recommendation.evidence.sources,
    evidenceComplete: patchSafeEditState.recommendation.evidence.complete,
    analysisAttemptCount: patchSafeEditState.analysisAttemptCount
  });

  let retryContext: EditPathRetryContext | undefined;
  let aiResult: AiEditResult | null = null;
  let validatedPaths: Awaited<ReturnType<typeof validateEditResultPaths>> | null = null;
  let files: PatchFileChange[] | null = null;
  let finalPreDedupeCount = 0;
  let finalPostDedupeCount = 0;
  let finalNormalizedFilePaths: string[] = [];
  const diagnosticsRecords: PatchFilterRecord[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    logRoute(runId, "ai.generate.start", { attempt, retryContext });
    aiResult = await generateAiEdit(selectedFilePath, oldContent, userRequest, onAgentStep, retryContext, modificationPlanOverride);
    logRoute(runId, "ai.generate.done", { attempt, summary: aiResult.summary, patches: aiResult.patches?.map((file) => file.filePath) || null });
    assertNoDeletePatches(aiResult);
    validatedPaths = await validateEditResultPaths(aiResult, selectedFilePath);
    logRoute(runId, "paths.validated", { attempt, validFiles: validatedPaths.files?.map((file) => file.path) || null, invalidFilePaths: validatedPaths.invalidFilePaths });
    diagnosticsRecords.push(
      ...validatedPaths.invalidFilePaths.map((filePath) =>
        createPatchFilterRecord({
          reason: "invalid_path",
          stage: "path_validation",
          attempt,
          filePath,
          detail: "模型返回的路径无法解析为当前工作区内可编辑文件。"
        })
      )
    );

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
      diagnosticsRecords.push(
        ...scopeValidation.blockedFiles.map((filePath) =>
          createPatchFilterRecord({
            reason: "scope_violation",
            stage: "scope_validation",
            attempt,
            filePath,
            normalizedPath: filePath,
            detail: "候选修改超出本轮允许编辑范围，已触发重试。"
          })
        )
      );
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
      const deduped = dedupeValidatedChanges(validatedPaths.files || [], attempt);
      diagnosticsRecords.push(...deduped.duplicateRecords);
      finalPreDedupeCount = validatedPaths.files?.length || 0;
      finalPostDedupeCount = deduped.uniqueChanges.length;
      finalNormalizedFilePaths = deduped.uniqueChanges.map((change) => change.path);
      // 第一次校验使用模型给出的计划与已知内容；此时不会写入任何真实文件。
      const plannedFiles = deduped.uniqueChanges.map((change) => ({
        path: change.path,
        status: change.status,
        newContent: change.status === "delete" ? "" : change.newContent
      }));
      const plannedFileGraph = await buildPlannedFileGraph(
        workspaceRoot,
        plannedFiles.map((file) => ({ filePath: file.path, changeKind: file.status, content: file.newContent }))
      );
      await validateFinalPatchImports(workspaceRoot, plannedFiles, plannedFileGraph);
      const patchFileResult = await buildPatchFileChanges(deduped.uniqueChanges, userRequest, attempt);
      diagnosticsRecords.push(...patchFileResult.noEffectRecords);
      files = patchFileResult.files;
      // 第二次校验针对 search/replace 计算后的最终内容，防止补丁后新增未知 import。
      await validateFinalPatchImports(workspaceRoot, files);
    } catch (error) {
      if (error instanceof StaleFullFileRewriteError && attempt < 2) {
        diagnosticsRecords.push(
          createPatchFilterRecord({
            reason: "stale_full_rewrite_retry",
            stage: "retry",
            attempt,
            filePath: error.filePath,
            normalizedPath: error.filePath,
            detail: "模型基于旧内容生成整文件重写，已改用 search/replace 指令重试。"
          })
        );
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

  const { uniqueChanges } = dedupeValidatedChanges(validatedPaths.files || [], 0);
  logRoute(runId, "patch.prepare", { files: uniqueChanges.map((change) => change.path) });
  // proposePatch 只创建待审查 diff，不写入工作区；真正写入由 applyPatch 审批后执行。
  onAgentStep?.(createAgentStep({ type: "edit", files: uniqueChanges.map((change) => change.path) }));

  if (!files.length) {
    logRoute(runId, "patch.empty");
    throw new HttpError(422, "AI did not return any file changes");
  }

  const defaultValidationCommand = await selectDefaultValidationCommand();
  const suggestedValidationCommands = aiResult.commandsToRun?.filter(isValidationCommand) || [];
  const commandsToRun = suggestedValidationCommands.length ? suggestedValidationCommands : defaultValidationCommand ? [defaultValidationCommand] : undefined;
  // 验证命令只随 pending patch 返回；当 runCommand 被真正调用时再进入唯一审批流程。
  const selectedFileChange = (selectedFilePath ? files.find((change) => change.path === selectedFilePath) : null) || files[0];
  const rawPatchCount = aiResult.patches.length;
  const finalSummary = buildFinalPatchSummary({ files, rawPatchCount, commandsToRun });
  const patchCompleteness = buildPatchCompletenessReport({
    snapshot: contextSelection,
    patchFiles: files.map((file) => file.path)
  });
  const candidates: SafeEditCandidate[] = files.map((file) => ({
    filePath: file.path,
    status: file.status,
    oldContent: file.oldContent,
    newContent: file.newContent,
    summary: file.summary
  }));
  const generatedSafeEditRecommendation = aiResult.editScope?.safeEditRecommendation;
  // 外层结构化计划是权威边界；只有缺少外层证据时才采用模型内部生成的推荐，避免候选补丁反向扩权。
  if (!modificationPlanOverride && !safeEditRecommendationOverride && generatedSafeEditRecommendation) {
    patchSafeEditState = {
      recommendation: generatedSafeEditRecommendation,
      analysisAttemptCount: patchSafeEditState.analysisAttemptCount,
      analysisIncomplete: generatedSafeEditRecommendation.evidence.complete === false
    };
  }
  const recoveredSafeEdit = await recoverPatchSafeEditReport({
    workspaceRoot,
    selectedFilePath,
    taskDescription: userRequest,
    candidates,
    modificationPlan: modificationPlanOverride,
    recommendationOverride: safeEditRecommendationOverride,
    previousAnalyses: safeEditOptions.previousAnalyses,
    executeImpactAnalysis: safeEditOptions.executeImpactAnalysis,
    evidenceV2Enabled: safeEditOptions.evidenceV2Enabled ?? config.featureFlags.safeEditEvidenceV2,
    current: patchSafeEditState
  });
  patchSafeEditState = recoveredSafeEdit.state;
  const safeEditReport = recoveredSafeEdit.report;
  recordFeatureDecisionDifference({
    feature: "safeEditEvidenceV2",
    legacyDecision: {
      status: recoveredSafeEdit.comparison.legacyStatus,
      expansionCount: recoveredSafeEdit.comparison.legacyExpansionCount
    },
    nextDecision: {
      status: recoveredSafeEdit.comparison.nextStatus,
      expansionCount: recoveredSafeEdit.comparison.nextExpansionCount
    }
  });
  logRoute(runId, "safeEdit.final", {
    status: safeEditReport.status,
    analysisAttemptCount: patchSafeEditState.analysisAttemptCount,
    analysisIncomplete: patchSafeEditState.analysisIncomplete,
    expansionFiles: safeEditReport.expansionFiles
  });
  const diagnosticsWithoutPatchId = buildPatchGenerationDiagnostics({
    modelSummary: aiResult.summary,
    rawPatchCount,
    normalizedFilePaths: finalNormalizedFilePaths.length ? finalNormalizedFilePaths : files.map((file) => file.path),
    preDedupeCount: finalPreDedupeCount || validatedPaths.files?.length || 0,
    postDedupeCount: finalPostDedupeCount || uniqueChanges.length,
    finalPatchCount: files.length,
    records: diagnosticsRecords,
    contextSelection,
    patchCompleteness,
    safeEditReport,
    safeEditTelemetry: recoveredSafeEdit.telemetry
  });
  const patch = createPendingPatch(files, taskSessionId, commandsToRun, diagnosticsWithoutPatchId, subagentInfo);
  const diagnostics = {
    ...diagnosticsWithoutPatchId,
    patchId: patch.patchId
  };
  patch.diagnostics = diagnostics;
  await recordTaskSessionPatchDiagnostics(taskSessionId, diagnostics);
  await appendTaskSessionPatchEvent(taskSessionId, {
    type: "patch_created",
    patchId: patch.patchId,
    filePaths: files.map((file) => file.path),
    message: finalSummary,
    detail: {
      rawPatchCount,
      finalPatchCount: files.length,
      commandsToRun: commandsToRun || []
    }
  });

  if (diagnostics.records.length) {
    await appendTaskSessionPatchEvent(taskSessionId, {
      type: "patch_filtered",
      patchId: patch.patchId,
      filePaths: diagnostics.records.map((record) => record.normalizedPath || record.filePath),
      message: `已过滤 ${diagnostics.filteredCount} 个候选变更。`,
      detail: {
        filteredCount: diagnostics.filteredCount,
        reasons: diagnostics.records.map((record) => ({
          reason: record.reason,
          stage: record.stage,
          filePath: record.filePath,
          normalizedPath: record.normalizedPath,
          detail: record.detail
        }))
      }
    });
  }
  logRoute(runId, "done", { elapsedMs: Date.now() - startedAt, patchId: patch.patchId, files: files.map((file) => file.path) });

  return {
    taskSessionId,
    patchId: patch.patchId,
    modelSummary: aiResult.summary,
    finalSummary,
    rawPatchCount,
    finalPatchCount: files.length,
    diagnostics,
    summary: finalSummary,
    files,
    commandsToRun,
    oldContent: selectedFileChange.oldContent,
    newContent: selectedFileChange.newContent,
    diffHtml: createMultiFileDiffHtml(files)
  };
}
