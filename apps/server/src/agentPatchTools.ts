import { createEditPatchResponse } from "./editPatchService.js";
import { applyPendingPatch } from "./patchApplyService.js";
import { buildPlannedFileGraph, checkPatchImports } from "./existenceChecker/index.js";
import { deletePendingPatch } from "./patchStore.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { config } from "./config.js";
import { recordFeatureDecisionDifference } from "./featureFlags.js";
import { parsePlannedChanges } from "./agentModificationPlanTools.js";
import { createStructuredModificationPlan, validateStructuredModificationPlan, type StructuredModificationPlan } from "./safeEditor/index.js";
import { setTaskSessionModificationPlan } from "./taskSessionStore.js";
import { executeImpactAnalysis } from "./agentTools.js";

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

/** 解析并校验 proposePatch 自带的计划；未显式传入时复用本轮已确认计划。 */
export async function resolveProposedModificationPlan(
  args: Record<string, unknown>,
  currentPlan: StructuredModificationPlan | undefined,
  workspaceRoot: string,
  taskDescription: string
) {
  if (args.plannedChanges === undefined) {
    if (!currentPlan) throw new Error("plannedChanges is required before proposePatch");
    return validateStructuredModificationPlan(workspaceRoot, currentPlan);
  }

  return validateStructuredModificationPlan(workspaceRoot, createStructuredModificationPlan({
    taskDescription,
    files: parsePlannedChanges(args.plannedChanges)
  }));
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

/** 为文件迁移失败提供可执行的恢复信息，避免模型只重复分析原始计划。 */
function buildRelocationImportRecoveryHint(
  modificationPlan: StructuredModificationPlan,
  unresolved: Awaited<ReturnType<typeof validateAgentGeneratedPatchImports>>["unresolved"]
) {
  const renamedSourceNames = new Set(
    modificationPlan.files
      .filter((file) => file.changeKind === "rename")
      .map((file) => file.filePath.split("/").at(-1)?.toLowerCase())
      .filter((fileName): fileName is string => Boolean(fileName))
  );
  const relocationTargets = unresolved
    .map(({ check }) => check.target.value.split("/").at(-1)?.toLowerCase())
    .filter((fileName): fileName is string => typeof fileName === "string")
    .filter((fileName) => renamedSourceNames.has(fileName));

  if (!relocationTargets.length) return "请修正导入路径或将缺失目标作为实际 create 补丁文件生成后再重试。";
  return "检测到文件迁移：请将每个迁移目标作为 status=create 的实际补丁文件生成，并在同一补丁中更新导入；补丁应用后再通过已审批命令删除旧文件，不要只声明 rename。";
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
        },
        plannedChanges: {
          type: "array",
          minItems: 1,
          description: "Complete file-level plan declared before candidate patch generation.",
          items: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Workspace-relative target path." },
              changeKind: { type: "string", enum: ["create", "modify", "delete", "rename", "signature"] },
              symbolName: { type: "string", description: "Optional affected symbol." },
              reason: { type: "string", description: "Non-empty reason this change is required." }
            },
            required: ["filePath", "changeKind", "reason"],
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    async execute(args, runtime) {
      const userRequest = optionalString(args, "userRequest") || runtime.agentContext.userGoal;
      const filePath = optionalString(args, "filePath");
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");
      const modificationPlan = await resolveProposedModificationPlan(
        args,
        runtime.agentContext.modificationPlan,
        workspaceRoot,
        userRequest
      );
      runtime.agentContext.modificationPlan = modificationPlan;
      await setTaskSessionModificationPlan(runtime.taskSessionId, modificationPlan);
      // 由补丁服务统一执行预检与一次性恢复，避免工具层和服务层分别重试造成循环。
      // 阶段 3：子代理运行时透传 delegationId/subagentId，标记 patch 来源。
      const subagentInfo = runtime.agentContext.isSubagent
        ? { delegationId: runtime.agentContext.subagentDelegationId, subagentId: runtime.agentContext.subagentId }
        : undefined;
      const patch = await createEditPatchResponse(
        filePath,
        userRequest,
        runtime.onAgentStep,
        runtime.taskSessionId || undefined,
        undefined,
        modificationPlan,
        {
          previousAnalyses: runtime.agentContext.impactAnalyses,
          executeImpactAnalysis: (root, targets, options) => executeImpactAnalysis(root, targets, runtime.agentContext, options)
        },
        subagentInfo
      );
      const importValidation = await validateAgentGeneratedPatchImports(workspaceRoot, patch.files);
      if (importValidation.unresolved.length) {
        deletePendingPatch(patch.patchId);
        throw new Error(
          `Generated patch contains unresolved import references: ${importValidation.unresolved
            .map(({ filePath: sourcePath, check }) => `${sourcePath}: ${check.target.value} (${check.resolution.status})`)
            .join(", ")}. ${buildRelocationImportRecoveryHint(modificationPlan, importValidation.unresolved)}`
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
        safeEditTelemetry: patch.diagnostics?.safeEditTelemetry || null,
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
        safeEdit: value.safeEdit,
        safeEditTelemetry: value.safeEditTelemetry
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
