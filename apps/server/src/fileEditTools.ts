import { replaceInFile, writeFile } from "./fileEditService.js";
import type { AgentFileEditToolResult, AgentToolDefinition } from "./agentToolTypes.js";
import type { FileEditResult } from "./types.js";

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

function createToolResult(result: FileEditResult): AgentFileEditToolResult {
  return {
    ...result,
    // 旧内容只返回摘要，避免工具步骤里重复塞入过大的 before 内容。
    oldContentPreview: createOldContentPreview(result.oldContent)
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
    finalContent: value?.finalContent
  };
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
    async execute(args) {
      const result = await replaceInFile({
        filePath: requiredString(args, "filePath"),
        search: requiredRawString(args, "search"),
        replace: requiredRawString(args, "replace"),
        replaceAll: optionalBoolean(args, "replaceAll")
      });

      return createToolResult(result);
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
    async execute(args) {
      const result = await writeFile({
        filePath: requiredString(args, "filePath"),
        content: requiredRawString(args, "content"),
        createIfMissing: optionalBoolean(args, "createIfMissing")
      });

      return createToolResult(result);
    },
    summarize: summarizeFileEditResult
  }
];
