import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { acceptMemoryCandidate, createMemoryCandidate } from "./memoryCandidateService.js";
import { createProjectMemoryTestWorkspace } from "./fixtures/projectMemoryV2.fixture.js";
import { normalizePromotionInput, promoteMemoryToRule } from "./memoryPromotionService.js";
import { scoreProjectMemoryItem } from "./memoryScoring.js";

test("active Memory 可安全提升为路径级规则并停止重复召回", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const created = await createMemoryCandidate({
    kind: "decision",
    content: "认证模块统一使用 JWT",
    scope: { type: "path", paths: ["apps/server/src/auth/**"] },
    sourceRefs: [{ type: "user", value: "message-1" }],
    createdBy: "user",
    confidence: 1
  }, workspaceRoot);
  await acceptMemoryCandidate(created.candidate.id, workspaceRoot);

  const result = await promoteMemoryToRule(created.candidate.id, normalizePromotionInput({
    ruleFile: "authentication.md",
    scope: "path",
    paths: ["apps/server/src/auth/**"],
    alwaysApply: false,
    confirmed: true
  }), workspaceRoot);

  assert.equal(result.rulePath, ".mini-ai/rules/authentication.md");
  assert.equal(result.item.promotedTo?.scope, "path");
  const content = await fs.readFile(path.join(workspaceRoot, result.rulePath), "utf8");
  assert.match(content, /alwaysApply: false/);
  assert.match(content, /apps\/server\/src\/auth\/\*\*/);
  assert.match(content, /认证模块统一使用 JWT/);
  assert.equal(scoreProjectMemoryItem(result.item, {
    userRequest: "修改认证模块 JWT",
    contextPaths: ["apps/server/src/auth/service.ts"],
    plannedFiles: [],
    languages: ["TypeScript"],
    frameworks: [],
    maxItems: 8,
    tokenBudget: 1_200
  }), null);
});

test("规则提升必须显式确认且不能覆盖已有文件", async (context) => {
  assert.throws(() => normalizePromotionInput({ ruleFile: "unsafe.md", scope: "project", paths: [], alwaysApply: true, confirmed: false }), /explicit confirmation/);
  assert.throws(() => normalizePromotionInput({ ruleFile: "..\\unsafe.md", scope: "project", paths: [], alwaysApply: true, confirmed: true }), /safe \.md/);

  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const created = await createMemoryCandidate({ kind: "fact", content: "已有规则事实", sourceRefs: [{ type: "user", value: "m1" }], createdBy: "user", confidence: 1 }, workspaceRoot);
  await acceptMemoryCandidate(created.candidate.id, workspaceRoot);
  const rulesDir = path.join(workspaceRoot, ".mini-ai", "rules");
  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(path.join(rulesDir, "existing.md"), "原内容", "utf8");
  await assert.rejects(
    promoteMemoryToRule(created.candidate.id, normalizePromotionInput({ ruleFile: "existing.md", scope: "project", paths: [], alwaysApply: true, confirmed: true }), workspaceRoot),
    /already exists/
  );
  assert.equal(await fs.readFile(path.join(rulesDir, "existing.md"), "utf8"), "原内容");
});
