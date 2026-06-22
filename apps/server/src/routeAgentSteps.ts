import type { AgentStep } from "./aiClient.js";
import type { CommandPolicyResult, CommandResult } from "./types.js";

export type AgentStepPayload =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "tool_call";
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      toolName: string;
      output: unknown;
    }
  | {
      type: "edit";
      files: string[];
    }
  | {
      type: "command";
      command: string;
      policy?: CommandPolicyResult;
      status?: "suggested" | "running" | "success" | "failed" | "blocked" | "cancelled";
      result?: CommandResult | null;
    }
  | {
      type: "error";
      message: string;
    };

export function createAgentStep(step: AgentStepPayload): AgentStep {
  return {
    id: `${step.type}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    ...step
  };
}
