import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "./projectAnalyzer.js";

async function createWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-analyzer-"));
  await fs.mkdir(path.join(workspaceRoot, "apps", "web", "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "apps", "server", "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "dist"), { recursive: true });

  return workspaceRoot;
}

test("analyzeProject detects pnpm workspace stack and validation commands", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

  await fs.writeFile(path.join(workspaceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "turbo.json"), JSON.stringify({ tasks: {} }), "utf8");
  await fs.writeFile(path.join(workspaceRoot, "nx.json"), JSON.stringify({ affected: {} }), "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ name: "root-app", scripts: { test: "pnpm --filter server test" } }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(workspaceRoot, "apps", "web", "vite.config.ts"), "export default {}\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "apps", "web", "tsconfig.json"), "{}", "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, "apps", "web", "package.json"),
    JSON.stringify(
      {
        name: "web",
        scripts: { typecheck: "tsc --noEmit", build: "vite build" },
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { vite: "^7.0.0", typescript: "^5.0.0", vitest: "^3.0.0" }
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(path.join(workspaceRoot, "apps", "web", "src", "App.test.tsx"), "import test from 'node:test';\n", "utf8");

  const analysis = await analyzeProject(workspaceRoot);

  assert.equal(analysis.packageManager.name, "pnpm");
  assert.equal(analysis.packageManager.workspaceFile, "pnpm-workspace.yaml");
  assert.deepEqual(analysis.packageManager.packageJsonFiles.sort(), ["apps/web/package.json", "package.json"]);
  assert.deepEqual(analysis.techStack.languages, ["javascript", "typescript"]);
  assert.ok(analysis.techStack.frameworks.includes("react"));
  assert.ok(analysis.techStack.buildTools.includes("vite"));
  assert.ok(analysis.techStack.buildTools.includes("turbo"));
  assert.ok(analysis.techStack.buildTools.includes("nx"));
  assert.ok(analysis.techStack.typeSystems.includes("typescript"));
  assert.ok(analysis.structure.workspacePackages.includes("apps/web"));
  assert.equal(analysis.testSystem.hasTests, true);
  assert.ok(analysis.testSystem.tools.includes("vitest"));
  assert.ok(analysis.validationCommands.some((command) => command.command === "pnpm test"));
  assert.ok(analysis.validationCommands.some((command) => command.command === "pnpm --dir apps/web typecheck"));
  assert.ok(analysis.highRiskDirectories.some((directory) => directory.path === "node_modules"));
  assert.ok(analysis.highRiskDirectories.some((directory) => directory.path === "dist"));
});

test("analyzeProject detects Python validation candidates from config files", async (context) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-python-analyzer-"));
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "pyproject.toml"), "[project]\nname = 'sample'\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "pytest.ini"), "[pytest]\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "ruff.toml"), "line-length = 120\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "mypy.ini"), "[mypy]\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "test_service.py"), "def test_ok():\n    assert True\n", "utf8");

  const analysis = await analyzeProject(workspaceRoot);

  assert.equal(analysis.packageManager.name, null);
  assert.deepEqual(analysis.techStack.languages, ["python"]);
  assert.ok(analysis.techStack.lintTools.includes("ruff"));
  assert.ok(analysis.techStack.typeSystems.includes("mypy"));
  assert.ok(analysis.testSystem.tools.includes("pytest"));
  assert.ok(analysis.validationCommands.some((command) => command.command === "pytest"));
  assert.ok(analysis.validationCommands.some((command) => command.command === "ruff check ."));
  assert.ok(analysis.validationCommands.some((command) => command.command === "mypy ."));
});
