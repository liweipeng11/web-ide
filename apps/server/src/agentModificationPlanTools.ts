import type { AgentToolDefinition } from "./agentToolTypes.js";
import { createStructuredModificationPlan, validateStructuredModificationPlan, type StructuredModificationPlanFile } from "./safeEditor/index.js";
import { setTaskSessionModificationPlan } from "./taskSessionStore.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

export function parsePlannedChanges(value: unknown): StructuredModificationPlanFile[] {
  if (!Array.isArray(value)) throw new Error("files must be an array");

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("files contains an invalid item");
    const file = item as Record<string, unknown>;
    const validKinds = new Set(["create", "modify", "delete", "rename", "signature"]);
    if (typeof file.filePath !== "string" || typeof file.changeKind !== "string" || !validKinds.has(file.changeKind)
      || typeof file.reason !== "string") {
      throw new Error("Each planned file requires filePath, changeKind, and reason");
    }
    return {
      filePath: file.filePath,
      changeKind: file.changeKind as StructuredModificationPlanFile["changeKind"],
      ...(typeof file.symbolName === "string" ? { symbolName: file.symbolName } : {}),
      reason: file.reason,
      ...(typeof file.responsibility === "string" ? { responsibility: file.responsibility } : {})
    };
  });
}

export const modificationPlanAgentToolDefinitions: AgentToolDefinition[] = [
  {
    name: "planFileChanges",
    description: "Declare the complete structured file modification plan before generating or applying edits. This records paths, change kinds, responsibilities, and reasons without writing workspace files.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        taskDescription: { type: "string", description: "Focused description of the change this plan implements." },
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Workspace-relative file path." },
              changeKind: { type: "string", enum: ["create", "modify", "delete", "rename", "signature"] },
              symbolName: { type: "string", description: "Optional symbol affected by a signature-level change." },
              responsibility: { type: "string", description: "Optional description of the file's responsibility in this change." },
              reason: { type: "string", description: "Why this file must change." }
            },
            required: ["filePath", "changeKind", "reason"],
            additionalProperties: false
          }
        }
      },
      required: ["taskDescription", "files"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");
      const plan = await validateStructuredModificationPlan(workspaceRoot, createStructuredModificationPlan({
        taskDescription: typeof args.taskDescription === "string" ? args.taskDescription : "",
        files: parsePlannedChanges(args.files)
      }));
      runtime.agentContext.modificationPlan = plan;
      await setTaskSessionModificationPlan(runtime.taskSessionId, plan);
      return plan;
    },
    summarize(result) {
      const plan = result as ReturnType<typeof createStructuredModificationPlan>;
      return {
        planId: plan.id,
        taskDescription: plan.taskDescription,
        files: plan.files.map((file) => ({ filePath: file.filePath, changeKind: file.changeKind, responsibility: file.responsibility }))
      };
    }
  }
];
