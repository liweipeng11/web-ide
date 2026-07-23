export type AgentBudgetPolicy = {
  maxSteps: number;
  convergenceRemainingSteps: number;
  forceFinalRemainingSteps: number;
};

export type AgentBudgetPhase = "normal" | "convergence" | "force_final";

export const DEFAULT_AGENT_BUDGET_POLICY: AgentBudgetPolicy = {
  maxSteps: 24,
  convergenceRemainingSteps: 3,
  forceFinalRemainingSteps: 1
};

const CONVERGENCE_BLOCKED_TOOL_NAMES = new Set([
  "searchFilesByName",
  "searchCode",
  "searchCodeRegex",
  "searchWeb",
  "searchOfficialDocs",
  "fetchApiDocs",
  "browseWebPage",
  "automateBrowser"
]);

function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const rawValue = env[name];
  if (rawValue === undefined || rawValue.trim() === "") return fallback;

  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isValidPolicy(policy: AgentBudgetPolicy) {
  return policy.maxSteps > policy.convergenceRemainingSteps
    && policy.convergenceRemainingSteps > policy.forceFinalRemainingSteps
    && policy.forceFinalRemainingSteps >= 1;
}

/**
 * 读取生产环境预算配置。任一数值或阈值关系非法时整体回退，避免部署后出现没有最终回答轮次的配置。
 */
export function resolveAgentBudgetPolicy(env: NodeJS.ProcessEnv = process.env): AgentBudgetPolicy {
  const policy = {
    maxSteps: readPositiveInteger(env, "AI_AGENT_MAX_STEPS", DEFAULT_AGENT_BUDGET_POLICY.maxSteps),
    convergenceRemainingSteps: readPositiveInteger(
      env,
      "AI_AGENT_CONVERGENCE_REMAINING_STEPS",
      DEFAULT_AGENT_BUDGET_POLICY.convergenceRemainingSteps
    ),
    forceFinalRemainingSteps: readPositiveInteger(
      env,
      "AI_AGENT_FORCE_FINAL_REMAINING_STEPS",
      DEFAULT_AGENT_BUDGET_POLICY.forceFinalRemainingSteps
    )
  };

  return isValidPolicy(policy) ? policy : { ...DEFAULT_AGENT_BUDGET_POLICY };
}

/**
 * 测试和受控调用可以覆盖总步数。小于 3 步时无法形成严格三区间，因此保留最终轮并压缩收敛区间。
 */
export function normalizeRuntimeAgentBudgetPolicy(policy: AgentBudgetPolicy): AgentBudgetPolicy {
  if (isValidPolicy(policy)) return policy;

  const maxSteps = Number.isInteger(policy.maxSteps) && policy.maxSteps > 0
    ? policy.maxSteps
    : DEFAULT_AGENT_BUDGET_POLICY.maxSteps;
  if (maxSteps < 3) {
    return { maxSteps, convergenceRemainingSteps: 1, forceFinalRemainingSteps: 1 };
  }

  const forceFinalRemainingSteps = Math.min(
    Math.max(1, policy.forceFinalRemainingSteps),
    maxSteps - 2
  );
  const convergenceRemainingSteps = Math.max(
    forceFinalRemainingSteps + 1,
    Math.min(policy.convergenceRemainingSteps, maxSteps - 1)
  );

  return { maxSteps, convergenceRemainingSteps, forceFinalRemainingSteps };
}

export function getAgentBudgetPhase(
  remainingSteps: number,
  policy: AgentBudgetPolicy
): AgentBudgetPhase {
  if (remainingSteps <= policy.forceFinalRemainingSteps) return "force_final";
  if (remainingSteps <= policy.convergenceRemainingSteps) return "convergence";
  return "normal";
}

export function isToolAvailableInBudgetPhase(toolName: string, phase: AgentBudgetPhase) {
  if (phase === "force_final") return false;
  return phase === "normal" || !CONVERGENCE_BLOCKED_TOOL_NAMES.has(toolName);
}

export function filterToolSchemasForBudgetPhase<T extends { function: { name: string } }>(
  schemas: T[],
  phase: AgentBudgetPhase
) {
  return schemas.filter((schema) => isToolAvailableInBudgetPhase(schema.function.name, phase));
}
