import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentToolRuntime, executeAgentToolCall } from "../agentTools.js";
import type { AgentContext } from "../agentToolTypes.js";
import { getModificationPlanBlockReason } from "../agentRuntime.js";
import { createTaskSession, getTaskSession } from "../taskSessionStore.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { buildSafeEditRecommendation, createStructuredModificationPlan, evaluateSafeEdit } from "./index.js";

const files = [
  { filePath: "src/router/index.js", changeKind: "create" as const, responsibility: "注册页面路由", reason: "任务需要新增路由入口" },
  { filePath: "src/main.js", changeKind: "modify" as const, responsibility: "挂载路由", reason: "应用入口必须注入 router" }
];

test("结构化计划规范路径并拒绝重复或越界路径", () => {
  const plan = createStructuredModificationPlan({
    taskDescription: "新增 Vue Router",
    files: [{ ...files[0], filePath: "./src\\router\\index.js" }, files[1]]
  });
  assert.deepEqual(plan.files.map((file) => file.filePath), ["src/router/index.js", "src/main.js"]);

  assert.throws(() => createStructuredModificationPlan({
    taskDescription: "重复文件",
    files: [files[1], { ...files[1], filePath: "./SRC/main.js" }]
  }), /重复文件/);
  assert.throws(() => createStructuredModificationPlan({
    taskDescription: "越界文件",
    files: [{ ...files[0], filePath: "../outside.js" }]
  }), /非法工作区路径/);
});

test("agent_plan 在补丁前建立完整最小修改集合，额外文件仍判定为真实扩散", () => {
  const plan = createStructuredModificationPlan({ taskDescription: "新增 Vue Router", files });
  const recommendation = buildSafeEditRecommendation({ modificationPlan: plan });
  assert.deepEqual(recommendation.requiredFiles, ["src/router/index.js", "src/main.js"]);
  assert.deepEqual(recommendation.evidence, { sources: ["agent_plan"], complete: true, diagnostics: [] });

  const expected = evaluateSafeEdit({
    taskDescription: plan.taskDescription,
    recommendation,
    candidates: files.map((file) => ({ filePath: file.filePath, status: file.changeKind, oldContent: file.changeKind === "create" ? "" : "old", newContent: "new" }))
  });
  assert.equal(expected.status, "clean");
  assert.deepEqual(expected.necessaryFiles, ["src/router/index.js", "src/main.js"]);

  const expansion = evaluateSafeEdit({
    taskDescription: plan.taskDescription,
    recommendation,
    candidates: [{ filePath: "src/components/Unrelated.vue", status: "modify", oldContent: "old", newContent: "new" }]
  });
  assert.equal(expansion.status, "high_risk");
  assert.deepEqual(expansion.expansionFiles, ["src/components/Unrelated.vue"]);
});

test("编辑门禁要求先规划，并阻止修改计划之外的文件", () => {
  const context = { userGoal: "新增 Vue Router", filesRead: [], searchQueries: [], searchResultFiles: [], relevantFiles: [] };
  assert.match(getModificationPlanBlockReason("proposePatch", {}, context) || "", /planFileChanges/);

  const modificationPlan = createStructuredModificationPlan({ taskDescription: context.userGoal, files });
  assert.equal(getModificationPlanBlockReason("proposePatch", { filePath: "src/main.js" }, { ...context, modificationPlan }), null);
  assert.match(getModificationPlanBlockReason("writeFile", { filePath: "src/extra.js" }, { ...context, modificationPlan }) || "", /not included/);
});

test("planFileChanges 同步更新 Agent 上下文和任务会话", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "safe-editor-plan-"));
  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src/main.js"), "new Vue({}).$mount('#app');\n", "utf8");
    const session = await createTaskSession("新增 Vue Router");
    const agentContext: AgentContext = { userGoal: session.userGoal, filesRead: [], searchQueries: [], searchResultFiles: [], relevantFiles: [], isSubagent: false, parentRunId: null };
    const response = await executeAgentToolCall({
      id: "plan-file-changes",
      type: "function",
      function: { name: "planFileChanges", arguments: JSON.stringify({ taskDescription: session.userGoal, files }) }
    }, createAgentToolRuntime({ agentContext, runId: "stage2-plan", taskSessionId: session.id }));
    const result = JSON.parse(response.content) as { error?: string };

    assert.equal(result.error, undefined);
    assert.deepEqual(agentContext.modificationPlan?.files, files);
    assert.deepEqual((await getTaskSession(session.id)).modificationPlan?.files, files);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
