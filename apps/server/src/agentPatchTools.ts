import { createEditPatchResponse } from "./editPatchService.js";
import { applyPendingPatch } from "./patchApplyService.js";
import { checkCodeImports } from "./existenceChecker/index.js";
import { deletePendingPatch } from "./patchStore.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

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
        }
      },
      additionalProperties: false
    },
    async execute(args, runtime) {
      const userRequest = optionalString(args, "userRequest") || runtime.agentContext.userGoal;
      const filePath = optionalString(args, "filePath");
      const patch = await createEditPatchResponse(filePath, userRequest, runtime.onAgentStep, runtime.taskSessionId || undefined);
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");
      const importChecks = await Promise.all(patch.files.map((file) => checkCodeImports(workspaceRoot, file.newContent, file.path)));
      const unresolved = importChecks.flatMap(({ result }) => result.checks).filter((check) => check.status !== "exists");
      if (unresolved.length) {
        deletePendingPatch(patch.patchId);
        throw new Error(`Generated patch contains unresolved import references: ${unresolved.map((check) => `${check.target.value} (${check.status})`).join(", ")}`);
      }
      runtime.generatedPatchIds?.push(patch.patchId);

      // ????????????? HTML diff ??????????????
      return {
        patchId: patch.patchId,
        summary: patch.summary,
        files: patch.files.map((file) => ({ path: file.path, status: file.status, summary: file.summary })),
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
        files
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
        }
      },
      required: ["patchId"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      return applyPendingPatch({
        patchId: requiredString(args, "patchId"),
        filePath: optionalString(args, "filePath"),
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
