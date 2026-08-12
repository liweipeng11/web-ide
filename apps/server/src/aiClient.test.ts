import test from "node:test";
import assert from "node:assert/strict";
import { deriveChatWorkspaceSearchTerms, derivePlanSearchKeywords, isIntermediateEditPlanSummary, isIntermediateEditStatus, requiresWorkspaceEvidenceForChat } from "./aiClient.js";

test("项目分析聊天必须先取得工作区证据", () => {
  assert.equal(requiresWorkspaceEvidenceForChat("分析一下 clr-vue-app 是一个什么项目"), true);
  assert.equal(requiresWorkspaceEvidenceForChat("为什么 router 配置报错"), true);
  assert.equal(requiresWorkspaceEvidenceForChat("你好，今天天气怎么样"), false);
});

test("项目分析仅提取简短目录或包名作为检索词", () => {
  assert.deepEqual(deriveChatWorkspaceSearchTerms("分析一下 clr-vue-app 是一个什么项目"), ["clr-vue-app"]);
  assert.deepEqual(deriveChatWorkspaceSearchTerms("请解释 src/router/index.ts 的职责"), ["index.ts"]);
});

test("uses structured edit status to identify intermediate agent states", () => {
  assert.equal(isIntermediateEditStatus("plan"), true);
  assert.equal(isIntermediateEditStatus("needs_context"), true);
  assert.equal(isIntermediateEditStatus("patch"), false);
  assert.equal(isIntermediateEditStatus("blocked"), false);
  assert.equal(isIntermediateEditStatus(undefined), false);
});

test("keeps legacy plan-summary detection as a fallback only", () => {
  assert.equal(isIntermediateEditPlanSummary("First search the route config, then create the Header component and integrate it into HomeView."), true);
  assert.equal(isIntermediateEditPlanSummary("The request cannot be completed safely with the available context."), false);
});

test("treats context-read summaries as intermediate edit states", () => {
  const previousFailureSummary = "\u9700\u8981\u8bfb\u53d6 mock API\u3001store\u3001HomeView \u548c LoginView \u4ee5\u4e86\u89e3\u9879\u76ee\u6570\u636e\u5c42\u548c\u89c6\u56fe\u6a21\u5f0f";
  const latestFailureSummary = "\u9700\u8981\u8bfb\u53d6 mock API\u3001HomeView\u3001store \u548c lang \u6587\u4ef6\u4e86\u89e3\u9879\u76ee\u6a21\u5f0f";

  assert.equal(isIntermediateEditPlanSummary(previousFailureSummary), true);
  assert.equal(isIntermediateEditPlanSummary(latestFailureSummary), true);
  assert.equal(isIntermediateEditPlanSummary("Need to read mock API, store, HomeView and LoginView files to understand the data layer pattern."), true);
});

test("derives useful fallback keywords when older models omit nextSearchKeywords", () => {
  const keywords = derivePlanSearchKeywords(
    "Add a header component to the home page for route navigation.",
    "First search the route config, then create the Header component and integrate it into HomeView."
  );

  assert.equal(keywords.includes("router"), true);
  assert.equal(keywords.includes("HomeView"), true);
  assert.equal(keywords.includes("Header"), true);
});

test("derives lang keywords from context-read summaries", () => {
  const keywords = derivePlanSearchKeywords(
    "\u65b0\u589e\u4e00\u4e2a\u7ba1\u7406\u9875\u9762",
    "\u9700\u8981\u8bfb\u53d6 mock API\u3001HomeView\u3001store \u548c lang \u6587\u4ef6\u4e86\u89e3\u9879\u76ee\u6a21\u5f0f"
  );

  assert.equal(keywords.includes("lang"), true);
});

test("keeps quoted button labels and Chinese UI phrases in fallback keywords", () => {
  const keywords = derivePlanSearchKeywords(
    "\u628a\u201c\u65b0\u589e\u5de5\u5177\u201d\u6309\u94ae\u6539\u6210\u4e8c\u7ea7\u6837\u5f0f\uff0c\u5e76\u627e\u5230 \"Add New Tool\" \u7684\u5b9a\u4e49\u4f4d\u7f6e\u3002",
    "\u9700\u8981\u5148\u641c\u7d22 'Add New Tool' \u6309\u94ae\u5728\u9879\u76ee\u4e2d\u7684\u4f4d\u7f6e\u3002"
  );

  assert.equal(keywords.includes("\u65b0\u589e\u5de5\u5177"), true);
  assert.equal(keywords.includes("Add New Tool"), true);
});

test("trims helper verbs from natural Chinese UI copy requests", () => {
  const keywords = derivePlanSearchKeywords(
    "\u628a\u65b0\u589e\u5de5\u5177\u6309\u94ae\u6539\u6210\u4e8c\u7ea7\u6837\u5f0f",
    "\u5148\u641c\u7d22\u65b0\u589e\u5de5\u5177\u6309\u94ae\u7684\u4f4d\u7f6e"
  );

  assert.equal(keywords.includes("\u65b0\u589e\u5de5\u5177"), true);
  assert.equal(keywords.includes("\u628a\u65b0\u589e\u5de5\u5177"), false);
});
