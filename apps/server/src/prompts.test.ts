import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_AGENT_ACT_SYSTEM_PROMPT,
  AI_AGENT_CONTEXT_BUDGET_PROMPT,
  AI_AGENT_DISCOVERY_STRATEGY_PROMPT,
  AI_FILE_CHAT_SYSTEM_PROMPT,
  AI_MULTI_FILE_EDIT_SYSTEM_PROMPT
} from "./prompts.js";

function assertIncludes(prompt: string, expected: string) {
  assert.match(prompt, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}

test("shared discovery strategy describes task-based tool scheduling", () => {
  // 锁定第七阶段的核心调度语义，避免后续改 prompt 时退回到单一 searchCode 起手。
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "File or path unknown: use searchFilesByName");
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "use listFiles when a likely directory is known");
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "use listCodeDefinitionNames before readFile");
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "use searchCode for literal identifiers");
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "use searchCodeRegex for import/export shapes");
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "treat readFile as the first chunk only");
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "Already read same file and same line range");
  assertIncludes(AI_AGENT_DISCOVERY_STRATEGY_PROMPT, "stop broad discovery");
});

test("shared context budget keeps exploration bounded", () => {
  // 这些约束直接对应“减少低效探索”的阶段目标。
  assertIncludes(AI_AGENT_CONTEXT_BUDGET_PROMPT, "Infer 1 to 4 concise discovery terms");
  assertIncludes(AI_AGENT_CONTEXT_BUDGET_PROMPT, "never pass the full user request as a query");
  assertIncludes(AI_AGENT_CONTEXT_BUDGET_PROMPT, "Read at most 8 files automatically");
  assertIncludes(AI_AGENT_CONTEXT_BUDGET_PROMPT, "Do not call readFile more than once");
  assertIncludes(AI_AGENT_CONTEXT_BUDGET_PROMPT, "cached:true");
});

test("agent, edit, and chat prompts all include the shared discovery strategy", () => {
  const prompts = [AI_AGENT_ACT_SYSTEM_PROMPT, AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, AI_FILE_CHAT_SYSTEM_PROMPT];

  for (const prompt of prompts) {
    assertIncludes(prompt, "Discovery scheduling strategy");
    assertIncludes(prompt, "Context budget rules");
    assertIncludes(prompt, "searchFilesByName");
    assertIncludes(prompt, "listCodeDefinitionNames");
    assertIncludes(prompt, "analyzeSymbolGraph");
    assertIncludes(prompt, "analyzeImpact");
    assertIncludes(prompt, "readFileChunk");
  }

  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "Before implementing or editing code, call findSimilarPatterns");
  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "Before implementing or editing code, call checkExistence");
  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "Treat its target files as the minimal edit set");
  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "Do not edit an impacted file merely because analyzeImpact returned it");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "Before changing a shared symbol");
});
