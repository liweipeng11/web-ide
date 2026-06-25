import test from "node:test";
import assert from "node:assert/strict";
import { createEditHunks } from "./diffTools.js";

test("createEditHunks returns structured local diff hunks", () => {
  const hunks = createEditHunks("one\ntwo\nthree\n", "one\ntwo updated\nthree\n");

  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].oldStart, 1);
  assert.equal(hunks[0].newStart, 1);
  assert.ok(hunks[0].lines.some((line) => line.type === "remove" && line.content === "two"));
  assert.ok(hunks[0].lines.some((line) => line.type === "add" && line.content === "two updated"));
});
