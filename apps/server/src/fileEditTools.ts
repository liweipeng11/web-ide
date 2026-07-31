import { createFileEditCheckpoint } from "./checkpointStore.js";
import { replaceInFile, resolveSearchReplaceContent, SearchReplaceMismatchError, writeFile } from "./fileEditService.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { checkCodeImports } from "./existenceChecker/index.js";
import { addTaskSessionCheckpoint, addTaskSessionFilesChanged, appendTaskSessionFileEditEvent } from "./taskSessionStore.js";
import type { AgentFileEditToolResult, AgentToolDefinition } from "./agentToolTypes.js";
import type { CheckpointSource, FileEditResult } from "./types.js";
import type { AgentToolRuntime } from "./agentToolTypes.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { buildSafeEditRecommendation, evaluateSafeEdit } from "./safeEditor/index.js";
import { readWorkspaceFile, workspacePathExists } from "./fileTools.js";

const OLD_CONTENT_PREVIEW_LIMIT = 1200;

function optionalString(args: Record<string, unknown>, name: string) {
  return typeof args[name] === "string" ? args[name] : null;
}

function requiredString(args: Record<string, unknown>, name: string) {
  const value = optionalString(args, name);

  if (value === null || !value.trim()) {
    throw new Error(name + " is required");
  }

  return value.trim();
}

function requiredRawString(args: Record<string, unknown>, name: string) {
  const value = optionalString(args, name);

  if (value === null) {
    throw new Error(name + " is required");
  }

  return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string) {
  return typeof args[name] === "boolean" ? args[name] : undefined;
}

function createOldContentPreview(content: string) {
  return content.length > OLD_CONTENT_PREVIEW_LIMIT ? content.slice(0, OLD_CONTENT_PREVIEW_LIMIT) : content;
}

function createToolResult(result: FileEditResult, checkpointId?: string): AgentFileEditToolResult {
  return {
    ...result,
    // 旧内容只返回摘要，避免工具步骤里重复塞入过大的 before 内容。
    oldContentPreview: createOldContentPreview(result.oldContent),
    checkpointId
  };
}

function createNoOpToolResult(filePath: string, content: string, replacements?: number) {
  // 无变化编辑在生命周期外直接返回，避免创建 checkpoint 或写入任务会话状态。
  return createToolResult({
    filePath,
    oldContent: content,
    finalContent: content,
    changed: false,
    replacements,
    beforeExists: true,
    afterExists: true
  });
}

function summarizeFileEditResult(result: unknown, cached: boolean) {
  const value = result && typeof result === "object" && !Array.isArray(result) ? (result as AgentFileEditToolResult) : null;

  return {
    cached,
    filePath: value?.filePath,
    changed: value?.changed,
    replacements: value?.replacements,
    oldContentPreview: value?.oldContentPreview,
    finalContent: value?.finalContent,
    checkpointId: value?.checkpointId
  };
}

type FileEditToolName = "replaceInFile" | "writeFile";

function assertDirectEditIsSafe(input: { filePath: string; status: "create" | "modify"; oldContent: string; newContent: string; runtime: AgentToolRuntime }) {
  const { filePath, status, oldContent, newContent, runtime } = input;
  const impactAnalysis = runtime.agentContext.impactAnalyses?.at(-1);
  const recommendation = buildSafeEditRecommendation({
    impactAnalysis,
    fallbackTargetFiles: impactAnalysis ? [] : [filePath],
    editableScopeFiles: runtime.agentContext.filesRead
  });
  const report = evaluateSafeEdit({
    taskDescription: runtime.agentContext.userGoal,
    recommendation,
    candidates: [{ filePath, status, oldContent, newContent }]
  });
  const assessment = report.files[0];

  // 直接编辑没有 pending diff 审阅阶段，任何未消除的风险都应转回可审查 patch 流程。
  if (report.status !== "clean") {
    const detail = report.risks.map((risk) => risk.message).join("；") || assessment.reasons.join("；");
    throw new Error(`Safe Editor blocked risky direct edit; use proposePatch for review: ${filePath} (${detail})`);
  }
}

async function ensureWrittenImportsExist(content: string, filePath: string) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) throw new Error("No workspace selected");
  const { result } = await checkCodeImports(workspaceRoot, content, filePath);
  const unresolved = result.checks.filter((check) => check.status !== "exists");
  if (unresolved.length) throw new Error(`Cannot write unresolved import references: ${unresolved.map((check) => `${check.target.value} (${check.status})`).join(", ")}`);
}

function createCheckpointSource(runtime: AgentToolRuntime, toolName: FileEditToolName): CheckpointSource {
  return {
    taskSessionId: runtime.taskSessionId || null,
    toolCallId: runtime.currentToolCall?.id || null,
    toolName: runtime.currentToolCall?.name || toolName,
    actionId: runtime.currentToolCall?.actionId || null,
    reason: "agent_file_edit"
  };
}

