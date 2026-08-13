import assert from "node:assert/strict";
import test from "node:test";
import { buildPlannerToolPrompt } from "./prompt.js";
import { createAgentState } from "../../runtime/stateManager.js";

test("Planner 工具提示限制累计 observation 大小并保留最新证据", () => {
  const observations = Array.from({ length: 30 }, (_, index) => ({
    tool: "read_file",
    result: { index, content: "x".repeat(4_000) }
  }));
  const prompt = JSON.parse(buildPlannerToolPrompt({
    phase: "create",
    request: {
      goal: "迁移登录页面",
      knownFacts: [],
      constraints: [],
      readScope: ["src/**"],
      writeScope: ["src/**"],
      state: createAgentState("迁移登录页面")
    },
    availableTools: [],
    observations,
    readToolCallCount: 30,
    maxReadToolCalls: 30,
    forceFinalization: true
  })) as { observations: Array<{ result: { preview?: string; index?: number } }>; observationWindow: { total: number; retained: number; truncated: boolean } };

  assert.equal(prompt.observationWindow.total, 30);
  assert.equal(prompt.observationWindow.truncated, true);
  assert.ok(prompt.observationWindow.retained < 30);
  assert.equal(prompt.observations.at(-1)?.result.preview?.length, 3_000);
});
