import assert from "node:assert/strict";
import test from "node:test";
import { login } from "../src/auth.js";

test("同一用户第 6 次登录返回 429", () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(login("alice").status, 200);
  }
  assert.equal(login("alice").status, 429);
});
