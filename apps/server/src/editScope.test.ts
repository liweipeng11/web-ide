import test from "node:test";
import assert from "node:assert/strict";
import { buildEditScope, validatePatchesAgainstEditScope } from "./editScope.js";
import type { FilePatch } from "./types.js";

function createPatch(filePath: string, oldContent: string): FilePatch {
  return {
    filePath,
    oldContent,
    newContent: `${oldContent}\nupdated`,
    summary: "测试补丁"
  };
}

test("allows modifying selected and read files", () => {
  const scope = buildEditScope({
    selectedFilePath: "src/App.tsx",
    filesRead: ["src/api.ts"]
  });
  const result = validatePatchesAgainstEditScope([createPatch("src/App.tsx", "app"), createPatch("src/api.ts", "api")], scope);

  assert.equal(result.ok, true);
});

test("blocks unrelated existing files that were not in edit scope", () => {
  const scope = buildEditScope({
    selectedFilePath: "src/App.tsx",
    filesRead: ["src/api.ts"]
  });
  const result = validatePatchesAgainstEditScope([createPatch("src/styles.css", "body {}")], scope);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.deepEqual(result.blockedFiles, ["src/styles.css"]);
    assert.deepEqual(result.allowedExistingFiles, ["src/App.tsx", "src/api.ts"]);
  }
});

test("allows new files next to files already in scope", () => {
  const scope = buildEditScope({
    filesRead: ["src/features/user/userService.ts"]
  });
  const result = validatePatchesAgainstEditScope([createPatch("src/features/user/userTypes.ts", "")], scope);

  assert.equal(result.ok, true);
});

test("treats explicit delete patches as existing-file changes", () => {
  const scope = buildEditScope({
    selectedFilePath: "src/obsolete.ts",
    allowNewFiles: false
  });
  const result = validatePatchesAgainstEditScope([
    {
      filePath: "src/obsolete.ts",
      status: "delete",
      oldContent: "",
      newContent: "",
      summary: "删除不再使用的文件"
    }
  ], scope);

  assert.equal(result.ok, true);
});

test("blocks new files in unrelated directories", () => {
  const scope = buildEditScope({
    filesRead: ["src/features/user/userService.ts"]
  });
  const result = validatePatchesAgainstEditScope([createPatch("src/features/order/orderService.ts", "")], scope);

  assert.equal(result.ok, false);
});
