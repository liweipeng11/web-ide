import type { AgentToolDefinition, AgentToolSchema } from "./agentToolTypes.js";

export type AgentToolRegistry = {
  definitions: AgentToolDefinition[];
  schemas: AgentToolSchema[];
  get: (toolName: string) => AgentToolDefinition | undefined;
};

/**
 * 创建工具注册中心，统一管理模型可见 schema 和服务端真实执行器。
 */
export function createAgentToolRegistry(definitions: AgentToolDefinition[]): AgentToolRegistry {
  const registry = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    definitions,
    schemas: definitions.map((definition) => ({
      type: "function" as const,
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters
      }
    })),
    get(toolName) {
      return registry.get(toolName);
    }
  };
}
