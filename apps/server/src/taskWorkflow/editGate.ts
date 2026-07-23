import type { AgentContext } from "../agentToolTypes.js";
import type { ReferenceResolution } from "../existenceChecker/types.js";
import { parseReferenceCheckKey } from "./referenceChecks.js";
import type { WorkflowBlockDecision, WorkflowEditIntent } from "./types.js";

const editTools = new Set(["proposePatch", "replaceInFile", "writeFile", "deleteFile"]);

function stringArg(args: Record<string, unknown>, name: string) {
  return typeof args[name] === "string" && args[name].trim()
    ? args[name].trim().replaceAll("\\", "/").replace(/^\.\//, "")
    : null;
}

/** 根据工具和显式参数识别本次操作类型；最终磁盘状态仍由编辑工具二次确认。 */
export function resolveWorkflowEditIntent(toolName: string, args: Record<string, unknown> = {}): WorkflowEditIntent | null {
  if (!editTools.has(toolName)) return null;
  const filePath = stringArg(args, "filePath") || stringArg(args, "path");

  if (toolName === "replaceInFile") return { toolName, changeKind: "modify", filePath };
  if (toolName === "deleteFile") return { toolName, changeKind: "delete", filePath };
  if (toolName === "writeFile") {
    return { toolName, changeKind: args.createIfMissing === true ? "create" : "modify", filePath };
  }

  const declaredKind = args.changeKind;
  return {
    toolName,
    changeKind: declaredKind === "create" || declaredKind === "modify" || declaredKind === "delete" ? declaredKind : "proposal",
    filePath
  };
}

function isSamePath(left?: string, right?: string | null) {
  if (!left || !right) return false;
  return left.replaceAll("\\", "/").replace(/^\.\//, "") === right;
}

function relevantBlockingReferences(agentContext: AgentContext, intent: WorkflowEditIntent) {
  if (!intent.filePath || intent.changeKind === "proposal" || intent.toolName === "proposePatch") return [];

  return Object.entries(agentContext.referenceChecks || {}).flatMap(([key, resolution]) => {
    const target = parseReferenceCheckKey(key);
    const relevant = isSamePath(target?.fromPath, intent.filePath) || isSamePath(resolution.resolvedPath, intent.filePath);
    return relevant && resolution.blocking ? [resolution] : [];
  });
}

function createBlock(reason: string, recommendedTools: string[], blockingReferences: ReferenceResolution[] = []): WorkflowBlockDecision {
  return { reason, blockingReferences, recommendedTools, recoverable: recommendedTools.length > 0 };
}

/**
 * 按编辑类型检查目标证据。
 * proposePatch 只生成待审核补丁，并在生成后通过虚拟文件图复核，因此不会被旧缺失状态预先锁死。
 */
export function evaluateWorkflowEditGate(input: {
  intent: WorkflowEditIntent;
  agentContext: AgentContext;
  availableTools: ReadonlySet<string>;
}): WorkflowBlockDecision | null {
  const { intent, agentContext, availableTools } = input;
  const targetRead = Boolean(intent.filePath && agentContext.filesRead.includes(intent.filePath));

  if ((intent.changeKind === "modify" || intent.changeKind === "delete") && intent.filePath && !targetRead) {
    return createBlock(
      `Before ${intent.changeKind === "delete" ? "deleting" : "modifying"} "${intent.filePath}", read the existing file.`,
      availableTools.has("readFile") ? ["readFile"] : availableTools.has("readFileChunk") ? ["readFileChunk"] : []
    );
  }

  if (intent.changeKind === "delete" && !(agentContext.impactAnalyses?.length)) {
    return createBlock(
      `Before deleting "${intent.filePath || "the target file"}", run impact analysis.`,
      availableTools.has("analyzeImpact") ? ["analyzeImpact"] : []
    );
  }

  const blockingReferences = relevantBlockingReferences(agentContext, intent);
  if (blockingReferences.length) {
    return createBlock(
      `The current edit depends on ${blockingReferences.length} unresolved reference(s).`,
      intent.toolName === "writeFile" && availableTools.has("proposePatch") ? ["proposePatch"] : [],
      blockingReferences
    );
  }

  return null;
}
