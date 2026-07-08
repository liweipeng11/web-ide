import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalPatchSummary, buildPatchGenerationDiagnostics } from "./editPatchService.js";

test("final patch summary uses cleaned file count instead of model candidate count", () => {
  const summary = buildFinalPatchSummary({
    files: [{ path: "src/app.ts" }],
    rawPatchCount: 3
  });

  assert.equal(summary, "已生成 1 个文件的修改，其中 2 个模型候选变更未进入最终 diff。");
});

test("final patch summary stays consistent when every candidate is effective", () => {
  const summary = buildFinalPatchSummary({
    files: [{ path: "src/app.ts" }],
    rawPatchCount: 1,
    commandsToRun: ["pnpm test"]
  });

  assert.equal(summary, "已生成 1 个文件的修改，并已附带建议验证命令。");
});

test("patch generation diagnostics summarizes filtered candidate records", () => {
  const diagnostics = buildPatchGenerationDiagnostics({
    patchId: "patch-1",
    modelSummary: "模型声称修改 3 个文件",
    rawPatchCount: 3,
    normalizedFilePaths: ["src/app.ts", "src/app.ts", "src/noop.ts"],
    preDedupeCount: 3,
    postDedupeCount: 2,
    finalPatchCount: 1,
    records: [
      {
        reason: "duplicate_path",
        stage: "dedupe",
        attempt: 0,
        filePath: "src/app.ts",
        normalizedPath: "src/app.ts"
      },
      {
        reason: "no_effect_change",
        stage: "content_diff",
        attempt: 0,
        filePath: "src/noop.ts",
        normalizedPath: "src/noop.ts"
      }
    ]
  });

  assert.equal(diagnostics.patchId, "patch-1");
  assert.equal(diagnostics.filteredCount, 2);
  assert.equal(diagnostics.noEffectCount, 1);
  assert.deepEqual(
    diagnostics.records.map((record) => record.reason),
    ["duplicate_path", "no_effect_change"]
  );
});
