import assert from "node:assert/strict";
import test from "node:test";
import { parseVerificationFailure } from "./failureParser.js";
import type { CommandResult } from "../types.js";

function failedResult(stderr: string): CommandResult {
  return {
    command: "pnpm typecheck",
    cwd: "C:/workspace",
    exitCode: 2,
    stdout: "",
    stderr,
    status: "failed",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

test("解析 TypeScript 错误的文件、行列和错误码", () => {
  const issues = parseVerificationFailure(failedResult("src/userService.ts(8,15): error TS2322: Type 'number' is not assignable to type 'string'."), "typecheck");

  assert.deepEqual(issues[0], {
    category: "type",
    file: "src/userService.ts",
    line: 8,
    column: 15,
    code: "TS2322",
    message: "Type 'number' is not assignable to type 'string'."
  });
});

test("无法定位文件时仍保留可用于回修的输出摘要", () => {
  const issues = parseVerificationFailure(failedResult("Test suite failed before execution"), "test");

  assert.equal(issues[0].category, "test");
  assert.match(issues[0].message, /failed before execution/);
});

test("解析 ESLint stylish 输出中的文件和规则", () => {
  const issues = parseVerificationFailure(
    failedResult("C:\\workspace\\src\\App.tsx\n  12:7  error  'value' is assigned a value but never used  @typescript-eslint/no-unused-vars"),
    "lint"
  );

  assert.deepEqual(issues[0], {
    category: "lint",
    file: "C:/workspace/src/App.tsx",
    line: 12,
    column: 7,
    code: "@typescript-eslint/no-unused-vars",
    message: "'value' is assigned a value but never used"
  });
});

test("解析 Vitest 堆栈和 Python traceback 定位", () => {
  const vitestIssues = parseVerificationFailure(failedResult("❯ src/userService.test.ts:24:11"), "test");
  const pythonIssues = parseVerificationFailure(failedResult('File "services/user_service.py", line 18, in load_user'), "test");

  assert.equal(vitestIssues[0].file, "src/userService.test.ts");
  assert.equal(vitestIssues[0].line, 24);
  assert.equal(pythonIssues[0].file, "services/user_service.py");
  assert.equal(pythonIssues[0].line, 18);
});
