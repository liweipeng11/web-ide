import type { AgentContext } from "../agentToolTypes.js";
import type {
  TaskWorkflowDecision,
  TaskWorkflowDecisionPolicy,
  TaskWorkflowEvidence,
  TaskWorkflowEvidenceState,
  TaskWorkflowSnapshot,
  TaskWorkflowType
} from "./types.js";
import { evaluateWorkflowEditGate, resolveWorkflowEditIntent } from "./editGate.js";
import { decideImpactPreflight } from "../safeEditor/impactPreflight.js";

const editingTools = new Set(["proposePatch", "replaceInFile", "writeFile", "deleteFile", "applyPatch"]);
const sideEffectTools = new Set([...editingTools, "runCommand", "automateBrowser"]);

const decisionPolicies: Record<TaskWorkflowType, TaskWorkflowDecisionPolicy> = {
  bugfix: {
    mutationAllowed: true,
    commandAllowed: true,
    requiredBeforeEdit: ["workspace_read", "pattern_search", "pattern_candidate_read", "existence_check", "references_resolved", "command_attempt"],
    runtimeRules: [
      "Collect concrete failure evidence and attempt reproduction before editing.",
      "State the root cause supported by evidence, then make the smallest repair.",
      "Add or update a regression test when the project has a test pattern, and report focused validation."
    ]
  },
  feature: {
    mutationAllowed: true,
    commandAllowed: true,
    requiredBeforeEdit: ["workspace_read", "pattern_search", "pattern_candidate_read", "existence_check", "references_resolved"],
    runtimeRules: [
      "Inspect the project and a relevant existing pattern before editing.",
      "Confirm the smallest file plan, implement only that scope, then validate it.",
      "Finish with a concise change summary and distinguish completed validation from suggested validation."
    ]
  },
  refactor: {
    mutationAllowed: true,
    commandAllowed: true,
    requiredBeforeEdit: ["workspace_read", "pattern_search", "pattern_candidate_read", "existence_check", "references_resolved", "impact_analysis"],
    runtimeRules: [
      "Establish the current behavior baseline and preserve external contracts.",
      "Run impact analysis before editing shared or multi-file behavior.",
      "Keep behavior unchanged and finish with focused regression validation."
    ]
  },
  "analysis-only": {
    mutationAllowed: false,
    commandAllowed: false,
    requiredBeforeEdit: [],
    runtimeRules: [
      "Use read-only inspection tools only.",
      "Do not generate or apply patches, edit or delete files, run commands, or automate a browser.",
      "Report evidence, conclusions, uncertainty, and optional next actions without changing state."
    ]
  }
};

const evidenceToolRecommendations: Record<TaskWorkflowEvidence, string[]> = {
  workspace_read: ["readFile", "readFileChunk"],
  pattern_search: ["findSimilarPatterns"],
  pattern_candidate_read: ["readFile"],
  existence_check: ["checkExistence"],
  references_resolved: ["checkExistence"],
  impact_analysis: ["analyzeImpact"],
  command_attempt: ["runCommand"]
};

export function getTaskWorkflowDecisionPolicy(type: TaskWorkflowType): TaskWorkflowDecisionPolicy {
  const policy = decisionPolicies[type];
  return {
    ...policy,
    requiredBeforeEdit: [...policy.requiredBeforeEdit],
    runtimeRules: [...policy.runtimeRules]
  };
}

export function resolveTaskWorkflowDecisionPolicy(workflow: TaskWorkflowSnapshot): TaskWorkflowDecisionPolicy {
  const policy = getTaskWorkflowDecisionPolicy(workflow.type);
  if (!workflow.authorization) return policy;
  const commandAllowed = policy.commandAllowed && workflow.authorization.commandExecution;
  return {
    ...policy,
    mutationAllowed: policy.mutationAllowed && workflow.authorization.workspaceMutation,
    commandAllowed,
    // 用户明确禁止命令时，不保留无法满足的复现命令前置条件。
    requiredBeforeEdit: commandAllowed
      ? policy.requiredBeforeEdit
      : policy.requiredBeforeEdit.filter((evidence) => evidence !== "command_attempt")
  };
}

/**
 * 将 Runtime 已收集的事实归一化为工作流证据，Prompt 与硬门禁共同复用。
 */
