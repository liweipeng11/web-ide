import { createEditPatchResponse } from "./editPatchService.js";
import { applyPendingPatch } from "./patchApplyService.js";
import { buildPlannedFileGraph, checkPatchImports } from "./existenceChecker/index.js";
import { deletePendingPatch } from "./patchStore.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { buildSafeEditRecommendation } from "./safeEditor/index.js";
import { config } from "./config.js";
import { recordFeatureDecisionDifference } from "./featureFlags.js";

function optionalString(args: Record<string, unknown>, name: string) {
  return typeof args[name] === "string" && args[name].trim() ? args[name].trim() : null;
}

function requiredString(args: Record<string, unknown>, name: string) {
  const value = optionalString(args, name);

  if (!value) {
    throw new Error(name + " is required");
  }

  return value;
}

/** Agent 层复用补丁后文件图进行最终复核，避免再次按纯磁盘状态误判新文件。 */
export async function validateAgentGeneratedPatchImports(
  workspaceRoot: string,
  files: Parameters<typeof checkPatchImports>[1]
) {
  const plannedFileGraph = await buildPlannedFileGraph(
    workspaceRoot,
      files.map((file) => ({ filePath: file.path, changeKind: file.status, content: file.newContent }))
  );
  const [legacyValidation, plannedValidation] = await Promise.all([
    checkPatchImports(workspaceRoot, files),
    checkPatchImports(workspaceRoot, files, plannedFileGraph)
  ]);
  recordFeatureDecisionDifference({
    feature: "plannedFileResolution",
    legacyDecision: { unresolvedCount: legacyValidation.unresolved.length },
    nextDecision: { unresolvedCount: plannedValidation.unresolved.length }
  });
  return config.featureFlags.plannedFileResolution ? plannedValidation : legacyValidation;
}

export const patchAgentToolDefinitions: AgentToolDefinition[] = [
  {
    name: "proposePatch",
    description: "Generate a reviewable pending patch for the requested code change. This does not write files; it creates a patchId that can be reviewed and later applied.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        userRequest: {
          type: "string",
          description: "Focused code-change instruction. If omitted, the current user goal is used."
        },
        filePath: {
          type: "string",
          description: "Optional workspace-relative file path to use as selected context."
        },
        changeKind: {
          type: "string",
          enum: ["create", "modify", "delete"],
          description: "Optional declared edit type used by the workflow gate. The generated patch is still validated independently."
        }
      },
      additionalProperties: false
    },
    async execute(args, runtime) {
      const userRequest = optionalString(args, "userRequest") || runtime.agentContext.userGoal;
      const filePath = optionalString(args, "filePath");
      const outerImpactAnalysis = runtime.agentContext.impactAnalyses?.at(-1);
      const safeEditRecommendation = outerImpactAnalysis
        ? buildSafeEditRecommendation({ impactAnalysis: outerImpactAnalysis, fallbackTargetFiles: filePath ? [filePath] : [], editableScopeFiles: runtime.agentContext.filesRead })
        : undefined;
      const patch = await createEditPatchResponse(filePath, userRequest, runtime.onAgentStep, runtime.taskSessionId || undefined, safeEditRecommendation);
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");
      const importValidation = await validateAgentGeneratedPatchImports(workspaceRoot, patch.files);
      if (importValidation.unresolved.length) {
        deletePendingPatch(patch.patchId);
        throw new Error(
          `Generated patch contains unresolved import references: ${importValidation.unresolved
            .map(({ filePath: sourcePath, check }) => `${sourcePath}: ${check.target.value} (${check.resolution.status})`)
            .join(", ")}`
        );
      }
      runtime.generatedPatchIds?.push(patch.patchId);

      // 工具结果仅返回结构化摘要，避免把完整 HTML diff 重复注入模型上下文。
      return {
        patchId: patch.patchId,
        summary: patch.summary,
        files: patch.files.map((file) => ({ path: file.path, status: file.status, summary: file.summary })),
        safeEdit: patch.diagnostics?.safeEditReport
          ? { status: patch.diagnostics.safeEditReport.status, risks: patch.diagnostics.safeEditReport.risks, expansionFiles: patch.diagnostics.safeEditReport.expansionFiles }
          : null,
        commandsToRun: patch.commandsToRun || []
      };
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
      const files = Array.isArray(value.files) ? value.files : [];

      return {
        cached,
        patchId: value.patchId,
        summary: value.summary,
        fileCount: files.length,
        files,
        safeEdit: value.safeEdit
      };
    }
  },
  {
    name: "applyPatch",
    description: "Apply a previously generated pending patch by patchId after user approval. Optionally apply only one file from the patch.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        patchId: {
          type: "string",
          description: "Pending patch id returned by proposePatch."
        },
        filePath: {
          type: "string",
          description: "Optional workspace-relative file path to apply from the patch."
        },
        acknowledgeSafeEditRisk: {
          type: "boolean",
          description: "Set true only after the user approves applying a patch whose Safe Editor status is high_risk."
        }
      },
      required: ["patchId"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      return applyPendingPatch({
        patchId: requiredString(args, "patchId"),
        filePath: optionalString(args, "filePath"),
        // Agent Runtime 的 applyPatch 始终经过人工审批，已批准的 actionId 本身就是高风险确认凭据。
        acknowledgeSafeEditRisk: args.acknowledgeSafeEditRisk === true || Boolean(runtime.currentToolCall?.actionId),
        onAgentStep: runtime.onAgentStep,
        source: {
          taskSessionId: runtime.taskSessionId || null,
          toolCallId: runtime.currentToolCall?.id || null,
          toolName: runtime.currentToolCall?.name || "applyPatch",
          actionId: runtime.currentToolCall?.actionId || null,
          reason: "agent_apply_patch"
        }
      });
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
      const checkpoint = value.checkpoint && typeof value.checkpoint === "object" && !Array.isArray(value.checkpoint) ? (value.checkpoint as Record<string, unknown>) : null;

      return {
        cached,
        patchId: value.patchId,
        files: value.files,
        checkpointId: checkpoint?.id
      };
    }
  }
];
