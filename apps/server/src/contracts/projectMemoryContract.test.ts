import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const expectedStatusMembers = ["candidate", "active", "stale", "rejected", "superseded", "archived"];
const expectedSourceMembers = ["schema_migration", "task", "user", "file", "symbol", "dependency", "git_commit", "branch"];

test("前端 Project Memory 契约覆盖服务端 V3 枚举与审计字段", async () => {
  const apiSource = await fs.readFile(path.resolve(process.cwd(), "../web/src/api.ts"), "utf8");
  for (const member of [...expectedStatusMembers, ...expectedSourceMembers]) {
    assert.match(apiSource, new RegExp(`["]${member}["]`), `前端契约缺少 ${member}`);
  }
  for (const field of ["validationStatus", "lastValidatedAt", "promotedTo", "MemoryUsageRecord"]) {
    assert.match(apiSource, new RegExp(`\\b${field}\\b`), `前端契约缺少 ${field}`);
  }
});
