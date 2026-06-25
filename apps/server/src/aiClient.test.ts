import test from "node:test";
import assert from "node:assert/strict";
import { derivePlanSearchKeywords, isIntermediateEditPlanSummary, isIntermediateEditStatus } from "./aiClient.js";

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

test("derives useful fallback keywords when older models omit nextSearchKeywords", () => {
  const keywords = derivePlanSearchKeywords(
    "Add a header component to the home page for route navigation.",
    "First search the route config, then create the Header component and integrate it into HomeView."
  );

  assert.equal(keywords.includes("router"), true);
  assert.equal(keywords.includes("HomeView"), true);
  assert.equal(keywords.includes("Header"), true);
});

test("keeps quoted button labels and Chinese UI phrases in fallback keywords", () => {
  const keywords = derivePlanSearchKeywords(
    "把“新增工具”按钮改成二级样式，并找到 \"Add New Tool\" 的定义位置。",
    "需要先搜索 'Add New Tool' 按钮在项目中的位置。"
  );

  assert.equal(keywords.includes("新增工具"), true);
  assert.equal(keywords.includes("Add New Tool"), true);
});

test("trims helper verbs from natural Chinese UI copy requests", () => {
  const keywords = derivePlanSearchKeywords(
    "把新增工具按钮改成二级样式",
    "先搜索新增工具按钮的位置"
  );

  assert.equal(keywords.includes("新增工具"), true);
  assert.equal(keywords.includes("把新增工具"), false);
});
