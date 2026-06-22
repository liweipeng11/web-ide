import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectProject } from "./projectInspector.js";

test("inspectProject reports dependency versions and framework hints", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-project-"));

  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "vue-router-three-app",
        scripts: {
          build: "vue-cli-service build"
        },
        dependencies: {
          vue: "^2.6.14",
          "vue-router": "^3.5.1"
        },
        devDependencies: {
          "@vue/cli-service": "^5.0.8"
        }
      },
      null,
      2
    )
  );

  const project = await inspectProject(workspaceRoot);

  assert.equal(project.packageManager, "npm");
  assert.equal(project.packageName, "vue-router-three-app");
  assert.equal(project.dependencies["vue-router"], "^3.5.1");
  assert.equal(project.dependencies.vue, "^2.6.14");
  assert.equal(project.scripts.build, "vue-cli-service build");
  assert.deepEqual(project.frameworkHints, ["vue", "vue-router"]);
});
