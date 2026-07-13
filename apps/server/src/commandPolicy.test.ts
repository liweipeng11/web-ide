import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCommandPolicy } from "./commandPolicy.js";

test("允许 workspace 子包中的标准验证脚本", () => {
  assert.equal(evaluateCommandPolicy("pnpm --dir apps/server typecheck").level, "safe");
  assert.equal(evaluateCommandPolicy("pnpm --dir apps/server test:unit").level, "safe");
  assert.equal(evaluateCommandPolicy("npm --prefix apps/web run build").level, "safe");
  assert.equal(evaluateCommandPolicy("pnpm lint:ci").level, "safe");
});

test("workspace 目录参数包含 shell 控制符时不进入白名单", () => {
  assert.equal(evaluateCommandPolicy("pnpm --dir apps/server && echo unsafe test").level, "confirm");
  assert.equal(evaluateCommandPolicy("pnpm test && echo unsafe").level, "confirm");
});
