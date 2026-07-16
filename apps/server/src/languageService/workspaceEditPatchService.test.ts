import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deletePendingPatch, getPendingPatch } from "../patchStore.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { createWorkspaceEditPatchResponse } from "./workspaceEditPatchService.js";

test("workspace edits become reviewable pending patches without writing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-edit-"));
  await fs.writeFile(path.join(root, "main.ts"), "const oldName = oldName + 1;\n", "utf8");
  await setWorkspaceRoot(root, { persist: false });
  const response = await createWorkspaceEditPatchResponse({
    source: "lsp",
    changes: {
      "main.ts": [
        { range: { start: { line: 1, column: 7 }, end: { line: 1, column: 14 } }, newText: "newName" },
        { range: { start: { line: 1, column: 17 }, end: { line: 1, column: 24 } }, newText: "newName" }
      ]
    }
  }, "rename symbol");

  assert.equal(await fs.readFile(path.join(root, "main.ts"), "utf8"), "const oldName = oldName + 1;\n");
  assert.equal(getPendingPatch(response.patchId)?.files[0].newContent, "const newName = newName + 1;\n");
  assert.match(response.diffHtml, /newName/);
  deletePendingPatch(response.patchId);
  await fs.rm(root, { recursive: true, force: true });
});
