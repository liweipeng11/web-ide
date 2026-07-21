import assert from "node:assert/strict";
import test from "node:test";
import { ConservativeTokenEstimator } from "../contextBudget/index.js";
import { createProjectMemoryV3Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import { buildBudgetedProjectMemoryPrompt } from "./memoryPromptBudget.js";
import type { ScoredProjectMemoryItem } from "./types.js";

function parseLine(prompt: string, prefix: string) {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  return JSON.parse(line?.slice(prefix.length) || "");
}

test("Prompt 使用近似 Token 预算且 Snapshot 与 Memory 分别分配预算", () => {
  const memory = createProjectMemoryV3Fixture();
  const scored: ScoredProjectMemoryItem[] = memory.items.map((item, index) => ({ item, score: 100 - index, reasons: ["request:test"] }));
  const result = buildBudgetedProjectMemoryPrompt(memory, scored, { tokenBudget: 420 });

  assert.ok(result.estimatedTokens <= 420);
  assert.ok(result.snapshotTokenBudget > 0);
  assert.ok(result.memoryTokenBudget > 0);
  assert.doesNotThrow(() => parseLine(result.prompt, "snapshotData="));
  assert.doesNotThrow(() => parseLine(result.prompt, "memoryItems="));
});

test("预算不足时舍弃完整 Memory 对象，不产生截断 JSON", () => {
  const memory = createProjectMemoryV3Fixture();
  const oversized = { ...memory.items[0]!, id: "oversized", content: "JWT ".repeat(2_000) };
  const result = buildBudgetedProjectMemoryPrompt(memory, [{ item: oversized, score: 100, reasons: ["request:jwt"] }], { tokenBudget: 260 });
  const parsed = parseLine(result.prompt, "memoryItems=") as unknown[];

  assert.deepEqual(parsed, []);
  assert.ok(new ConservativeTokenEstimator().estimateText(result.prompt) <= 260);
});

test("最低配置预算仍保留安全边界且不超限", () => {
  const result = buildBudgetedProjectMemoryPrompt(createProjectMemoryV3Fixture(), [], { tokenBudget: 128 });

  assert.ok(result.estimatedTokens <= 128);
  assert.match(result.prompt, /untrusted historical context/i);
  assert.doesNotThrow(() => parseLine(result.prompt, "snapshotData="));
  assert.doesNotThrow(() => parseLine(result.prompt, "memoryItems="));
});

test("低 Memory 预算不会挤占 Snapshot 风险预算", () => {
  const fixture = createProjectMemoryV3Fixture();
  const memory = createProjectMemoryV3Fixture({ snapshot: { ...fixture.snapshot, confirmedRisks: ["不得覆盖损坏文件"] } });
  const result = buildBudgetedProjectMemoryPrompt(memory, [], { tokenBudget: 360 });
  const snapshot = parseLine(result.prompt, "snapshotData=") as { confirmedRisks?: string[] };

  assert.deepEqual(snapshot.confirmedRisks, ["不得覆盖损坏文件"]);
});
