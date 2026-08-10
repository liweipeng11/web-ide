import crypto from "node:crypto";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import type { AgentToolDefinition, AgentToolRuntime } from "../agentToolTypes.js";
import { executeAgentToolCall } from "../agentTools.js";
import type { RuntimeTool, RuntimeToolEffect, RuntimeToolExecutionContext } from "./contracts.js";

export type LegacyToolAdapterOptions = {
  effect: RuntimeToolEffect;
  getTargetPaths?: (args: Record<string, unknown>) => string[];
  getChangedFiles?: (args: Record<string, unknown>, result: unknown) => string[];
  createRuntime: (context: RuntimeToolExecutionContext) => AgentToolRuntime | Promise<AgentToolRuntime>;
};

function parseLegacyToolResult(content: string, toolName: string) {
  try {
    const result = JSON.parse(content) as unknown;
    if (result && typeof result === "object" && !Array.isArray(result) && typeof (result as Record<string, unknown>).error === "string") {
      throw new Error(String((result as Record<string, unknown>).error));
    }
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`旧工具 ${toolName} 返回了无效 JSON。`);
    }
    throw error;
  }
}

/**
 * 将现有 AgentToolDefinition 接入新 Runtime。
 * 副作用和目标路径必须由调用方显式声明，避免通过工具名称猜测安全属性。
 */
export function adaptLegacyAgentTool(definition: AgentToolDefinition, options: LegacyToolAdapterOptions): RuntimeTool {
  const registry = createAgentToolRegistry([definition]);

  return {
    name: definition.name,
    description: definition.description,
    effect: options.effect,
    inputSchema: definition.parameters,
    getTargetPaths: options.getTargetPaths,
    getChangedFiles: options.getChangedFiles,
    async execute(args, context) {
      const runtime = await options.createRuntime(context);
      const adaptedRuntime = { ...runtime, registry };
      const result = await executeAgentToolCall({
        id: `runtime-kernel-${crypto.randomUUID()}`,
        type: "function",
        function: {
          name: definition.name,
          arguments: JSON.stringify(args)
        }
      }, adaptedRuntime);

      return parseLegacyToolResult(result.content, definition.name);
    }
  };
}
