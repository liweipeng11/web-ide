import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../errors.js";
import { ensureMemoryContentIsSafe, findSensitiveMemoryReason, normalizeMemoryContent, normalizeMemoryScope } from "./memorySanitizer.js";

test("候选文本规范化空白、换行和 Unicode", () => {
  assert.equal(normalizeMemoryContent("  使用　pnpm\r\n\r\n  执行测试  "), "使用 pnpm\n执行测试");
});

test("敏感信息检测覆盖密钥、连接串、邮箱和手机号", () => {
  const samples = [
    "API_KEY=secret-value-123456",
    "postgres://admin:password@localhost:5432/app",
    "联系 dev@example.com",
    "手机号 13800138000",
    "-----BEGIN PRIVATE KEY-----"
  ];
  samples.forEach((sample) => assert.ok(findSensitiveMemoryReason(sample)));
  assert.throws(() => ensureMemoryContentIsSafe(samples[0]), (error) => error instanceof HttpError && error.status === 400 && !error.message.includes("secret-value"));
});

test("作用域严格校验类型、路径数量和项目级空路径", () => {
  assert.deepEqual(normalizeMemoryScope({ type: "path", paths: ["src\\api.ts", "src/api.ts"] }), { type: "path", paths: ["src/api.ts"] });
  assert.throws(() => normalizeMemoryScope({ type: "project", paths: ["src"] }), /cannot contain paths/);
  assert.throws(() => normalizeMemoryScope({ type: "path", paths: [] }), /requires at least one path/);
});
