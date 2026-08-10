import path from "node:path";
import type { AgentPermissionPolicy, AgentResult, AgentTaskPacket, RuntimeTool } from "./contracts.js";
import { runtimeError } from "./errors.js";

function normalizeWorkspacePath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    throw runtimeError("SCOPE_VIOLATION", `路径必须是工作区相对路径：${value}`, { path: value });
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) {
    throw runtimeError("SCOPE_VIOLATION", `路径不能越出工作区：${value}`, { path: value });
  }
  return segments.filter((segment) => segment && segment !== ".").join("/");
}

function globToRegExp(pattern: string) {
  const normalized = normalizeWorkspacePath(pattern);
  let source = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const nextCharacter = normalized[index + 1];
    const afterNextCharacter = normalized[index + 2];

    if (character === "*" && nextCharacter === "*" && afterNextCharacter === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && nextCharacter === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}

export function isPathInScope(filePath: string, scope: string[]) {
  const normalizedPath = normalizeWorkspacePath(filePath);
  return scope.some((pattern) => globToRegExp(pattern).test(normalizedPath));
}

/** 权限管理器执行硬约束，Prompt 中的角色说明不能替代这里的检查。 */
export class PermissionManager {
  private readonly policies = new Map<string, Set<string>>();

  constructor(policies: AgentPermissionPolicy[]) {
    for (const policy of policies) {
      if (this.policies.has(policy.agentId)) {
        throw runtimeError("INVALID_CONTRACT", `Agent 权限策略重复：${policy.agentId}`, { agentId: policy.agentId });
      }
      this.policies.set(policy.agentId, new Set(policy.allowedTools));
    }
  }

  checkTool(agentId: string, task: AgentTaskPacket, tool: RuntimeTool, args: Record<string, unknown>) {
    const roleTools = this.policies.get(agentId);
    if (!roleTools?.has(tool.name) || !task.allowedTools.includes(tool.name)) {
      throw runtimeError("PERMISSION_DENIED", `Agent ${agentId} 无权调用工具 ${tool.name}。`, {
        agentId,
        toolName: tool.name
      });
    }

    if (tool.effect !== "read" && tool.effect !== "write") return;

    const targets = tool.getTargetPaths?.(args) ?? [];
    if (!targets.length) {
      throw runtimeError("SCOPE_VIOLATION", `工具 ${tool.name} 未声明可校验的目标路径。`, {
        agentId,
        toolName: tool.name
      });
    }

    const scope = tool.effect === "read" ? task.readScope : task.writeScope;
    const blockedPaths = targets.filter((target) => !isPathInScope(target, scope));
    if (blockedPaths.length) {
      throw runtimeError("SCOPE_VIOLATION", `工具 ${tool.name} 请求访问任务范围之外的路径。`, {
        agentId,
        toolName: tool.name,
        blockedPaths,
        scope
      });
    }
  }

  checkResult(task: AgentTaskPacket, result: AgentResult) {
    if (result.taskId !== task.taskId) {
      throw runtimeError("INVALID_CONTRACT", "AgentResult.taskId 与当前任务不一致。", {
        expectedTaskId: task.taskId,
        actualTaskId: result.taskId
      });
    }

    const blockedFiles = result.changedFiles.filter((filePath) => !isPathInScope(filePath, task.writeScope));
    if (blockedFiles.length) {
      throw runtimeError("SCOPE_VIOLATION", "AgentResult 包含 writeScope 之外的变更文件。", {
        blockedPaths: blockedFiles,
        writeScope: task.writeScope
      });
    }
  }
}
