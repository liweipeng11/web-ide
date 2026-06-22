import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverProjectRules, ensureGlobalRulesDirectory, ensureProjectRulesDirectory } from "./projectRules.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

test("discoverProjectRules loads global and project-scoped mini-ai rules", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-rules-"));
  const globalRulesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-global-rules-"));
  await fs.mkdir(path.join(workspaceRoot, ".mini-ai", "rules"), { recursive: true });
  await fs.mkdir(path.join(globalRulesRoot, "rules"), { recursive: true });
  await fs.writeFile(path.join(globalRulesRoot, "AGENTS.md"), "Always keep patches reviewable.", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".mini-ai", "AGENTS.md"), "Use pnpm for this project.", "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, ".mini-ai", "rules", "react.md"),
    ["---", "globs: src/**/*.tsx", "alwaysApply: false", "---", "Prefer small React components."].join("\n"),
    "utf8"
  );

  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const inactive = await discoverProjectRules(["apps/server/src/index.ts"], { globalRulesRoot });
  assert.equal(inactive.rules.length, 3);
  assert.equal(inactive.rules.find((rule) => rule.path === "~/.mini-ai/AGENTS.md")?.scope, "global");
  assert.equal(inactive.rules.find((rule) => rule.path === ".mini-ai/AGENTS.md")?.scope, "project");
  assert.equal(inactive.rules.find((rule) => rule.path === ".mini-ai/rules/react.md")?.active, false);
  assert.match(inactive.combinedInstructions || "", /Always keep patches/);
  assert.match(inactive.combinedInstructions || "", /Use pnpm/);
  assert.doesNotMatch(inactive.combinedInstructions || "", /Prefer small React/);

  const active = await discoverProjectRules(["src/App.tsx"], { globalRulesRoot });
  assert.equal(active.rules.find((rule) => rule.path === ".mini-ai/rules/react.md")?.active, true);
  assert.match(active.combinedInstructions || "", /Prefer small React components/);
});

test("ensureProjectRulesDirectory creates the project .mini-ai rules folder", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-rules-dir-"));
  const rulesRoot = await ensureProjectRulesDirectory(workspaceRoot);

  assert.equal(rulesRoot, path.join(workspaceRoot, ".mini-ai"));
  assert.equal((await fs.stat(path.join(workspaceRoot, ".mini-ai"))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(workspaceRoot, ".mini-ai", "rules"))).isDirectory(), true);
});

test("ensureGlobalRulesDirectory creates the user .mini-ai rules folder", async () => {
  const globalRulesRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-global-dir-")), ".mini-ai");
  const rulesRoot = await ensureGlobalRulesDirectory(globalRulesRoot);

  assert.equal(rulesRoot, globalRulesRoot);
  assert.equal((await fs.stat(globalRulesRoot)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(globalRulesRoot, "rules"))).isDirectory(), true);
});
