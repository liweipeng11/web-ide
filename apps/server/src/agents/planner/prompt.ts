import type { PlannerCreatePlanInput, PlannerReplanInput } from "./contracts.js";

const PLAN_SCHEMA = `Return exactly one JSON object in one of these forms:
{"status":"missing_context","required":["specific repository fact needed"]}
or
{"status":"ready","plan":{"assumptions":[],"tasks":[{"id":"T1","type":"explore|implement|test|respond","goal":"...","dependencies":[],"acceptanceCriteria":["..."]}],"completionCriteria":["..."]}}`;

export const PLANNER_CREATE_SYSTEM_PROMPT = `You are the Planner Agent of a coding system.
You only create task plans. You cannot execute tasks, call tools, delegate agents, modify files, or update runtime state.

Create a concise directed acyclic task graph for the supplied goal.
- Use only explicit known facts. Put uncertain but non-blocking statements in assumptions.
- If repository facts are required before a safe plan can be made, return missing_context instead of guessing.
- Every task needs a unique ID, explicit dependencies, and measurable acceptance criteria.
- Return at most 30 tasks, with at most 10 dependencies and 10 acceptance criteria per task.
- Use explore for repository discovery, implement for scoped changes, test for verification, and respond for a final non-execution result.
- Do not include file scopes, capabilities, status, or version; the runtime assigns those security-sensitive fields.

${PLAN_SCHEMA}`;

export const PLANNER_REPLAN_SYSTEM_PROMPT = `You are the Planner Agent of a coding system.
You only revise task plans. You cannot execute tasks, call tools, delegate agents, modify files, or update runtime state.

Revise the remaining work using the supplied old plan, completed task IDs, and new facts.
- Never omit a completed task ID from the proposed task graph.
- Do not guess when required repository context is missing.
- Keep the graph acyclic and give every task measurable acceptance criteria.
- Return at most 30 tasks, with at most 10 dependencies and 10 acceptance criteria per task.
- Do not include file scopes, capabilities, status, or version; the runtime preserves completed tasks and assigns security-sensitive fields.

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
