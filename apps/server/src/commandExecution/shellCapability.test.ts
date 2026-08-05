import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCommandShellPrompt, createCommandEnvironment, resolveShellLaunch } from "./shellCapability.js";

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

test("Windows Agent 向模型提供 PowerShell 语法约束", () => {
  const prompt = createAgentCommandShellPrompt({ platform: "win32", environment: {} });

  assert.match(prompt, /Windows PowerShell/);
  assert.match(prompt, /禁止使用.*&&.*\|\|/s);
  assert.match(prompt, /\$LASTEXITCODE/);
  assert.match(prompt, /Test-Path/);
});

test("macOS 和 Linux Agent 向模型提供实际 Shell 的 Unix 语法约束", () => {
  const macPrompt = createAgentCommandShellPrompt({ platform: "darwin", environment: { SHELL: "/bin/zsh" } });
  const linuxPrompt = createAgentCommandShellPrompt({ platform: "linux", environment: { SHELL: "/bin/bash" } });

  assert.match(macPrompt, /macOS/);
  assert.match(macPrompt, /zsh/);
  assert.match(macPrompt, /Zsh\/POSIX/);
  assert.match(linuxPrompt, /Linux/);
  assert.match(linuxPrompt, /bash/);
  assert.match(linuxPrompt, /&&、\|\|、2>&1/);
});

test("Fish Shell 不被错误描述为 POSIX Shell", () => {
  const prompt = createAgentCommandShellPrompt({ platform: "linux", environment: { SHELL: "/usr/bin/fish" } });

  assert.match(prompt, /Fish 语法/);
  assert.match(prompt, /不要假定 Bash\/Zsh/);
});
