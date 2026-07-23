import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPatchCompletenessReport, createContextSelectionSnapshot } from "./contextSelection/index.js";
import { buildFinalPatchSummary, buildPatchGenerationDiagnostics, validateFinalPatchImports } from "./editPatchService.js";
import { buildSafeEditRecommendation, evaluateSafeEdit } from "./safeEditor/index.js";

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

test("patch diagnostics can carry context selection and completeness report", () => {
  const contextSelection = createContextSelectionSnapshot({
    userGoal: "把按钮文案改成保存",
    selectedFilePath: "src/Button.tsx",
    filesRead: ["src/Button.tsx"]
  });
  const patchCompleteness = buildPatchCompletenessReport({
    snapshot: contextSelection,
    patchFiles: ["src/Button.tsx"]
  });
  const diagnostics = buildPatchGenerationDiagnostics({
    rawPatchCount: 1,
    normalizedFilePaths: ["src/Button.tsx"],
    preDedupeCount: 1,
    postDedupeCount: 1,
    finalPatchCount: 1,
    records: [],
    contextSelection,
    patchCompleteness
  });

  assert.equal(diagnostics.contextSelection?.readyForPatch, true);
  assert.equal(diagnostics.patchCompleteness?.risks.length, 0);
});

test("patch diagnostics carries Safe Editor minimal-change assessment", () => {
  const recommendation = buildSafeEditRecommendation({ fallbackTargetFiles: ["src/app.ts"] });
  const safeEditReport = evaluateSafeEdit({
    taskDescription: "修改应用入口",
    recommendation,
    candidates: [{ filePath: "src/app.ts", status: "modify", oldContent: "old", newContent: "new" }]
  });
  const diagnostics = buildPatchGenerationDiagnostics({
    rawPatchCount: 1,
    normalizedFilePaths: ["src/app.ts"],
    preDedupeCount: 1,
    postDedupeCount: 1,
    finalPatchCount: 1,
    records: [],
    safeEditReport
  });

  assert.equal(diagnostics.safeEditReport?.status, "clean");
  assert.deepEqual(diagnostics.safeEditReport?.necessaryFiles, ["src/app.ts"]);
});

test("patch completeness reports missed selected target file", () => {
  const contextSelection = createContextSelectionSnapshot({
    userGoal: "修改当前组件文案",
    selectedFilePath: "src/Target.tsx",
    filesRead: ["src/Target.tsx"]
  });
  const report = buildPatchCompletenessReport({
    snapshot: contextSelection,
    patchFiles: ["src/Other.tsx"]
  });

  assert.equal(report.risks.some((risk) => risk.requirement === "patch-cover-target-files"), true);
});

test("final patch import validation accepts planned files and blocks unknown imports", async (context) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-edit-patch-imports-"));
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  const validFiles = [
    {
      path: "src/main.ts",
      filePath: "src/main.ts",
      status: "create" as const,
      oldContent: "",
      newContent: "import value from \"./value\";\nexport default value;\n",
      summary: "新增入口",
      diffHtml: ""
    },
    {
      path: "src/value.ts",
      filePath: "src/value.ts",
      status: "create" as const,
      oldContent: "",
      newContent: "export default 1;\n",
      summary: "新增值",
      diffHtml: ""
    }
  ];

  const valid = await validateFinalPatchImports(workspaceRoot, validFiles);
  assert.deepEqual(valid.unresolved, []);

  await assert.rejects(
    validateFinalPatchImports(workspaceRoot, [
      {
        ...validFiles[0],
        newContent: "import value from \"./missing\";\nexport default value;\n"
      }
    ]),
    /unresolved import references.*truly_missing/
  );
});
