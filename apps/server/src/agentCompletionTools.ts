import type { AgentToolDefinition } from "./agentToolTypes.js";

export type CompleteTaskInput = {
  summary: string;
  verified: boolean;
  validationSummary?: string;
  unresolvedItems?: string[];
};

export type CompleteTaskRequest = CompleteTaskInput & {
  completionRequested: true;
};

function optionalString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string when provided`);
  }
  return value.trim();
}

/**
 * 校验模型提交的完成声明。这里只验证协议形状，是否真正完成仍由 Runtime 的证据策略裁决。
 */
export function parseCompleteTaskInput(args: Record<string, unknown>): CompleteTaskInput {
  if (typeof args.summary !== "string" || !args.summary.trim()) {
    throw new Error("summary is required and must be a non-empty string");
  }
  if (typeof args.verified !== "boolean") {
    throw new Error("verified is required and must be a boolean");
  }

  let unresolvedItems: string[] | undefined;
  if (args.unresolvedItems !== undefined) {
    if (!Array.isArray(args.unresolvedItems) || args.unresolvedItems.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("unresolvedItems must be an array of non-empty strings when provided");
    }
    unresolvedItems = args.unresolvedItems.map((item) => (item as string).trim());
  }

  return {
    summary: args.summary.trim(),
    verified: args.verified,
    validationSummary: optionalString(args, "validationSummary"),
    unresolvedItems
  };
}

export const completionAgentToolDefinitions: AgentToolDefinition[] = [
  {
    name: "completeTask",
    description: "Request task completion after all work and validation are finished. This call must be the only tool call in the assistant response.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          description: "Concise summary of the completed work."
        },
        verified: {
          type: "boolean",
          description: "Whether the task was validated with the available evidence."
        },
        validationSummary: {
          type: "string",
          minLength: 1,
          description: "Optional summary of validation commands or other checks."
        },
        unresolvedItems: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Remaining blockers or incomplete items, if any."
        }
      },
      required: ["summary", "verified"],
      additionalProperties: false
    },
    cacheable: false,
    async execute(args) {
      // 工具只表达“请求结束”，不能绕过 Runtime 直接写入 completed/success 状态。
      return { completionRequested: true, ...parseCompleteTaskInput(args) } satisfies CompleteTaskRequest;
    },
    summarize(result) {
      const value = result as Partial<CompleteTaskRequest>;
      return {
        completionRequested: value.completionRequested === true,
        verified: value.verified === true,
        unresolvedItemCount: value.unresolvedItems?.length ?? 0
      };
    }
  }
];

export const completeTaskToolDefinition = completionAgentToolDefinitions[0];
