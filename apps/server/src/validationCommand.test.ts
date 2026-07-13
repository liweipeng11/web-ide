import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isValidationCommand, selectDefaultValidationCommandForRoot } from "./validationCommand.js";

async function createProject(scripts: Record<string, string>, packageManager: "npm" | "pnpm" = "npm") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-validation-"));
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ scripts }), "utf8");

  if (packageManager === "pnpm") {
    await fs.writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }

  return directory;
}

test("selects the lowest-cost validation script first", async (context) => {
  const directory = await createProject({ build: "vite build", lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest run" }, "pnpm");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.equal(await selectDefaultValidationCommandForRoot(directory), "pnpm typecheck");
});

test("falls back through typecheck, check, lint, and build", async (context) => {
  const directory = await createProject({ preview: "vite preview", lint: "eslint .", build: "vite build" });
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.equal(await selectDefaultValidationCommandForRoot(directory), "npm run lint");
});

test("returns null when the project has no validation script", async (context) => {
  const directory = await createProject({ dev: "vite" });
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.equal(await selectDefaultValidationCommandForRoot(directory), null);
});

test("recognizes package scripts and direct validation tools", () => {
  assert.equal(isValidationCommand("pnpm format:check"), true);
  assert.equal(isValidationCommand("npm run format-check"), true);
  assert.equal(isValidationCommand("pnpm test"), true);
  assert.equal(isValidationCommand("npm run typecheck"), true);
  assert.equal(isValidationCommand("tsc --noEmit"), true);
  assert.equal(isValidationCommand("eslint src"), true);
  assert.equal(isValidationCommand("npm run dev"), false);
  assert.equal(isValidationCommand("rm -rf dist"), false);
});
