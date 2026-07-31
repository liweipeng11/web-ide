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

test("command prompts require cwd for a named subproject", () => {
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "pass that workspace-relative directory as runCommand.cwd");
  assertIncludes(AI_FILE_CHAT_SYSTEM_PROMPT, "cwd is required");
  assertIncludes(AI_FILE_CHAT_SYSTEM_PROMPT, "workspace-relative directory");
});

test("Agent Prompt 要求使用独占的显式完成协议", () => {
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "finish by calling it as the only tool call");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "Do not combine completeTask with edits");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "continue working if Runtime rejects the request");
});

test("Act Prompt 将完整未命中转换为创建动作并校验补丁后引用", () => {
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "Treat exhaustive target_absent evidence");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "stop searching for the same target");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "Do not require a file created by the current patch to exist before that patch");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "post-patch virtual file graph");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "do not replace an achievable edit with a manual tutorial");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "check whether a patch or file change exists");
  assertIncludes(AI_AGENT_ACT_SYSTEM_PROMPT, "only when Runtime reports a real authorization block");
});

test("多文件编辑 Prompt 允许安全的新路径且不放松已有引用校验", () => {
  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "A file created by the current patch is allowed to be absent before the patch");
  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "validate patch-internal references against the post-patch virtual file graph");
  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "A newly created filePath may be absent before the patch");
  assertIncludes(AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, "external dependencies and references that must already exist");
});
