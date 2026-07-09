import { commandAgentToolDefinitions } from "./agentCommandTools.js";
import { fileEditToolDefinitions } from "./fileEditTools.js";
import { patchAgentToolDefinitions } from "./agentPatchTools.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import { readonlyAgentToolDefinitions } from "./agentTools.js";

// 连续 Agent Runtime 使用完整工具集；旧编辑链路仍通过 agentTools.ts 暴露只读 schema。
export const runtimeAgentToolRegistry = createAgentToolRegistry([
  ...readonlyAgentToolDefinitions,
  ...fileEditToolDefinitions,
  ...patchAgentToolDefinitions,
  ...commandAgentToolDefinitions
]);
