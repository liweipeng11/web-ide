import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../../runtime/contracts.js";
import type {
  DeveloperEvidence,
  DeveloperGraphStateValue,
  DeveloperModificationPlan
} from "./developerGraphState.js";
import { evaluateModificationPlan, modificationPlanGateNode } from "./modificationPlanGate.js";

const task: Task = {
  id: "I1",
  type: "implement",
  goal: "更新认证模块",
  dependencies: ["E1"],
  requiredCapabilities: ["editing"],
  readScope: ["src/auth/**"],
  writeScope: ["src/auth/**", "src/new.ts"],
  acceptanceCriteria: ["认证行为保持兼容"],
  status: "pending"
};

const evidence: DeveloperEvidence[] = [
  { id: "context", kind: "context", source: "task_context", sourceRef: "I1", summary: "目标已确认", paths: [] },
  { id: "existence", kind: "existence", source: "read_tool", sourceRef: "read-1", summary: "目标文件存在", paths: ["src/auth/index.ts"] },
  { id: "pattern", kind: "pattern", source: "explorer", sourceRef: "E1", summary: "同类模式已确认", paths: ["src/auth/service.ts"] },
  { id: "impact", kind: "impact", source: "explorer", sourceRef: "E1", summary: "影响范围已确认", paths: ["src/auth/index.ts"] }
];

function plan(files: DeveloperModificationPlan["files"]): DeveloperModificationPlan {
  return { taskId: "I1", summary: "按现有模式更新认证模块", files };
}

const evidenceIds = ["existence", "impact"];

test("创建、修改和删除意图在 write scope 内时通过门禁", () => {
  const result = evaluateModificationPlan({
    task,
    completedTaskIds: ["E1"],
    evidence,
    plan: plan([
      { path: "src/new.ts", operation: "create", reason: "新增入口", evidenceIds },
      { path: "src/auth/index.ts", operation: "modify", reason: "接入入口", evidenceIds },
      { path: "src/auth/legacy.ts", operation: "delete", reason: "移除旧实现", evidenceIds }
    ])
  });

  assert.deepEqual(result, { ready: true, requiredWriteScope: [], errors: [] });
});

test("write scope 外目标返回结构化范围变更请求", () => {
  const result = evaluateModificationPlan({
    task,
    completedTaskIds: ["E1"],
    evidence,
    plan: plan([{ path: "src/admin/index.ts", operation: "create", reason: "新增后台入口", evidenceIds }])
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.requiredWriteScope, ["src/admin/index.ts"]);
  assert.deepEqual(result.errors, []);
});

test("重复目标、目录穿越和未知证据会被拒绝", () => {
  const result = evaluateModificationPlan({
    task,
    completedTaskIds: ["E1"],
    evidence,
    plan: plan([
      { path: "src/auth/index.ts", operation: "modify", reason: "第一次修改", evidenceIds },
      { path: "src\\auth\\index.ts", operation: "delete", reason: "重复目标", evidenceIds: ["missing"] },
      { path: "../outside.ts", operation: "create", reason: "非法路径", evidenceIds }
    ])
  });

  assert.equal(result.ready, false);
  assert.match(result.errors.join("\n"), /重复文件/);
  assert.match(result.errors.join("\n"), /未知证据：missing/);
  assert.match(result.errors.join("\n"), /合法的工作区相对路径/);
});

test("修改和删除已有文件还必须位于 read scope", () => {
  const expandedTask = { ...task, writeScope: [...task.writeScope, "docs/**"] };
  const result = evaluateModificationPlan({
    task: expandedTask,
    completedTaskIds: ["E1"],
    evidence,
    plan: plan([{ path: "docs/legacy.md", operation: "delete", reason: "删除旧文档", evidenceIds }])
  });

  assert.equal(result.ready, false);
  assert.match(result.errors.join("\n"), /不在 readScope 内/);
});

test("节点仅在证据与范围均通过后进入 scope_ready", () => {
  const modificationPlan = plan([
    { path: "src/auth/index.ts", operation: "modify", reason: "更新入口", evidenceIds }
  ]);
  const state = {
    task,
    graphRunId: "run-1",
    status: "evidence_ready",
    completedTaskIds: ["E1"],
    facts: [],
    evidence,
    missingEvidence: [],
    blockers: [],
    requiredWriteScope: [],
    modificationPlan,
    patchProposal: null
  } satisfies DeveloperGraphStateValue;
  const snapshot = structuredClone(state);

  const update = modificationPlanGateNode(state);

  assert.equal(update.status, "scope_ready");
  assert.deepEqual(update.requiredWriteScope, []);
  assert.deepEqual(state, snapshot);
});

test("节点将纯 write scope 越权映射为 scope_change_required", () => {
  const state = {
    task,
    graphRunId: "run-2",
    status: "evidence_ready",
    completedTaskIds: ["E1"],
    facts: [],
    evidence,
    missingEvidence: [],
    blockers: [],
    requiredWriteScope: [],
    modificationPlan: plan([
      { path: "src/admin/index.ts", operation: "create", reason: "新增后台入口", evidenceIds }
    ]),
    patchProposal: null
  } satisfies DeveloperGraphStateValue;

  const update = modificationPlanGateNode(state);

  assert.equal(update.status, "scope_change_required");
  assert.deepEqual(update.requiredWriteScope, ["src/admin/index.ts"]);
  assert.deepEqual(update.blockers, []);
});
