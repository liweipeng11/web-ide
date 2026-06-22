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
