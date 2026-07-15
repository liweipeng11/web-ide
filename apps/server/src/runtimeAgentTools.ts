import { commandAgentToolDefinitions } from "./agentCommandTools.js";
import { fileEditToolDefinitions } from "./fileEditTools.js";
import { patchAgentToolDefinitions } from "./agentPatchTools.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import { readonlyAgentToolDefinitions } from "./agentTools.js";
import { externalBrowserAgentToolDefinitions } from "./externalContext/index.js";

// 连续 Agent Runtime 使用完整工具集；patch 工具优先，保证常规修改先进入 diff 审核。
export const runtimeAgentToolRegistry = createAgentToolRegistry([
  ...readonlyAgentToolDefinitions,
  ...externalBrowserAgentToolDefinitions,
  ...patchAgentToolDefinitions,
  ...fileEditToolDefinitions,
  ...commandAgentToolDefinitions
]);
