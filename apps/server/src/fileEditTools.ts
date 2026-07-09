import { createFileEditCheckpoint } from "./checkpointStore.js";
import { replaceInFile, writeFile } from "./fileEditService.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { addTaskSessionCheckpoint, addTaskSessionFilesChanged, appendTaskSessionFileEditEvent } from "./taskSessionStore.js";
import type { AgentFileEditToolResult, AgentToolDefinition } from "./agentToolTypes.js";
import type { CheckpointSource, FileEditResult } from "./types.js";
import type { AgentToolRuntime } from "./agentToolTypes.js";

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

    await Promise.all([addTaskSessionCheckpoint(runtime.taskSessionId, checkpoint.id), addTaskSessionFilesChanged(runtime.taskSessionId, result.changed ? [result.filePath] : [])]);
    await appendTaskSessionFileEditEvent(runtime.taskSessionId, {
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
    });
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
      const result = await executeFileEditWithLifecycle("replaceInFile", filePath, runtime, () =>
        replaceInFile({
          filePath,
          search: requiredRawString(args, "search"),
          replace: requiredRawString(args, "replace"),
          replaceAll: optionalBoolean(args, "replaceAll")
        })
      );

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
      const result = await executeFileEditWithLifecycle("writeFile", filePath, runtime, () =>
        writeFile({
          filePath,
          content: requiredRawString(args, "content"),
          createIfMissing: optionalBoolean(args, "createIfMissing")
        })
      );

      return result;
    },
    summarize: summarizeFileEditResult
  }
];
