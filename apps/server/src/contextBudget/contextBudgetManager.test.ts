import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "../contracts/model.js";
import { normalizeToolArtifacts } from "./artifactNormalizer.js";
import { prepareContextBudget } from "./contextBudgetManager.js";
import { ConservativeTokenEstimator } from "./tokenEstimator.js";

const agentContext = {
  userGoal: "修复构建失败并保留审批状态",
  filesRead: ["src/a.ts"], searchQueries: [], searchResultFiles: [], relevantFiles: ["src/a.ts"],
  patternSearchPerformed: false, patternCandidateFiles: [], existenceCheckPerformed: false, unresolvedExistenceChecks: [],
  commandsRun: [{ command: "pnpm test", status: "failed" as const, exitCode: 1 }], externalSources: []
};

test("超出输入预算时保留系统规则和当前目标，并生成结构化摘要", () => {
  const messages: ModelMessage[] = [
    { id: "system-1", role: "system", content: "安全规则：不得执行危险命令。" },
    { id: "user-old", role: "user", content: "旧问题".repeat(500) },
    { id: "assistant-old", role: "assistant", content: "旧分析".repeat(500) },
    { id: "tool-failure", role: "tool", toolCallId: "validation-1", content: JSON.stringify({ error: "TypeScript validation failed", exitCode: 1 }) },
    { id: "user-current", role: "user", content: "请继续修复并等待审批" }
  ];
  const pendingToolCall = { actionId: "approval-1", toolCallId: "edit-1", toolName: "writeFile", arguments: { filePath: "src/a.ts" }, riskLevel: "medium" as const, status: "pending" as const, createdAt: Date.now(), agentContext };
  const result = prepareContextBudget({ messages, agentContext, pendingToolCall, options: { contextWindowTokens: 1_100, reservedOutputTokens: 200, safetyMarginTokens: 100 } });

  assert.equal(result.snapshot.automaticCompression, true);
  assert.ok(result.snapshot.estimatedInputTokensAfterCompression <= result.snapshot.availableInputTokens);
  assert.ok(result.messages.some((message) => message.id === "system-1"));
  assert.ok(result.messages.some((message) => message.id === "user-current"));
  assert.equal(result.summary?.pendingApproval?.actionId, "approval-1");
  assert.ok(result.summary?.coveredMessageIds.includes("user-old"));
  assert.ok(result.summary?.recentValidationFailures.length);
});

test("连续三次读取同一文件时后续产物改为可恢复引用", () => {
  const payload = JSON.stringify({ filePath: "src/a.ts", content: "const answer = 42;" });
  const messages: ModelMessage[] = [
    { role: "assistant", toolCalls: [{ id: "read-1", name: "readFile", arguments: { filePath: "src/a.ts" } }] },
    { role: "tool", toolCallId: "read-1", content: payload },
    { role: "assistant", toolCalls: [{ id: "read-2", name: "readFile", arguments: { filePath: "src/a.ts" } }] },
    { role: "tool", toolCallId: "read-2", content: payload },
    { role: "assistant", toolCalls: [{ id: "read-3", name: "readFile", arguments: { filePath: "src/a.ts" } }] },
    { role: "tool", toolCallId: "read-3", content: payload }
  ];
  const result = normalizeToolArtifacts(messages, new ConservativeTokenEstimator());
  const secondArtifact = JSON.parse(result.messages[3]?.content || "{}") as { content?: { reusedArtifactId?: string }; recoverableReference?: string };
  const thirdArtifact = JSON.parse(result.messages[5]?.content || "{}") as { content?: { reusedArtifactId?: string }; recoverableReference?: string };

  assert.equal(result.includedFileCount, 1);
  assert.equal(result.truncatedArtifactCount, 2);
  assert.ok(secondArtifact.content?.reusedArtifactId);
  assert.equal(secondArtifact.recoverableReference, "tool-call:read-2");
  assert.ok(thirdArtifact.content?.reusedArtifactId);
  assert.equal(thirdArtifact.recoverableReference, "tool-call:read-3");
});

test("预算淘汰优先移除 P4 重复产物并保留 P1 失败证据", () => {
  const repeated = JSON.stringify({ files: ["src/a.ts"], content: "search-result".repeat(500) });
  const failure = JSON.stringify({ error: "TS2322 validation failed", details: "failure-context".repeat(180) });
  const messages: ModelMessage[] = [
    { id: "system-priority", role: "system", content: "安全规则" },
    { id: "search-call-1", role: "assistant", toolCalls: [{ id: "search-1", name: "searchCode", arguments: { query: "target" } }] },
    { id: "search-result-1", role: "tool", toolCallId: "search-1", content: repeated },
    { id: "search-call-2", role: "assistant", toolCalls: [{ id: "search-2", name: "searchCode", arguments: { query: "target" } }] },
    { id: "search-result-2", role: "tool", toolCallId: "search-2", content: repeated },
    { id: "validation-call", role: "assistant", toolCalls: [{ id: "validation-1", name: "runValidation", arguments: {} }] },
    { id: "validation-result", role: "tool", toolCallId: "validation-1", content: failure },
    { id: "current-priority", role: "user", content: "继续修复" }
  ];
  const result = prepareContextBudget({ messages, agentContext, options: { contextWindowTokens: 2_800, reservedOutputTokens: 300, safetyMarginTokens: 100 } });

  assert.equal(result.snapshot.automaticCompression, true);
  assert.ok(result.summary?.coveredMessageIds.includes("search-result-2"));
  assert.ok(result.messages.some((message) => message.id === "validation-result"));
});

test("成功命令长输出仅保留尾部，失败输出保留错误证据", () => {
  const messages: ModelMessage[] = [
    { role: "assistant", toolCalls: [{ id: "cmd-1", name: "runCommand", arguments: { command: "pnpm test" } }] },
    { role: "tool", toolCallId: "cmd-1", content: JSON.stringify({ exitCode: 0, stdout: `${"noise\n".repeat(1_000)}SUCCESS_TAIL` }) },
    { role: "assistant", toolCalls: [{ id: "cmd-2", name: "runCommand", arguments: { command: "pnpm typecheck" } }] },
    { role: "tool", toolCallId: "cmd-2", content: JSON.stringify({ exitCode: 1, stderr: `${"prefix\n".repeat(1_000)}TS2322 failure` }) }
  ];
  const result = normalizeToolArtifacts(messages, new ConservativeTokenEstimator());

  assert.match(result.messages[1]?.content || "", /SUCCESS_TAIL/);
  assert.match(result.messages[3]?.content || "", /TS2322 failure/);
  assert.equal(result.truncatedArtifactCount, 2);
});
