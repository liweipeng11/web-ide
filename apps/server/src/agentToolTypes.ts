import type { AgentStep } from "./types.js";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentContext = {
  userGoal: string;
  filesRead: string[];
  searchQueries: string[];
  searchResultFiles: string[];
  relevantFiles: string[];
};

export type AgentToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AgentMessage = {
  role: AgentRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
};

export type AgentToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export type JsonSchema = Record<string, unknown>;

export type AgentToolRuntime = {
  agentContext: AgentContext;
  runId: string;
  cache: Map<string, unknown>;
  onAgentStep?: (step: AgentStep) => void;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: Record<string, unknown>, runtime: AgentToolRuntime) => Promise<unknown>;
  summarize: (result: unknown, cached: boolean, args: Record<string, unknown>) => unknown;
};

export type AgentToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

export type AgentCompletionMessage = {
  role?: "assistant";
  content?: string | null;
  tool_calls?: AgentToolCall[];
};

export type AgentCompletionResponse = {
  choices?: Array<{
    message?: AgentCompletionMessage;
  }>;
};
