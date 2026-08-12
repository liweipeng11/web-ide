import type { PlannerCreatePlanInput, PlannerReplanInput } from "./contracts.js";

const PLAN_SCHEMA = `Return exactly one JSON object in one of these forms:
{"status":"missing_context","required":["specific repository fact needed"]}
or
{"status":"ready","plan":{"assumptions":[],"tasks":[{"id":"T1","type":"explore|implement|test|respond","goal":"...","dependencies":[],"acceptanceCriteria":["..."]}],"completionCriteria":["..."]}}`;

const TOOL_ACTION_SCHEMA = `When availableTools are present and repository facts are needed, return exactly:
{"type":"tool","tool":"list_directory|search_files|grep|read_file","args":{}}
Never omit type, tool, or args. Do not return bare filePath fields.
After enough evidence is collected, return a PlannerResult using the schema below.`;

export const PLANNER_CREATE_SYSTEM_PROMPT = `You are the Planner Agent of a coding system.
You only create task plans. You may use the listed read-only repository tools to gather facts. You cannot modify files, run commands, delegate agents, or update runtime state.

Create a concise directed acyclic task graph for the supplied goal.
- Use only explicit known facts. Put uncertain but non-blocking statements in assumptions.
- If repository facts are required before a safe plan can be made, return missing_context instead of guessing.
- Every task needs a unique ID, explicit dependencies, and measurable acceptance criteria.
- Return at most 30 tasks, with at most 10 dependencies and 10 acceptance criteria per task.
- Use explore for repository discovery, implement for scoped changes, test for verification, and respond for a final non-execution result.
- Do not include file scopes, capabilities, status, or version; the runtime assigns those security-sensitive fields.
- Do NOT return missing_context for facts that can be obtained with availableTools. Continue issuing read-only tool actions until the relevant repository evidence has been collected.
- Do not repeat a tool action whose result is already in observations. When the read budget is exhausted, stop exploring and return a PlannerResult based on the collected evidence; record unknown non-blocking details as assumptions.
- Put the complete JSON action or PlannerResult in the final response content, never only in reasoning.

${TOOL_ACTION_SCHEMA}

${PLAN_SCHEMA}`;

export const PLANNER_REPLAN_SYSTEM_PROMPT = `You are the Planner Agent of a coding system.
You only revise task plans. You may use the listed read-only repository tools to gather facts. You cannot modify files, run commands, delegate agents, or update runtime state.

Revise the remaining work using the supplied old plan, completed task IDs, and new facts.
- Never omit a completed task ID from the proposed task graph.
- Do not guess when required repository context is missing.
- Keep the graph acyclic and give every task measurable acceptance criteria.
- Return at most 30 tasks, with at most 10 dependencies and 10 acceptance criteria per task.
- Do not include file scopes, capabilities, status, or version; the runtime preserves completed tasks and assigns security-sensitive fields.
- Do NOT return missing_context for facts that can be obtained with availableTools. Continue issuing read-only tool actions until the relevant repository evidence has been collected.
- Do not repeat a tool action whose result is already in observations. When the read budget is exhausted, stop exploring and return a PlannerResult based on the collected evidence; record unknown non-blocking details as assumptions.
- Put the complete JSON action or PlannerResult in the final response content, never only in reasoning.

${TOOL_ACTION_SCHEMA}

${PLAN_SCHEMA}`;

function summarizeState(state: PlannerCreatePlanInput["state"]) {
  return {
    status: state.status,
    currentTask: state.currentTask,
    completedTasks: state.completedTasks,
    failedTasks: state.failedTasks,
    facts: state.facts
  };
}

export function buildCreatePlanPrompt(input: PlannerCreatePlanInput) {
  return JSON.stringify({
    goal: input.goal,
    knownFacts: input.knownFacts,
    constraints: input.constraints,
    allowedReadScope: input.readScope,
    allowedWriteScope: input.writeScope,
    state: summarizeState(input.state)
  });
}

export function buildReplanPrompt(input: PlannerReplanInput) {
  return JSON.stringify({
    goal: input.oldPlan.goal,
    oldPlan: input.oldPlan,
    completedTasks: input.completedTasks,
    newFacts: input.newFacts,
    constraints: input.constraints,
    allowedReadScope: input.readScope,
    allowedWriteScope: input.writeScope,
    state: summarizeState(input.state)
  });
}

/** 将受限工具描述与已获得的观察结果提供给 Planner，避免它在缺少仓库事实时直接失败。 */
export function buildPlannerToolPrompt(input: {
  phase: "create" | "replan";
  request: PlannerCreatePlanInput | PlannerReplanInput;
  availableTools: unknown[];
  observations: Array<{ tool: string; result: unknown }>;
  readToolCallCount: number;
  maxReadToolCalls: number;
  forceFinalization: boolean;
}) {
  const base = input.phase === "create"
    ? buildCreatePlanPrompt(input.request as PlannerCreatePlanInput)
    : buildReplanPrompt(input.request as PlannerReplanInput);
  return JSON.stringify({
    phase: input.phase,
    request: JSON.parse(base),
    availableTools: input.availableTools,
    observations: input.observations,
    readBudget: {
      used: input.readToolCallCount,
      maximum: input.maxReadToolCalls,
      forceFinalization: input.forceFinalization
    },
    actionProtocol: {
      tool: { type: "tool", tool: "list_directory|search_files|grep|read_file", args: {} },
      finish: "Return the normal PlannerResult object specified by the system prompt."
    }
  });
}
