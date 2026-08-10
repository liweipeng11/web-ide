import { readonlyAgentToolDefinitions } from "../agentTools.js";
import { patchAgentToolDefinitions } from "../agentPatchTools.js";
import { modificationPlanAgentToolDefinitions } from "../agentModificationPlanTools.js";
import { createAgentToolRegistry, type AgentToolRegistry } from "../agentToolRegistry.js";
import type { AgentToolDefinition } from "../agentToolTypes.js";

// 阶段 2：analysis 子代理只允许只读工具和分析工具，不允许任何写盘/补丁/命令工具。
// 白名单取自 readonlyAgentToolDefinitions，但进一步剔除 modificationPlan 相关工具
// （子代理不做文件级计划，只产出分析结论），以及 recoverContextArtifact（子代理无独立 task session 写入）。
const ANALYSIS_SUBAGENT_TOOL_WHITELIST = new Set<string>([
  "listFiles",
  "searchFilesByName",
  "listCodeDefinitionNames",
  "searchCode",
  "searchCodeRegex",
  "readFile",
  "readFileChunk",
  "readFileRange",
  "analyzeImpact",
  "analyzeSymbolGraph",
  "checkExistence",
  "findSimilarPatterns",
  "inspectProject"
]);

/**
 * 创建 analysis 子代理受限工具 registry。
 * 只暴露只读发现和分析工具，确保子代理不能写盘、不能生成补丁、不能运行命令。
 */
export function createAnalysisSubagentRegistry(): AgentToolRegistry {
  const definitions: AgentToolDefinition[] = readonlyAgentToolDefinitions.filter(
    (definition) => ANALYSIS_SUBAGENT_TOOL_WHITELIST.has(definition.name)
  );
  return createAgentToolRegistry(definitions);
}

/** 导出白名单，供委派工具在运行前校验 scope.allowedTools。 */
export function getAnalysisSubagentAllowedTools(): string[] {
  return [...ANALYSIS_SUBAGENT_TOOL_WHITELIST];
}

// 阶段 3：implementation 子代理工具白名单。
// 包含 analysis 的全部只读工具 + proposePatch（可产出 reviewable patch），
// 但禁止 applyPatch、deleteFile、高风险命令和 completion 工具。
const IMPLEMENTATION_SUBAGENT_TOOL_WHITELIST = new Set<string>([
  ...ANALYSIS_SUBAGENT_TOOL_WHITELIST,
  // 阶段 3：子代理可生成 reviewable patch，但禁止 applyPatch。
  "proposePatch"
]);

/**
 * 创建 implementation 子代理受限工具 registry。
 * 只读发现 + proposePatch，禁止 applyPatch/deleteFile/命令/completion。
 */
export function createImplementationSubagentRegistry(): AgentToolRegistry {
  const readonlyDefinitions = readonlyAgentToolDefinitions.filter(
    (definition) => IMPLEMENTATION_SUBAGENT_TOOL_WHITELIST.has(definition.name)
  );
  const proposePatchDef = patchAgentToolDefinitions.find(
    (definition) => definition.name === "proposePatch"
  );
  const definitions = proposePatchDef ? [...readonlyDefinitions, proposePatchDef] : readonlyDefinitions;
  return createAgentToolRegistry(definitions);
}

/** 导出 implementation 子代理白名单，供委派工具校验 scope.allowedToolNames。 */
export function getImplementationSubagentAllowedTools(): string[] {
  return [...IMPLEMENTATION_SUBAGENT_TOOL_WHITELIST];
}

// 新增：planning 子代理工具白名单。
// 包含全部只读工具 + planFileChanges（声明修改计划），但不含任何编辑/补丁/命令工具。
// 子代理负责调研代码库并产出结构化修改计划，父代理按计划执行编辑。
const PLANNING_SUBAGENT_TOOL_WHITELIST = new Set<string>([
  ...ANALYSIS_SUBAGENT_TOOL_WHITELIST,
  "planFileChanges"
]);

/**
 * 创建 planning 子代理受限工具 registry。
 * 只读发现 + planFileChanges，禁止编辑/补丁/命令/completion。
 */
export function createPlanningSubagentRegistry(): AgentToolRegistry {
  const readonlyDefinitions = readonlyAgentToolDefinitions.filter(
    (definition) => PLANNING_SUBAGENT_TOOL_WHITELIST.has(definition.name)
  );
  const planDef = modificationPlanAgentToolDefinitions.find(
    (definition) => definition.name === "planFileChanges"
  );
  const definitions = planDef ? [...readonlyDefinitions, planDef] : readonlyDefinitions;
  return createAgentToolRegistry(definitions);
}

/** 导出 planning 子代理白名单，供委派工具校验 scope.allowedToolNames。 */
export function getPlanningSubagentAllowedTools(): string[] {
  return [...PLANNING_SUBAGENT_TOOL_WHITELIST];
}
