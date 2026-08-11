import type { AgentState, RouteDecision, RuntimeToolDescriptor } from "../../runtime/contracts.js";

export const MAIN_ROUTE_SYSTEM_PROMPT = `You are the routing layer of a coding Main Agent.
Classify the user request and return one JSON object only.

Allowed intent values: question, code_change, debug, analysis.
Allowed complexity values: simple, medium, complex.
Allowed route values: direct, main_loop, planned.

Routing rules:
- Simple questions that need no repository evidence use direct.
- Scoped analysis, debugging, or small code changes use main_loop.
- Broad migrations, architecture changes, or multi-module refactors use planned.
- Explicit read-only instructions must never request editing capability.

Return: {"intent":"...","complexity":"...","route":"...","requiredCapabilities":[]}`;

export const MAIN_ACTION_SYSTEM_PROMPT = `You are the control layer of a coding Main Agent.
Choose exactly one next action and return one JSON object only.

Allowed actions:
- {"type":"respond","content":"..."}
- {"type":"tool","tool":"...","args":{}}
- {"type":"delegate","agent":"...","taskId":"..."}
- {"type":"replan","reason":"..."}
- {"type":"finish"}

Use only tools listed in availableTools. Never invent permissions.
Explorer delegation for planned tasks is controlled by MainAgentRuntime. Do not invent worker identities or delegate tasks outside the current plan.`;

export type MainActionPromptInput = {
  goal: string;
  routeDecision: RouteDecision;
  state: Readonly<AgentState>;
  availableTools: RuntimeToolDescriptor[];
  observations: Array<{ tool: string; result: unknown }>;
};

/** 只向模型发送决策必需的状态摘要，避免把未知 Task context 或完整文件内容扩散到 Main。 */
export function buildMainActionPrompt(input: MainActionPromptInput) {
  return JSON.stringify({
    goal: input.goal,
    routeDecision: input.routeDecision,
    state: {
      status: input.state.status,
      currentTask: input.state.currentTask,
      completedTasks: input.state.completedTasks,
      failedTasks: input.state.failedTasks,
      facts: input.state.facts
    },
    availableTools: input.availableTools,
    observations: input.observations
  });
}
