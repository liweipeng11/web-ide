import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendShadowComparisonMetric,
  compareShadowResults,
  shadowDurationBucket,
  type ShadowComparisonMetric
} from "./shadowComparison.js";

test("Shadow 对照只返回固定差异维度，不泄露描述值", () => {
  const comparison = compareShadowResults(
    { outcome: "executed", result_status: "success", route: "secret-legacy-route" },
    { outcome: "executed", result_status: "failed", route: "secret-next-route" }
  );

  assert.deepEqual(comparison, {
    comparedDimensions: 3,
    differingDimensions: ["result_status", "route"],
    equivalent: false
  });
  const serialized = JSON.stringify(comparison);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("success"), false);
  assert.equal(serialized.includes("failed"), false);
});

test("Shadow 耗时仅保留固定区间", () => {
  assert.equal(shadowDurationBucket(99), "lt_100ms");
  assert.equal(shadowDurationBucket(100), "lt_500ms");
  assert.equal(shadowDurationBucket(1_999), "lt_2s");
  assert.equal(shadowDurationBucket(2_000), "lt_10s");
  assert.equal(shadowDurationBucket(10_000), "gte_10s");
});

test("Shadow 指标以可独立解析的 JSONL 持久化且不含业务内容", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-shadow-"));
  const filePath = path.join(directory, "metrics.jsonl");
  const metric: ShadowComparisonMetric = {
    schemaVersion: 1,
    recordedAt: "2026-08-14T00:00:00.000Z",
    mode: "shadow",
    selected: "legacy",
    legacyStatus: "completed",
    nextStatus: "completed",
    legacyDuration: "lt_100ms",
    nextDuration: "lt_500ms",
    comparison: { comparedDimensions: 3, differingDimensions: [], equivalent: true }
  };

  try {
    await Promise.all([
      appendShadowComparisonMetric(metric, filePath),
      appendShadowComparisonMetric({ ...metric, nextStatus: "failed", comparison: undefined }, filePath)
    ]);
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).nextStatus), ["completed", "failed"]);
    assert.equal(lines.join("\n").includes("Prompt"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
