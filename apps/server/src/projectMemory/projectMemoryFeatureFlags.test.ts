import assert from "node:assert/strict";
import test from "node:test";
import { defaultProjectMemoryFeatureFlags, isProjectMemoryFeatureEnabled, readProjectMemoryFeatureFlags } from "./projectMemoryFeatureFlags.js";
import { createMemoryCandidate } from "./memoryCandidateService.js";
import { storeMemoryExtractionResult } from "./memoryExtractionService.js";

test("Memory 灰度开关默认保持阶段 5 已上线行为", () => {
  assert.deepEqual(readProjectMemoryFeatureFlags({}), defaultProjectMemoryFeatureFlags);
});

test("五个环境变量支持常见布尔值并对非法值安全回退", () => {
  const flags = readProjectMemoryFeatureFlags({
    PROJECT_MEMORY_V3_ENABLED: "false",
    PROJECT_MEMORY_AUTO_EXTRACTION_ENABLED: "0",
    PROJECT_MEMORY_RETRIEVAL_ENABLED: "no",
    PROJECT_MEMORY_VALIDATION_ENABLED: "off",
    PROJECT_MEMORY_USAGE_LOG_ENABLED: "unexpected"
  });
  assert.deepEqual(flags, {
    v3Enabled: false,
    autoExtractionEnabled: false,
    retrievalEnabled: false,
    validationEnabled: false,
    usageLogEnabled: true
  });
});

test("V3 总开关关闭时所有子能力统一回滚", () => {
  const flags = { ...defaultProjectMemoryFeatureFlags, v3Enabled: false };
  assert.equal(isProjectMemoryFeatureEnabled("retrievalEnabled", flags), false);
  assert.equal(isProjectMemoryFeatureEnabled("validationEnabled", flags), false);
  assert.equal(isProjectMemoryFeatureEnabled("usageLogEnabled", flags), false);
});

test("生产写入链路遵守 V3 总开关和自动抽取开关", async (context) => {
  const previousV3 = process.env.PROJECT_MEMORY_V3_ENABLED;
  const previousExtraction = process.env.PROJECT_MEMORY_AUTO_EXTRACTION_ENABLED;
  context.after(() => {
    if (previousV3 === undefined) delete process.env.PROJECT_MEMORY_V3_ENABLED;
    else process.env.PROJECT_MEMORY_V3_ENABLED = previousV3;
    if (previousExtraction === undefined) delete process.env.PROJECT_MEMORY_AUTO_EXTRACTION_ENABLED;
    else process.env.PROJECT_MEMORY_AUTO_EXTRACTION_ENABLED = previousExtraction;
  });

  process.env.PROJECT_MEMORY_V3_ENABLED = "0";
  await assert.rejects(() => createMemoryCandidate({
    kind: "fact",
    content: "Project Memory rollback test",
    sourceRefs: [{ type: "user", value: "test-message" }],
    createdBy: "user",
    confidence: 1
  }), /V3 is disabled/);

  process.env.PROJECT_MEMORY_V3_ENABLED = "1";
  process.env.PROJECT_MEMORY_AUTO_EXTRACTION_ENABLED = "0";
  const result = await storeMemoryExtractionResult({ candidates: [] }, []);
  assert.deepEqual(result, {
    candidates: [],
    duplicateCount: 0,
    rejectedCount: 0,
    error: "Project Memory auto extraction is disabled"
  });
});
