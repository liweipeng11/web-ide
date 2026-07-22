import assert from "node:assert/strict";
import test from "node:test";
import { createCommandEnvironment, resolveShellLaunch } from "./shellCapability.js";

test("Windows Agent 优先使用 PowerShell，手工终端使用 CMD", () => {
  const agent = resolveShellLaunch("npm test", { platform: "win32", environment: {}, initiator: "agent" });
  assert.equal(agent.name, "powershell");
  assert.equal(agent.capability, "rich");
  assert.deepEqual(agent.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);

  const user = resolveShellLaunch("npm test", { platform: "win32", environment: { ComSpec: "custom-cmd.exe" }, initiator: "user" });
  assert.equal(user.file, "custom-cmd.exe");
  assert.equal(user.capability, "basic");
});

test("Agent 标识始终注入，CI 仅在显式确认时注入", () => {
  const agent = createCommandEnvironment({ initiator: "agent" }, { PATH: "test" });
  assert.equal(agent.MINI_AI_AGENT, "1");
  assert.equal(agent.CI, undefined);

  const validation = createCommandEnvironment({ initiator: "validation", ci: true }, {});
  assert.equal(validation.MINI_AI_AGENT, "1");
  assert.equal(validation.CI, "1");

  const user = createCommandEnvironment({ initiator: "user" }, {});
  assert.equal(user.MINI_AI_AGENT, undefined);
});
