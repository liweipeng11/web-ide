import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMultiFileDiffHtml } from "../diffTools.js";
import { clearPendingPatches, createOrReusePendingPatch, getPendingPatch } from "../patchStore.js";
import type { Task } from "../runtime/contracts.js";
import {
  buildSafeEditRecommendation,
  createStructuredModificationPlan,
  evaluateSafeEdit
} from "../safeEditor/index.js";
import type { DeveloperEvidence, DeveloperGraphStateValue, DeveloperModificationPlan } from "../langgraph/developer/developerGraphState.js";
import {
  hashDeveloperPatchContent,
  proposeDeveloperPatch,
  type DeveloperPatchProposalDependencies
} from "../langgraph/developer/developerPatchProposal.js";

test("阶段 5 Developer Patch-only 与现有 Safe Editor、Diff UI 契约兼容且零工作区写入", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-stage5-"));
  const originalIndex = "export const value = 1;\n";
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/index.ts"), originalIndex, "utf8");
  clearPendingPatches();
  context.after(async () => {
    clearPendingPatches();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  const task: Task = {
    id: "I-STAGE5",
    type: "implement",
    goal: "更新入口并新增辅助模块",
    dependencies: ["E-STAGE5"],
    requiredCapabilities: ["editing"],
    readScope: ["src/**"],
    writeScope: ["src/**"],
    acceptanceCriteria: ["生成可审核 Diff"],
    status: "pending"
  };
  const evidence: DeveloperEvidence[] = [
    { id: "context", kind: "context", source: "task_context", sourceRef: task.id, summary: "目标已确认", paths: [] },
    { id: "existence", kind: "existence", source: "read_tool", sourceRef: "read-stage5", summary: "目标状态已确认", paths: ["src/index.ts", "src/helper.ts"] },
    { id: "pattern", kind: "pattern", source: "explorer", sourceRef: "E-STAGE5", summary: "相似模式已确认", paths: ["src/index.ts"] },
    { id: "impact", kind: "impact", source: "explorer", sourceRef: "E-STAGE5", summary: "影响范围已确认", paths: ["src/index.ts"] }
  ];
  const modificationPlan: DeveloperModificationPlan = {
    taskId: task.id,
    summary: "最小范围更新",
    files: [
      { path: "src/index.ts", operation: "modify", reason: "更新入口值", evidenceIds: ["existence", "impact"] },
      { path: "src/helper.ts", operation: "create", reason: "新增辅助模块", evidenceIds: ["existence", "impact"] }
    ]
  };
  const state: DeveloperGraphStateValue = {
    task,
    graphRunId: "stage5-run",
    status: "scope_ready",
    completedTaskIds: ["E-STAGE5"],
    facts: [],
    evidence,
    missingEvidence: [],
    blockers: [],
    requiredWriteScope: [],
    modificationPlan,
    patchProposal: null
  };
  const dependencies: DeveloperPatchProposalDependencies = {
    async inspectFile(filePath) {
      const absolutePath = path.join(root, ...filePath.split("/"));
      const content = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return content === null
        ? { exists: false, content: "", isBinary: false }
        : { exists: true, content, isBinary: false };
    },
    storePatch: createOrReusePendingPatch
  };
  const candidates = [
    {
      path: "src/index.ts",
      operation: "modify" as const,
      newContent: "export const value = 2;\n",
      summary: "更新入口值",
      baseContentHash: hashDeveloperPatchContent(originalIndex)
    },
    {
      path: "src/helper.ts",
      operation: "create" as const,
      newContent: "export const helper = true;\n",
      summary: "新增辅助模块"
    }
  ];

  const first = await proposeDeveloperPatch({ state, candidates, taskSessionId: "stage5-session" }, dependencies);
  const replay = await proposeDeveloperPatch({ state, candidates, taskSessionId: "stage5-session" }, dependencies);
  const pending = getPendingPatch(first.patch.patchId);
  assert.equal(replay.patch.patchId, first.patch.patchId);
  assert.equal(pending, first.patch);
  assert.equal(pending?.source?.actionId, first.stateUpdate.patchProposal.actionId);

  const safePlan = createStructuredModificationPlan({
    id: `plan-${first.stateUpdate.patchProposal.actionId}`,
    taskDescription: task.goal,
    createdAt: 0,
    files: modificationPlan.files.map((file) => ({
      filePath: file.path,
      changeKind: file.operation,
      reason: file.reason
    }))
  });
  const recommendation = buildSafeEditRecommendation({ modificationPlan: safePlan });
  const report = evaluateSafeEdit({
    taskDescription: task.goal,
    recommendation,
    candidates: first.patch.files.map((file) => ({
      filePath: file.path,
      status: file.status,
      oldContent: file.oldContent,
      newContent: file.newContent,
      summary: file.summary
    }))
  });
  const diffHtml = createMultiFileDiffHtml(first.patch.files);

  assert.equal(report.status, "clean");
  assert.deepEqual(report.expansionFiles, []);
  assert.deepEqual(report.necessaryFiles, ["src/index.ts", "src/helper.ts"]);
  assert.match(diffHtml, /src\/index\.ts/);
  assert.match(diffHtml, /src\/helper\.ts \(new file\)/);
  assert.ok(first.patch.files.every((file) => file.editHunks && file.diffHtml));

  // 阶段 5 只允许创建待审批产物，磁盘上的修改和新建目标均不能变化。
  assert.equal(await fs.readFile(path.join(root, "src/index.ts"), "utf8"), originalIndex);
  assert.equal(await fs.stat(path.join(root, "src/helper.ts")).then(() => true).catch(() => false), false);
});

