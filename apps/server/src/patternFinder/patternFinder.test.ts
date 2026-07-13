import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findSimilarPatterns } from "./patternFinder.js";

async function createWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-pattern-finder-"));
}

test("findSimilarPatterns prioritizes same-directory services and reports reusable features", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src", "services"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "src", "routes"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "userService.ts"), "import { request } from '../request';\nexport async function getUser() { try { return request.get('/user'); } catch (error) { throw new Error('failed'); } }\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "userService.test.ts"), "import test from 'node:test';\ntest('user', () => {});\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "routes", "userRoute.ts"), "export function userRoute() {}\n", "utf8");

  const result = await findSimilarPatterns(workspaceRoot, {
    taskDescription: "新增订单服务并处理请求异常",
    targetPath: "src/services/orderService.ts",
    targetResponsibility: "service"
  });

  assert.equal(result.candidates[0]?.filePath, "src/services/userService.ts");
  assert.ok(result.candidates[0]?.reasons.includes("与目标文件位于同一目录"));
  assert.ok(result.candidates[0]?.reusableElements.some((item) => item.includes("错误处理")));
  assert.deepEqual(result.candidates[0]?.relatedTests, ["src/services/userService.test.ts"]);
});

test("findSimilarPatterns uses target imports and error handling to rank implementation patterns", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src", "services"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "target.ts"), "import { request } from '../request';\nexport async function target() { try { return request.get('/target'); } catch (error) { throw new Error('failed'); } }\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "matching.ts"), "import { request } from '../request';\nexport async function matching() { try { return request.get('/match'); } catch (error) { throw new Error('failed'); } }\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "plain.ts"), "export function plain() { return true; }\n", "utf8");

  const result = await findSimilarPatterns(workspaceRoot, {
    taskDescription: "扩展服务实现",
    targetPath: "src/services/target.ts",
    targetResponsibility: "service"
  });

  assert.equal(result.candidates[0]?.filePath, "src/services/matching.ts");
  assert.ok(result.candidates[0]?.reasons.some((item) => item.includes("相同导入依赖")));
  assert.ok(result.candidates[0]?.reasons.some((item) => item.includes("错误处理模式")));
});

test("findSimilarPatterns extracts Python imports, definitions, and structural patterns", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src", "services"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "target.py"), "from app.client import request\n\nasync def target():\n    try:\n        return await request.get('/target')\n    except Exception:\n        raise RuntimeError('failed')\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "matching.py"), "from app.client import request\n\nasync def matching():\n    try:\n        return await request.get('/matching')\n    except Exception:\n        raise RuntimeError('failed')\n", "utf8");

  const result = await findSimilarPatterns(workspaceRoot, {
    taskDescription: "扩展 Python 服务",
    targetPath: "src/services/target.py",
    targetResponsibility: "service"
  });

  assert.equal(result.candidates[0]?.filePath, "src/services/matching.py");
  assert.ok(result.candidates[0]?.reusableElements.some((item) => item.includes("顶层定义：matching")));
  assert.ok(result.candidates[0]?.reasons.some((item) => item.includes("代码结构特征")));
});

test("findSimilarPatterns returns an explicit fallback when no related implementation exists", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "plain.ts"), "export const value = true;\n", "utf8");

  const result = await findSimilarPatterns(workspaceRoot, { taskDescription: "实现支付网关同步" });

  assert.deepEqual(result.candidates, []);
  assert.match(result.noMatchReason || "", /未找到/);
});
