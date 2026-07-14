import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPendingPatch } from "./patchApplyService.js";
import { clearPendingPatches, createPendingPatch } from "./patchStore.js";
import { createTaskSession, getTaskSession, setTaskPlanItems } from "./taskSessionStore.js";
import type { PatchFileChange } from "./types.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

test("applying a patch without declared commands keeps the task pending validation", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-patch-validation-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    const session = await createTaskSession("新增导出功能");
    await setTaskPlanItems(session.id, [
      { workflowStepId: "analyze-project", title: "分析项目与需求" },
      { workflowStepId: "find-patterns", title: "查找相似实现" },
      { workflowStepId: "plan-files", title: "确认文件实现计划" },
      { workflowStepId: "implement", title: "实现聚焦变更" },
      { workflowStepId: "validate", title: "验证功能实现" },
      { workflowStepId: "summarize", title: "输出变更说明" }
    ]);
    const change: PatchFileChange = {
      path: "target.ts",
      filePath: "target.ts",
      status: "modify",
      oldContent: "export const value = 1;\n",
      newContent: "export const value = 2;\n",
      summary: "更新常量",
      diffHtml: ""
    };
    const patch = createPendingPatch([change], session.id);

    await applyPendingPatch({ patchId: patch.patchId });
    const updated = await getTaskSession(session.id);

    assert.equal(updated.status, "running");
    assert.deepEqual(updated.planItems?.map((item) => item.status), ["completed", "completed", "completed", "completed", "in_progress", "pending"]);
  } finally {
    clearPendingPatches();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