export function collectTaskWorkflowEvidence(agentContext: AgentContext): TaskWorkflowEvidenceState {
  const candidates = agentContext.patternCandidateFiles || [];
  const preflight = agentContext.modificationPlan
    ? decideImpactPreflight(agentContext.modificationPlan, agentContext.impactAnalyses)
    : null;
  return {
    workspaceRead: agentContext.filesRead.length > 0,
    patternSearch: agentContext.patternSearchPerformed === true,
    patternCandidateRead: agentContext.patternSearchPerformed === true
      && (candidates.length === 0 || candidates.some((filePath) => agentContext.filesRead.includes(filePath))),
    existenceCheck: agentContext.existenceCheckPerformed === true,
    // 结构化状态由编辑门禁按目标过滤；只有历史上下文才继续使用全局字符串结论。
    referencesResolved: agentContext.existenceCheckPerformed === true
      && (agentContext.referenceChecks !== undefined || !(agentContext.unresolvedExistenceChecks?.length)),
    // 有结构化计划时只接受覆盖当前目标且未过期的分析，避免无关旧结果误放行。
    impactAnalysis: preflight?.required
      ? preflight.strategy === "reuse"
      : Boolean(agentContext.impactAnalyses?.length),
    commandAttempt: Boolean(agentContext.commandsRun?.length)
  };
}

function resolveRequiredEvidence(policy: TaskWorkflowDecisionPolicy, agentContext: AgentContext) {
  if (!agentContext.modificationPlan) return policy.requiredBeforeEdit;
  const preflight = decideImpactPreflight(agentContext.modificationPlan, agentContext.impactAnalyses);
  return preflight.required
    ? [...new Set([...policy.requiredBeforeEdit, "impact_analysis" as const])]
    : policy.requiredBeforeEdit;
}

function hasEvidence(evidence: TaskWorkflowEvidence, state: TaskWorkflowEvidenceState, availableTools: ReadonlySet<string>) {
  // 工具未注册时不制造无法满足的前置条件，兼容受控评测和精简工具注册表。
  if (evidence === "pattern_search" && !availableTools.has("findSimilarPatterns")) return true;
  if (evidence === "pattern_candidate_read" && !availableTools.has("findSimilarPatterns")) return true;
  if ((evidence === "existence_check" || evidence === "references_resolved") && !availableTools.has("checkExistence")) return true;

  const values: Record<TaskWorkflowEvidence, boolean> = {
    workspace_read: state.workspaceRead,
    pattern_search: state.patternSearch,
    pattern_candidate_read: state.patternCandidateRead,
    existence_check: state.existenceCheck,
    references_resolved: state.referencesResolved,
    impact_analysis: state.impactAnalysis,
    command_attempt: state.commandAttempt
  };
  return values[evidence];
}

function formatBlockReason(workflow: TaskWorkflowSnapshot, missing: TaskWorkflowEvidence[]) {
  if (missing.includes("workspace_read") && workflow.type === "bugfix") {
    return "Bugfix workflow requires reading failure-related code or evidence before editing.";
  }
  if (missing.includes("command_attempt") && workflow.type === "bugfix") {
    return "Bugfix workflow requires a reproduction or validation command attempt before editing.";
  }
  if (missing.includes("impact_analysis") && workflow.type === "refactor") {
    return "Refactor workflow requires analyzeImpact evidence before editing.";
  }
  if (missing.includes("pattern_search")) {
    return "Before editing, call findSimilarPatterns to inspect existing implementation patterns.";
  }
  if (missing.includes("pattern_candidate_read")) {
    return "findSimilarPatterns returned candidate files. Read at least one candidate with readFile before editing.";
  }
  if (missing.includes("existence_check")) {
    return "Before editing, call checkExistence to verify referenced imports, symbols, scripts, or directories.";
  }
  if (missing.includes("references_resolved")) {
    return "Resolve missing or ambiguous references before editing.";
  }
  return `Task workflow ${workflow.type} is missing required evidence: ${missing.join(", ")}.`;
}

function recommendEvidenceTools(missingEvidence: TaskWorkflowEvidence[], availableTools: ReadonlySet<string>) {
  return [...new Set(
    missingEvidence
      // 先完成模式检索，再根据真实候选决定是否读取，避免提前推荐无目标 readFile。
      .filter((evidence) => evidence !== "pattern_candidate_read" || !missingEvidence.includes("pattern_search"))
      .flatMap((evidence) => evidenceToolRecommendations[evidence])
      .filter((name) => availableTools.has(name))
  )];
}

