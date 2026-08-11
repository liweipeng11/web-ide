import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, Plan } from "../../runtime/contracts.js";
import { evaluateReplanRules } from "./replanPolicy.js";

function plan(assumptions: string[] = []): Plan {
  return {
    version: 1,
    goal: "迁移认证实现",
    assumptions,
    tasks: [{
      id: "T1",
      type: "explore",
      goal: "确认认证实现",
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope: ["src/**"],
      writeScope: [],
      acceptanceCriteria: ["确认认证机制"],
      status: "running"
    }],
    completionCriteria: ["确认认证机制"]
  };
}

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    taskId: "T1",
    status: "success",
    summary: "探索完成",
    facts: [],
    changedFiles: [],
    evidence: [],
    blockers: [],
    ...overrides
  };
}

test("明确的结构变化直接触发 Replan", () => {
  const decision = evaluateReplanRules({
    plan: plan(),
    result: result(),
    sameTaskFailures: 0,
    forceReason: "实现范围变化较大"
  });

  assert.equal(decision.shouldReplan, true);
  assert.equal("source" in decision ? decision.source : undefined, "rule");
});

test("关键假设和新事实同时存在时进入语义辅助判断", () => {
  const decision = evaluateReplanRules({
    plan: plan(["认证使用 JWT"]),
    result: result({ facts: ["认证实际使用 Redis Session"] }),
    sameTaskFailures: 0
  });

  assert.equal(decision.shouldReplan, null);
});

test("简单工具 miss 不触发 Replan", () => {
  const decision = evaluateReplanRules({
    plan: plan(["认证使用 JWT"]),
    result: result({ status: "failed", summary: "FILE_NOT_FOUND", blockers: ["目标文件不存在"] }),
    sameTaskFailures: 3
  });

  assert.equal(decision.shouldReplan, false);
});

test("同一任务第三次失败时触发 Replan", () => {
  const decision = evaluateReplanRules({
    plan: plan(),
    result: result({ status: "failed", summary: "实现路径不可行" }),
    sameTaskFailures: 3
  });

  assert.equal(decision.shouldReplan, true);
});
