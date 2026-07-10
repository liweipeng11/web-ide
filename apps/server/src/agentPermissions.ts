import { evaluateCommandPolicy } from "./commandPolicy.js";
import { createApprovalRequestStep, type ApprovalActionType, type ApprovalRiskLevel } from "./routeAgentSteps.js";
import type { AgentStep } from "./types.js";
import type { AgentToolCall, AgentToolDefinition } from "./agentToolTypes.js";

export type AgentToolApprovalDecision =
  | {
      status: "auto_approved";
      step: AgentStep;
    }
  | {
      status: "requires_approval";
      step: AgentStep;
      riskLevel: ApprovalRiskLevel;
    }
  | {
      status: "blocked";
      reason: string;
    };

function parseToolArguments(toolCall: AgentToolCall) {
  try {
    const value = JSON.parse(toolCall.function.arguments);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getStringArg(args: Record<string, unknown>, name: string) {
  return typeof args[name] === "string" ? args[name].trim() : "";
}

function getActionType(toolName: string): ApprovalActionType {
  if (toolName === "inspectProject") return "inspect_project";
  if (toolName === "searchCode" || toolName === "listFiles" || toolName === "searchFilesByName" || toolName === "listCodeDefinitionNames") return "search_code";
  if (toolName === "readFile" || toolName === "readFileRange") return "read_file";
  if (toolName === "runCommand") return "run_command";
  if (toolName === "proposePatch") return "edit_files";
  if (toolName === "applyPatch") return "apply_patch";
  if (toolName === "writeFile") return "write_file";
  if (toolName === "deleteFile") return "delete_file";
  if (toolName === "askUser") return "ask_user";
  return "tool_call";
}

function getTargets(toolName: string, args: Record<string, unknown>) {
  if (toolName === "searchCode" || toolName === "searchFilesByName") return getStringArg(args, "query") ? [getStringArg(args, "query")] : undefined;
  if (toolName === "listFiles" || toolName === "listCodeDefinitionNames") return getStringArg(args, "path") ? [getStringArg(args, "path")] : undefined;
  if (toolName === "runCommand") return getStringArg(args, "command") ? [getStringArg(args, "command")] : undefined;
  if (toolName === "applyPatch") return getStringArg(args, "filePath") ? [getStringArg(args, "filePath")] : getStringArg(args, "patchId") ? [getStringArg(args, "patchId")] : undefined;

  const filePath = getStringArg(args, "filePath") || getStringArg(args, "path");
  return filePath ? [filePath] : undefined;
}

function isReadonlyTool(toolName: string) {
  return (
    toolName === "inspectProject" ||
    toolName === "listFiles" ||
    toolName === "searchFilesByName" ||
    toolName === "listCodeDefinitionNames" ||
    toolName === "searchCode" ||
    toolName === "readFile" ||
    toolName === "readFileRange"
  );
}

function isAutoApprovedTool(toolName: string) {
  // proposePatch 只生成待审核 diff，不直接写入工作区，因此可以自动执行。
  return isReadonlyTool(toolName) || toolName === "proposePatch";
}

function requiresUserApproval(toolName: string) {
  return toolName === "runCommand" || toolName === "applyPatch" || toolName === "writeFile" || toolName === "deleteFile";
}

function getRiskLevel(toolName: string, args: Record<string, unknown>): ApprovalRiskLevel {
  if (toolName === "deleteFile") return "high";
  if (toolName === "runCommand") {
    const command = getStringArg(args, "command");
    const policy = evaluateCommandPolicy(command);

    // 命令工具先按 commandPolicy 做风险分层；真正执行时 commandRunner 仍会二次校验。
    if (policy.level === "blocked") return "high";
    if (policy.level === "confirm") return "medium";
    return "medium";
  }

  if (toolName === "applyPatch" || toolName === "writeFile") return "medium";
  return "low";
}

function getApprovalTitle(toolName: string) {
  if (toolName === "inspectProject") return "检查项目结构";
  if (toolName === "searchCode") return "搜索代码库";
  if (toolName === "listCodeDefinitionNames") return "提取代码定义";
  if (toolName === "readFile") return "读取文件";
  if (toolName === "readFileRange") return "读取文件片段";
  if (toolName === "runCommand") return "运行命令";
  if (toolName === "applyPatch") return "应用补丁";
  if (toolName === "writeFile") return "写入文件";
  if (toolName === "deleteFile") return "删除文件";
  if (toolName === "askUser") return "请求用户确认";
  return "调用工具";
}

function getApprovalSummary(toolName: string, args: Record<string, unknown>) {
  if (toolName === "inspectProject") return "读取 package 信息、依赖和框架线索，用于选择合适的实现方式。";
  if (toolName === "searchCode") return `准备使用关键词“${getStringArg(args, "query") || "未提供"}”搜索当前工作区。`;
  if (toolName === "listCodeDefinitionNames") return `准备提取“${getStringArg(args, "path") || "工作区"}”中的顶级代码定义摘要。`;
  if (toolName === "readFile") return `准备读取文件“${getStringArg(args, "filePath") || "未提供"}”作为上下文。`;
  if (toolName === "readFileRange") return `准备读取文件“${getStringArg(args, "filePath") || "未提供"}”的指定行范围。`;
  if (toolName === "runCommand") return `模型请求运行命令“${getStringArg(args, "command") || "未提供"}”，需要用户批准后执行。`;
  if (toolName === "applyPatch") return "模型请求应用文件补丁，需要用户批准后写入工作区。";
  if (toolName === "writeFile") return `模型请求写入文件“${getStringArg(args, "filePath") || getStringArg(args, "path") || "未提供"}”，需要用户批准。`;
  if (toolName === "deleteFile") return `模型请求删除文件“${getStringArg(args, "filePath") || getStringArg(args, "path") || "未提供"}”，需要用户批准。`;
  if (toolName === "askUser") return "模型需要用户补充信息后再继续执行。";
  return `模型请求调用工具“${toolName}”。`;
}

/**
 * 统一评估模型工具调用的审批策略，Runtime 只根据这里的结果决定自动执行、暂停等待或阻断。
 */
export function evaluateAgentToolApproval(toolCall: AgentToolCall, definition?: AgentToolDefinition): AgentToolApprovalDecision {
  const toolName = toolCall.function.name;
  const args = parseToolArguments(toolCall);

  if (!definition) {
    return {
      status: "blocked",
      reason: `Unknown tool: ${toolName}`
    };
  }

  if (toolName === "runCommand") {
    const command = getStringArg(args, "command");
    const policy = evaluateCommandPolicy(command);

    if (policy.level === "blocked") {
      return {
        status: "blocked",
        reason: policy.reason
      };
    }
  }

  const riskLevel = getRiskLevel(toolName, args);
  const step = createApprovalRequestStep({
    actionType: getActionType(toolName),
    title: getApprovalTitle(toolName),
    summary: getApprovalSummary(toolName, args),
    riskLevel,
    status: isAutoApprovedTool(toolName) ? "auto_approved" : "pending",
    targets: getTargets(toolName, args),
    command: toolName === "runCommand" ? getStringArg(args, "command") : undefined,
    details: {
      toolName,
      arguments: args,
      approvalSource: "agent_runtime"
    }
  });

  if (isAutoApprovedTool(toolName)) {
    return { status: "auto_approved", step };
  }

  if (requiresUserApproval(toolName) || riskLevel !== "low") {
    return { status: "requires_approval", step, riskLevel };
  }

  return { status: "auto_approved", step };
}
