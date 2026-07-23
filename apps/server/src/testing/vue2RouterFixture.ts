import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Vue2RouterFixture = {
  fixtureRoot: string;
  projectRoot: string;
  projectPath: string;
  cleanup: () => Promise<void>;
};

const projectDirectoryName = "clr-vue-app";

/**
 * 创建完全离线的 Vue 2 路由回归夹具。
 *
 * fixtureRoot 故意位于项目目录上层，用于稳定复现当前实现无法从子包边界
 * 解析依赖和 Vue CLI 默认别名的问题；后续阶段应继续复用同一目录结构。
 */
export async function createVue2RouterFixture(): Promise<Vue2RouterFixture> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-vue2-router-"));
  const projectRoot = path.join(fixtureRoot, projectDirectoryName);

  await Promise.all([
    fs.mkdir(path.join(projectRoot, "node_modules", "vue-router"), { recursive: true }),
    fs.mkdir(path.join(projectRoot, "src", "views"), { recursive: true })
  ]);

  await Promise.all([
    fs.writeFile(
      path.join(projectRoot, "package.json"),
      `${JSON.stringify({
        name: "clr-vue-app",
        private: true,
        dependencies: {
          vue: "^2.7.16",
          "vue-router": "^3.6.5"
        }
      }, null, 2)}\n`,
      "utf8"
    ),
    fs.writeFile(
      path.join(projectRoot, "node_modules", "vue-router", "package.json"),
      `${JSON.stringify({ name: "vue-router", version: "3.6.5", main: "dist/vue-router.common.js" }, null, 2)}\n`,
      "utf8"
    ),
    fs.writeFile(
      path.join(projectRoot, "src", "App.vue"),
      "<template><router-view /></template>\n",
      "utf8"
    ),
    fs.writeFile(
      path.join(projectRoot, "src", "main.js"),
      [
        "import Vue from \"vue\";",
        "import App from \"./App.vue\";",
        "",
        "new Vue({",
        "  render: (createElement) => createElement(App)",
        "}).$mount(\"#app\");",
        ""
      ].join("\n"),
      "utf8"
    ),
    fs.writeFile(
      path.join(projectRoot, "src", "views", "createuserid.vue"),
      "<template><main>创建用户 ID</main></template>\n",
      "utf8"
    )
  ]);

  return {
    fixtureRoot,
    projectRoot,
    projectPath: projectDirectoryName,
    cleanup: () => fs.rm(fixtureRoot, { recursive: true, force: true })
  };
}
