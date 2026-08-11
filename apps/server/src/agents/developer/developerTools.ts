import crypto from "node:crypto";
import { evaluateCommandPolicy } from "../../commandPolicy.js";
import { runProjectCommand } from "../../commandRunner.js";
import { parsePackageScript } from "../../commandExecution/commandClassifier.js";
import { createFileEditCheckpoint } from "../../checkpointStore.js";
import { createWorkspaceFile, readWorkspaceFile } from "../../fileTools.js";
import { replaceInFile } from "../../fileEditService.js";
import type { RuntimeTool } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { isPathInScope } from "../../runtime/permissionManager.js";
import {
  addTaskSessionCheckpoint,
  addTaskSessionFilesChanged,
  appendTaskSessionFileEditEvent
} from "../../taskSessionStore.js";
import type { FileEditResult } from "../../types.js";
import type { CommandPolicyResult, CommandResult } from "../../types.js";
import { explorerRuntimeTools } from "../explorer/explorerTools.js";
import type { DeveloperPatchOperation, DeveloperPatchResult } from "./contracts.js";

export type DeveloperToolDependencies = {
  evaluateCommandPolicy: (command: string) => CommandPolicyResult;
  runProjectCommand: (
    command: string,
    cwd?: string,
    chatId?: string,
    confirmed?: boolean,
    options?: { mode?: "foreground"; initiator?: "agent"; signal?: AbortSignal }
  ) => Promise<CommandResult>;
};

const defaultDependencies: DeveloperToolDependencies = {
  evaluateCommandPolicy,
  runProjectCommand
};

const allowedLocalCheckScript = /^(?:format:check|format-check|check|typecheck|type-check|lint)(?::[a-z0-9_.-]+)*$/i;

function requiredString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw runtimeError("INVALID_CONTRACT", `${name} 不能为空。`);
  }
  return value.trim();
}

function requiredRawString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== "string") throw runtimeError("INVALID_CONTRACT", `${name} 必须是字符串。`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw runtimeError("INVALID_CONTRACT", `${name} 必须是非空字符串。`);
  }
  return value.trim();
}

function summarizeCommandResult(result: CommandResult) {
  return {
    command: result.command,
    cwd: result.cwd,
    status: result.status,
    exitCode: result.exitCode,
    summary: result.summary,
    output: (result.stdout || result.stderr || "").slice(-4_000),
    outputTruncated: result.outputTruncated === true
  };
}

function patchOperation(args: Record<string, unknown>): DeveloperPatchOperation {
  if (args.operation !== "replace" && args.operation !== "create") {
    throw runtimeError("INVALID_CONTRACT", "apply_patch.operation 必须是 replace 或 create。");
  }
  return args.operation;
}

function taskSessionId(context: Parameters<RuntimeTool["execute"]>[1]) {
  const value = context.task.context;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).taskSessionId;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

async function executeAuditedPatch(
  operation: DeveloperPatchOperation,
  filePath: string,
  context: Parameters<RuntimeTool["execute"]>[1],
  edit: () => Promise<FileEditResult>
) {
  const sessionId = taskSessionId(context);
  const eventId = `developer-apply-patch-${crypto.randomUUID()}`;
  await appendTaskSessionFileEditEvent(sessionId, {
    id: `${eventId}:started`,
    type: "file_edit_started",
    toolName: operation === "replace" ? "replaceInFile" : "writeFile",
    filePath,
    detail: { source: "developer_runtime", operation }
  });

  try {
    const result = await edit();
    if (!result.changed) return { result };
    const source = {
      taskSessionId: sessionId,
      toolName: "apply_patch",
      reason: "developer_runtime_apply_patch"
    };
    // 与现有直接编辑链路一致：使用真实 before/after 创建可回滚 checkpoint。
    const checkpoint = await createFileEditCheckpoint(context.task.taskId, result, { source });
    await Promise.all([
      addTaskSessionCheckpoint(sessionId, checkpoint.id),
      addTaskSessionFilesChanged(sessionId, [result.filePath]),
      appendTaskSessionFileEditEvent(sessionId, {
        id: `${eventId}:applied`,
        type: "file_edit_applied",
        toolName: operation === "replace" ? "replaceInFile" : "writeFile",
        filePath: result.filePath,
        checkpointId: checkpoint.id,
        detail: { source: "developer_runtime", operation, changed: true }
      })
    ]);
    return { result, checkpointId: checkpoint.id };
  } catch (error) {
    await appendTaskSessionFileEditEvent(sessionId, {
      id: `${eventId}:failed`,
      type: "file_edit_failed",
      toolName: operation === "replace" ? "replaceInFile" : "writeFile",
      filePath,
      detail: {
        source: "developer_runtime",
        operation,
        message: error instanceof Error ? error.message : "Developer 补丁执行失败"
      }
    });
    throw error;
  }
}

