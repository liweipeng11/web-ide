import test from "node:test";
import assert from "node:assert/strict";
import { clearPendingPatches, createOrReusePendingPatch, createPendingPatch, normalizePatchPath, removePendingPatchFile } from "./patchStore.js";

test("removes pending patch files using normalized workspace paths", () => {
  clearPendingPatches();

  const patch = createPendingPatch([
    {
      filePath: "src/views/LoginView.vue",
      path: "src/views/LoginView.vue",
      status: "modify",
      summary: "Update login view",
      diffHtml: "",
      oldContent: "before",
      newContent: "after"
    },
    {
      filePath: "src/router/index.js",
      path: "src/router/index.js",
      status: "modify",
      summary: "Update router",
      diffHtml: "",
      oldContent: "before",
      newContent: "after"
    }
  ]);

  const remainingPatch = removePendingPatchFile(patch.patchId, "SRC\\VIEWS\\LoginView.vue");

  assert.equal(remainingPatch?.files.length, 1);
  assert.equal(remainingPatch?.files[0]?.path, "src/router/index.js");
});

test("normalizes Windows and POSIX patch paths to the same key", () => {
  assert.equal(normalizePatchPath("SRC\\views\\LoginView.vue"), normalizePatchPath("src/views/loginview.vue"));
});

test("稳定 Patch ID 只复用相同内容并拒绝静默覆盖", () => {
  clearPendingPatches();
  const input = {
    patchId: "patch-stable",
    files: [{
      filePath: "src/index.ts",
      path: "src/index.ts",
      status: "modify" as const,
      summary: "更新入口",
      diffHtml: "",
      oldContent: "before",
      newContent: "after"
    }]
  };

  const first = createOrReusePendingPatch(input);
  const replay = createOrReusePendingPatch(input);

  assert.equal(replay, first);
  assert.throws(
    () => createOrReusePendingPatch({ ...input, files: [{ ...input.files[0], newContent: "conflict" }] }),
    /内容冲突/
  );
});
