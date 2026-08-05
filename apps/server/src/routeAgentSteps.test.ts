import test from "node:test";
import assert from "node:assert/strict";
import { createProgressiveDeliveryStep } from "./routeAgentSteps.js";

test("渐进交付步骤事件包含中文说明和结构化详情", () => {
  const step = createProgressiveDeliveryStep({
    event: "tool_failure_recorded",
    details: { toolName: "readFile", retryable: false }
  });

  assert.equal(step.type, "tool_failure_recorded");
  assert.match(step.message, /已记录/);
  assert.deepEqual(step.details, { toolName: "readFile", retryable: false });
});
