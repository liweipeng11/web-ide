import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonModelResponse } from "./modelJsonResponse.js";

test("JSON Agent 在 content 为空时兼容解析 reasoning_content 中的 JSON", () => {
  const response = parseJsonModelResponse({
    agentName: "Developer",
    content: null,
    reasoningContent: '模型分析完成。\n{"type":"tool","tool":"list_directory","args":{}}'
  });

  assert.equal(response.source, "reasoning_content");
  assert.deepEqual(response.value, { type: "tool", tool: "list_directory", args: {} });
});

test("JSON Agent 在两个输出字段均为空时提供可诊断错误", () => {
  assert.throws(
    () => parseJsonModelResponse({ agentName: "Developer", content: null, reasoningContent: null }),
    /content 和 reasoning_content 均为空/
  );
});
