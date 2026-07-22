import assert from "node:assert/strict";
import test from "node:test";
import { isFailedCommandResult } from "./commandResults.js";
import type { CommandResult } from "./types.js";

function result(status: NonNullable<CommandResult["status"]>, exitCode: number | null): CommandResult {
  return {
    command: "npm run serve",
    cwd: "C:/workspace",
    exitCode,
    stdout: "",
    stderr: "",
    status,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

test("running command with null exit code is not a failed record", () => {
  assert.equal(isFailedCommandResult(result("running", null)), false);
});

test("only failed and timeout states are failed records", () => {
  assert.equal(isFailedCommandResult(result("failed", 1)), true);
  assert.equal(isFailedCommandResult(result("timeout", null)), true);
  assert.equal(isFailedCommandResult(result("success", 0)), false);
});
