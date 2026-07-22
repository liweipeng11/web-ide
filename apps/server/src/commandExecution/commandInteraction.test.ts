import assert from "node:assert/strict";
import test from "node:test";
import { detectCommandInteraction, sanitizeSensitiveOutput } from "./commandInteraction.js";

test("识别常见敏感交互提示", () => {
  assert.equal(detectCommandInteraction("Password: "), "password");
  assert.equal(detectCommandInteraction("Enter passphrase: "), "passphrase");
  assert.equal(detectCommandInteraction("Verification code: "), "verification_code");
  assert.equal(detectCommandInteraction("Confirm login [y/n] "), "login_confirmation");
  assert.equal(detectCommandInteraction("build complete"), null);
});

test("发送给模型的输出隐藏敏感值", () => {
  const sanitized = sanitizeSensitiveOutput("Password: hunter2\nAPI_KEY=secret-value\nresult ok");
  assert.doesNotMatch(sanitized, /hunter2|secret-value/);
  assert.match(sanitized, /\[REDACTED\]/);
  assert.match(sanitized, /result ok/);
});