async function executeFileEditWithLifecycle(toolName: FileEditToolName, filePath: string, runtime: AgentToolRuntime, edit: () => Promise<FileEditResult>) {
  const eventIdPrefix = runtime.currentToolCall?.id || `${toolName}-${Date.now().toString(36)}`;

  await appendTaskSessionFileEditEvent(runtime.taskSessionId, {
    id: `${eventIdPrefix}:started`,
    type: "file_edit_started",
    toolName,
    filePath,
    detail: {
      // started 事件只记录必要元信息，避免把 search/content 大块文本写入审计流水。
      toolCallId: runtime.currentToolCall?.id || null,
      actionId: runtime.currentToolCall?.actionId || null
    }
  });

  try {
    const result = await edit();
    const checkpoint = await createFileEditCheckpoint(runtime.taskSessionId || eventIdPrefix, result, { source: createCheckpointSource(runtime, toolName) });

    // 编辑成功后的 checkpoint、文件集合与生命周期事件属于同一快照，并行提交后由存储层合并写入。
    await Promise.all([
      addTaskSessionCheckpoint(runtime.taskSessionId, checkpoint.id),
      addTaskSessionFilesChanged(runtime.taskSessionId, result.changed ? [result.filePath] : []),
      appendTaskSessionFileEditEvent(runtime.taskSessionId, {
        id: `${eventIdPrefix}:applied`,
        type: "file_edit_applied",
        toolName,
        filePath: result.filePath,
        checkpointId: checkpoint.id,
        detail: {
          changed: result.changed,
          replacements: result.replacements,
          oldContentPreview: createOldContentPreview(result.oldContent),
          finalContentPreview: createOldContentPreview(result.finalContent)
        }
      })
    ]);
    runtime.onAgentStep?.(
      createAgentStep({
        type: "checkpoint",
        checkpointId: checkpoint.id,
        files: [result.filePath],
        source: checkpoint.source
      })
    );

    return createToolResult(result, checkpoint.id);
  } catch (error) {
    await appendTaskSessionFileEditEvent(runtime.taskSessionId, {
      id: `${eventIdPrefix}:failed`,
      type: "file_edit_failed",
      toolName,
      filePath,
      detail: {
        message: error instanceof Error ? error.message : `${toolName} failed`
      }
    });

    throw error;
  }
}

export const fileEditToolDefinitions: AgentToolDefinition[] = [
  {
    name: "replaceInFile",
    description:
      "Edit an existing workspace file by replacing an exact search block. Returns finalContent, which must be treated as the latest file state for any follow-up edit.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Workspace-relative file path to edit."
        },
        search: {
          type: "string",
          description: "Exact text block to replace. It must match the current file content."
        },
        replace: {
          type: "string",
          description: "Replacement text. Use an empty string only when intentionally removing the search block."
        },
        replaceAll: {
          type: "boolean",
          description: "When true, replace every exact occurrence. Defaults to replacing only the first occurrence."
        }
      },
      required: ["filePath", "search", "replace"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const filePath = requiredString(args, "filePath");
      const search = requiredRawString(args, "search");
      const replace = requiredRawString(args, "replace");
      const replaceAll = optionalBoolean(args, "replaceAll");

      // 先预计算完整结果；完全相同时不进入会产生任务状态写入的编辑生命周期。
      if (search) {
        const oldContent = await readWorkspaceFile(filePath);
        const resolved = resolveSearchReplaceContent(oldContent, search, replace, replaceAll);
        if (resolved?.content === oldContent) {
          return createNoOpToolResult(filePath, oldContent, resolved.replacements);
        }
      }

      // replacement 中新增的 import 必须先在真实工作区中解析成功，防止直接编辑绕过 Agent 门禁。
      await ensureWrittenImportsExist(replace, filePath);
      const result = await executeFileEditWithLifecycle("replaceInFile", filePath, runtime, async () => {
        const oldContent = await readWorkspaceFile(filePath);
        const resolved = resolveSearchReplaceContent(oldContent, search, replace, replaceAll);
        if (!resolved) throw new SearchReplaceMismatchError(filePath);
        assertDirectEditIsSafe({ filePath, status: "modify", oldContent, newContent: resolved.content, runtime });
        return replaceInFile({
          filePath,
          search,
          replace,
          replaceAll
        });
      });

      return result;
    },
    summarize: summarizeFileEditResult
  },
  {
    name: "writeFile",
    description:
      "Write the full content of a workspace file. Use createIfMissing=true only when intentionally creating a new file. Returns finalContent as the latest file state.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Workspace-relative file path to write."
        },
        content: {
          type: "string",
          description: "Full final file content to write."
        },
        createIfMissing: {
          type: "boolean",
          description: "Allow creating the file when it does not exist. Defaults to false."
        }
      },
      required: ["filePath", "content"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const filePath = requiredString(args, "filePath");
      const content = requiredRawString(args, "content");
      const createIfMissing = optionalBoolean(args, "createIfMissing");
      const exists = await workspacePathExists(filePath);

      if (exists) {
        const oldContent = await readWorkspaceFile(filePath);
        if (oldContent === content) {
          return createNoOpToolResult(filePath, oldContent);
        }
      }

      // 全量写入前校验最终内容中的 import，避免将不存在的模块落盘。
      await ensureWrittenImportsExist(content, filePath);
      const result = await executeFileEditWithLifecycle("writeFile", filePath, runtime, async () => {
        // no-op 预检后文件状态可能变化，真实编辑前重新读取以维持安全边界。
        const currentExists = await workspacePathExists(filePath);
        // createIfMissing 只是创建授权，不得用它覆盖未读取的已有文件。
        if (currentExists && !runtime.agentContext.filesRead.includes(filePath)) {
          throw new Error(`Cannot overwrite unread file: ${filePath}. Read the existing file before writing.`);
        }
        const oldContent = currentExists ? await readWorkspaceFile(filePath) : "";
        assertDirectEditIsSafe({ filePath, status: currentExists ? "modify" : "create", oldContent, newContent: content, runtime });
        return writeFile({
          filePath,
          content,
          createIfMissing
        });
      });

      return result;
    },
    summarize: summarizeFileEditResult
  }
];
