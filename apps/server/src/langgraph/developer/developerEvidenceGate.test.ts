import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../../runtime/contracts.js";
import type { DeveloperEvidence, DeveloperGraphStateValue } from "./developerGraphState.js";
import { developerEvidenceGateNode, evaluateDeveloperEvidence } from "./developerEvidenceGate.js";

function implementTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "I1",
    type: "implement",
    goal: "修改入口",
    dependencies: ["E1"],
    requiredCapabilities: ["editing"],
    readScope: ["src/**"],
    writeScope: ["src/**"],
    acceptanceCriteria: ["入口行为保持兼容"],
    status: "pending",
    ...overrides
  };
}

function completeEvidence(): DeveloperEvidence[] {
  return [
    { id: "context-1", kind: "context", source: "task_context", sourceRef: "I1", summary: "已确认目标与验收条件", paths: [] },
    { id: "existence-1", kind: "existence", source: "read_tool", sourceRef: "read-1", summary: "目标入口已存在", paths: ["src/index.ts"] },
    { id: "pattern-1", kind: "pattern", source: "explorer", sourceRef: "E1", summary: "找到同类服务模式", paths: ["src/service.ts"] },
    { id: "impact-1", kind: "impact", source: "explorer", sourceRef: "E1", summary: "影响入口和对应服务", paths: ["src/index.ts", "src/service.ts"] }
  ];
}

test("缺少必要证据时不能进入修改计划阶段", () => {
  const result = evaluateDeveloperEvidence({
    task: implementTask(),
    completedTaskIds: ["E1"],
    evidence: completeEvidence().filter((item) => item.kind !== "impact")
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.missingEvidence, ["impact"]);
  assert.deepEqual(result.blockers, []);
});

test("四类可追踪证据与依赖齐备后门禁放行", () => {
  const result = evaluateDeveloperEvidence({
    task: implementTask(),
    completedTaskIds: ["E1"],
    evidence: completeEvidence()
  });

  assert.deepEqual(result, { ready: true, missingEvidence: [], blockers: [] });
});

test("未完成依赖和 read scope 外证据会阻断执行", () => {
  const evidence = completeEvidence();
  evidence[1] = { ...evidence[1], paths: ["secrets/key.txt"] };
  const result = evaluateDeveloperEvidence({ task: implementTask(), completedTaskIds: [], evidence });

  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /依赖尚未完成：E1/);
  assert.match(result.blockers.join("\n"), /read scope 外路径/);
  assert.deepEqual(result.missingEvidence, ["existence"]);
});

test("门禁节点只返回增量且不修改输入状态", () => {
  const evidence = completeEvidence();
  const state = {
    task: implementTask(),
    graphRunId: "run-1",
    status: "preparing",
    completedTaskIds: ["E1"],
    facts: [],
    evidence,
    missingEvidence: [],
    blockers: [],
    requiredWriteScope: [],
    modificationPlan: null,
    patchProposal: null
  } satisfies DeveloperGraphStateValue;
  const snapshot = structuredClone(state);

  const update = developerEvidenceGateNode(state);

  assert.equal(update.status, "evidence_ready");
  assert.deepEqual(state, snapshot);
  assert.equal(update.modificationPlan, undefined);
});

test("非实现任务或空 write scope 不可进入 Developer 子图", () => {
  const result = evaluateDeveloperEvidence({
    task: implementTask({ type: "explore", writeScope: [] }),
    completedTaskIds: ["E1"],
    evidence: completeEvidence()
  });

  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /不是 implement Task/);
  assert.match(result.blockers.join("\n"), /缺少 writeScope/);
});
