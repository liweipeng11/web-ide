import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createProjectMemoryTestWorkspace, createProjectMemoryV3Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import { clearMemoryValidationCache, validateMemoryItemSources, validateProjectMemory } from "./memoryValidationService.js";

function activeItem(sourceRefs: ReturnType<typeof createProjectMemoryV3Fixture>["items"][number]["sourceRefs"]) {
  const base = createProjectMemoryV3Fixture().items[0]!;
  return { ...base, id: "source-memory", status: "active" as const, validationStatus: "unverified" as const, sourceRefs, updatedAt: Date.now() };
}

test("文件删除、哈希变化和符号消失会使来源降级或失效", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const sourcePath = path.join(workspaceRoot, "auth.ts");
  const original = "export function validateToken() { return true }\n";
  await fs.writeFile(sourcePath, original, "utf8");
  const hash = crypto.createHash("sha256").update(original).digest("hex");

  const valid = await validateMemoryItemSources(activeItem([{ type: "file", value: "auth.ts", contentHash: hash }]), { workspaceRoot });
  assert.equal(valid.status, "valid");
  await fs.writeFile(sourcePath, "export const changed = true\n", "utf8");
  const changed = await validateMemoryItemSources(activeItem([{ type: "file", value: "auth.ts", contentHash: hash }]), { workspaceRoot, cacheTtlMs: 0 });
  assert.equal(changed.status, "possibly_stale");
  const missingSymbol = await validateMemoryItemSources(activeItem([{ type: "symbol", value: "validateToken", filePath: "auth.ts" }]), { workspaceRoot, cacheTtlMs: 0 });
  assert.equal(missingSymbol.status, "invalid");
  await fs.rm(sourcePath);
  const missing = await validateMemoryItemSources(activeItem([{ type: "file", value: "auth.ts" }]), { workspaceRoot, cacheTtlMs: 0 });
  assert.equal(missing.status, "invalid");
});

test("分支、依赖和缓存验证不修改工作区且失败不抛出", async (context) => {
  clearMemoryValidationCache();
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const branchItem = activeItem([{ type: "branch", value: "main" }, { type: "dependency", value: "react" }]);
  const first = await validateMemoryItemSources(branchItem, { workspaceRoot, currentBranch: "feature/test", now: 1_000 });
  const second = await validateMemoryItemSources(branchItem, { workspaceRoot, currentBranch: "feature/test", now: 2_000 });
  assert.equal(first.status, "possibly_stale");
  assert.equal(second.fromCache, true);
  assert.equal((await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8")).includes("react"), true);

  const memory = createProjectMemoryV3Fixture({ items: [activeItem([{ type: "git_commit", value: "not-a-commit" }])] });
  const validated = await validateProjectMemory(memory, { workspaceRoot, cacheTtlMs: 0 });
  assert.equal(validated.memory.items[0]?.status, "stale");
  assert.equal(validated.memory.items[0]?.validationStatus, "invalid");
});
