import assert from "node:assert/strict";
import test from "node:test";
import {
  filterToolSchemasForBudgetPhase,
  getAgentBudgetPhase,
  isToolAvailableInBudgetPhase,
  normalizeRuntimeAgentBudgetPolicy,
  resolveAgentBudgetPolicy
} from "./agentBudgetPolicy.js";

function schema(name: string) {
  return { type: "function" as const, function: { name, description: name, parameters: {} } };
}

test("预算配置非法时整体回退，受控小预算仍保留最终轮", () => {
  assert.deepEqual(resolveAgentBudgetPolicy({
    AI_AGENT_MAX_STEPS: "30",
    AI_AGENT_CONVERGENCE_REMAINING_STEPS: "5",
    AI_AGENT_FORCE_FINAL_REMAINING_STEPS: "2"
  }), { maxSteps: 30, convergenceRemainingSteps: 5, forceFinalRemainingSteps: 2 });

  assert.deepEqual(resolveAgentBudgetPolicy({
    AI_AGENT_MAX_STEPS: "3",
    AI_AGENT_CONVERGENCE_REMAINING_STEPS: "3",
    AI_AGENT_FORCE_FINAL_REMAINING_STEPS: "0"
  }), { maxSteps: 24, convergenceRemainingSteps: 3, forceFinalRemainingSteps: 1 });

  assert.deepEqual(normalizeRuntimeAgentBudgetPolicy({
    maxSteps: 2,
    convergenceRemainingSteps: 9,
    forceFinalRemainingSteps: 4
  }), { maxSteps: 2, convergenceRemainingSteps: 1, forceFinalRemainingSteps: 1 });
});

test("预算阶段按剩余步骤进入 normal、convergence 和 force_final", () => {
  const policy = { maxSteps: 10, convergenceRemainingSteps: 3, forceFinalRemainingSteps: 1 };
  assert.equal(getAgentBudgetPhase(4, policy), "normal");
  assert.equal(getAgentBudgetPhase(3, policy), "convergence");
  assert.equal(getAgentBudgetPhase(1, policy), "force_final");
});

test("收敛阶段保留精确读取、门禁解除、编辑与验证工具", () => {
  const retained = [
    "readFile",
    "readFileChunk",
    "readFileRange",
    "recoverContextArtifact",
    "findSimilarPatterns",
    "checkExistence",
    "analyzeImpact",
    "proposePatch",
    "replaceInFile",
    "writeFile",
    "applyPatch",
    "runCommand"
  ];
  const blocked = [
    "listFiles",
    "searchFilesByName",
    "searchCode",
    "searchCodeRegex",
    "searchWeb",
    "browseWebPage",
    "sequenceReasoning"
  ];

  for (const name of retained) assert.equal(isToolAvailableInBudgetPhase(name, "convergence"), true, name);
  for (const name of blocked) assert.equal(isToolAvailableInBudgetPhase(name, "convergence"), false, name);
  assert.equal(isToolAvailableInBudgetPhase("proposePatch", "force_final"), false);

  const visible = filterToolSchemasForBudgetPhase([...retained, ...blocked].map(schema), "convergence");
  assert.deepEqual(visible.map((item) => item.function.name), retained);
});