export function evaluateTaskWorkflowToolDecision(input: {
  workflow: TaskWorkflowSnapshot;
  toolName: string;
  toolArguments?: Record<string, unknown>;
  agentContext: AgentContext;
  availableTools: ReadonlySet<string>;
}): TaskWorkflowDecision {
  const { workflow, toolName, toolArguments = {}, agentContext, availableTools } = input;
  const policy = resolveTaskWorkflowDecisionPolicy(workflow);

  if (!policy.mutationAllowed && sideEffectTools.has(toolName)) {
    return {
      allowed: false,
      reason: `Task workflow ${workflow.type} only allows read-only inspection tools.`,
      missingEvidence: [],
      recommendedTools: [],
      blockingReferences: [],
      recoverable: false
    };
  }

  if (!policy.commandAllowed && toolName === "runCommand") {
    return {
      allowed: false,
      reason: `Task workflow ${workflow.type} does not allow command execution.`,
      missingEvidence: [],
      recommendedTools: [],
      blockingReferences: [],
      recoverable: false
    };
  }

  if (!editingTools.has(toolName)) {
    return { allowed: true, reason: null, missingEvidence: [], recommendedTools: [], blockingReferences: [], recoverable: true };
  }

  const state = collectTaskWorkflowEvidence(agentContext);
  const requiredEvidence = resolveRequiredEvidence(policy, agentContext);
  const missingEvidence = requiredEvidence.filter((evidence) => !hasEvidence(evidence, state, availableTools));
  // proposePatch 会在生成候选补丁前自动执行动态预检，不能在工具入口前形成 analyzeImpact 死锁。
  const autoPreflight = toolName === "proposePatch"
    && Boolean(agentContext.modificationPlan)
    && missingEvidence.length === 1
    && missingEvidence[0] === "impact_analysis";
  const blockingMissingEvidence = autoPreflight ? [] : missingEvidence;
  const recommendedTools = recommendEvidenceTools(blockingMissingEvidence, availableTools);
  const editIntent = resolveWorkflowEditIntent(toolName, toolArguments);
  const editBlock = blockingMissingEvidence.length === 0 && editIntent
    ? evaluateWorkflowEditGate({ intent: editIntent, agentContext, availableTools })
    : null;

  return {
    allowed: blockingMissingEvidence.length === 0 && !editBlock,
    reason: blockingMissingEvidence.length ? formatBlockReason(workflow, blockingMissingEvidence) : editBlock?.reason || null,
    missingEvidence: blockingMissingEvidence,
    recommendedTools: blockingMissingEvidence.length ? recommendedTools : editBlock?.recommendedTools || [],
    blockingReferences: editBlock?.blockingReferences || [],
    recoverable: blockingMissingEvidence.length ? recommendedTools.length > 0 : editBlock?.recoverable ?? true
  };
}

/**
 * 每轮把已满足证据、剩余缺口和下一步工具作为临时系统提示注入，减少模型靠猜测选择工具。
 */
export function buildTaskWorkflowProgressPrompt(
  workflow: TaskWorkflowSnapshot,
  agentContext: AgentContext,
  availableTools: ReadonlySet<string>
) {
  const policy = resolveTaskWorkflowDecisionPolicy(workflow);
  const state = collectTaskWorkflowEvidence(agentContext);
  const requiredEvidence = resolveRequiredEvidence(policy, agentContext);
  const missing = requiredEvidence.filter((evidence) => !hasEvidence(evidence, state, availableTools));
  const recommended = recommendEvidenceTools(missing, availableTools);

  return [
    "Workflow decision state (runtime facts; do not claim missing evidence):",
    `- workflow: ${workflow.type}`,
    `- workspace mutation allowed: ${policy.mutationAllowed}`,
    `- evidence satisfied: ${requiredEvidence.filter((evidence) => !missing.includes(evidence)).join(", ") || "none"}`,
    `- evidence missing before edit: ${missing.join(", ") || "none"}`,
    `- recommended next tools: ${recommended.join(", ") || "none"}`,
    "- Decision order: obey user scope and safety constraints; satisfy missing workflow evidence; then choose the lowest-cost useful tool; stop discovery once evidence is sufficient."
  ].join("\n");
}