const applyPatchTool: RuntimeTool = {
  name: "apply_patch",
  description: "在授权范围内执行精确文本替换或创建新文本文件，不支持整文件覆盖和删除。",
  effect: "write",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["replace", "create"] },
      filePath: { type: "string" },
      search: { type: "string" },
      replace: { type: "string" },
      replaceAll: { type: "boolean" },
      content: { type: "string" }
    },
    required: ["operation", "filePath"],
    additionalProperties: false
  },
  getTargetPaths: (args) => [requiredString(args, "filePath")],
  getChangedFiles: (_args, result) => {
    const patch = result as Partial<DeveloperPatchResult> | null;
    return patch?.changed && typeof patch.filePath === "string" ? [patch.filePath] : [];
  },
  async execute(args, context): Promise<DeveloperPatchResult> {
    const operation = patchOperation(args);
    const filePath = requiredString(args, "filePath");

    if (operation === "create") {
      const content = requiredRawString(args, "content");
      const audited = await executeAuditedPatch(operation, filePath, context, async () => {
        await createWorkspaceFile(filePath, content);
        const writtenContent = await readWorkspaceFile(filePath);
        if (writtenContent !== content) {
          throw runtimeError("INVALID_CONTRACT", `新文件写入后内容校验失败：${filePath}`);
        }
        return {
          filePath,
          oldContent: "",
          finalContent: writtenContent,
          changed: true,
          beforeExists: false,
          afterExists: true
        };
      });
      return {
        filePath,
        operation,
        changed: audited.result.changed,
        ...(audited.checkpointId ? { checkpointId: audited.checkpointId } : {})
      };
    }

    // 精确替换会隐式读取旧内容，因此目标必须同时位于任务读取范围内。
    if (!isPathInScope(filePath, context.task.readScope)) {
      throw runtimeError("SCOPE_VIOLATION", `修改已有文件前必须具备读取权限：${filePath}`, {
        filePath,
        readScope: context.task.readScope
      });
    }
    const audited = await executeAuditedPatch(operation, filePath, context, () => replaceInFile({
        filePath,
        search: requiredRawString(args, "search"),
        replace: requiredRawString(args, "replace"),
        replaceAll: args.replaceAll === true
      }));
    const result = audited.result;
    return {
      filePath: result.filePath,
      operation,
      changed: result.changed,
      ...(result.replacements === undefined ? {} : { replacements: result.replacements }),
      ...(audited.checkpointId ? { checkpointId: audited.checkpointId } : {})
    };
  }
};

function createLocalCheckTool(dependencies: DeveloperToolDependencies): RuntimeTool {
  return {
    name: "run_local_check",
    description: "运行项目已声明的 format:check、check、typecheck 或 lint 包脚本；不接受任意命令，也不会运行测试、构建或写入式格式化。",
    effect: "execute",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" }
      },
      required: ["command"],
      additionalProperties: false
    },
    async execute(args, context) {
      const command = requiredString(args, "command");
      const cwd = optionalString(args, "cwd");
      const script = parsePackageScript(command)?.script;
      if (!script || !allowedLocalCheckScript.test(script)) {
        throw runtimeError(
          "PERMISSION_DENIED",
          "Developer 只能运行 format:check、check、typecheck 或 lint 包脚本。",
          { command }
        );
      }

      // 命令必须同时通过全局安全策略；confirm 级命令也不能由 Developer 自动执行。
      const policy = dependencies.evaluateCommandPolicy(command);
      if (policy.level !== "safe") {
        throw runtimeError("PERMISSION_DENIED", policy.reason, { command, policy: policy.level });
      }
      const result = await dependencies.runProjectCommand(command, cwd, undefined, false, {
        mode: "foreground",
        initiator: "agent",
        signal: context.signal
      });
      return summarizeCommandResult(result);
    }
  };
}

export const DEVELOPER_TOOL_NAMES = [
  "list_directory",
  "search_files",
  "grep",
  "read_file",
  "apply_patch",
  "run_local_check"
] as const;

/** Developer 复用 Explorer 的只读能力，只额外增加单一受控写工具。 */
export function createDeveloperRuntimeTools(dependencies: DeveloperToolDependencies = defaultDependencies): RuntimeTool[] {
  return [...explorerRuntimeTools, applyPatchTool, createLocalCheckTool(dependencies)];
}

export const developerRuntimeTools: RuntimeTool[] = createDeveloperRuntimeTools();
