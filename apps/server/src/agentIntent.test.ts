import test from "node:test";
import assert from "node:assert/strict";
import { buildContextualEditRequest, ensureEditableAgentRequestClassification, inferAgentRequestClassification, shouldGeneratePatchForIntent } from "./aiClient.js";
import type { FileChatMessage } from "./types.js";

test("routes warning plus repair requests to diagnose_then_edit in local fallback routing", () => {
  const classification = inferAgentRequestClassification(
    "运行发生警告：export 'createWebHistory' was not found in 'vue-router' 进行修复"
  );

  assert.equal(classification.intent, "diagnose_then_edit");
  assert.equal(shouldGeneratePatchForIntent(classification.intent), true);
});

test("direct edit classification preserves bugfix intent and upgrades read-only intent", () => {
  const bugfix = ensureEditableAgentRequestClassification({ intent: "diagnose_then_edit", confidence: 0.9, normalizedGoal: "修复构建失败", reason: "test" });
  const inspect = ensureEditableAgentRequestClassification({ intent: "inspect", confidence: 0.7, normalizedGoal: "分析并处理模块", reason: "test" });

  assert.equal(bugfix.intent, "diagnose_then_edit");
  assert.equal(inspect.intent, "edit");
  assert.match(inspect.reason, /direct edit endpoint/);
});

test("uses recent editable context for natural continuation requests", () => {
  const history: FileChatMessage[] = [
    {
      id: "user-1",
      role: "user",
      content: "首页工具卡片样式丢失，先分析原因",
      createdAt: new Date().toISOString()
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "需要修改 src/views/HomeView.vue 中的工具卡片样式，并补充 scoped CSS。",
      createdAt: new Date().toISOString()
    }
  ];
  const editRequest = buildContextualEditRequest(history, "按这个处理", "修复首页工具卡片样式丢失问题");

  assert.match(editRequest, /HomeView\.vue/);
  assert.match(editRequest, /按这个处理/);
});

test("does not treat short requests with explicit new targets as contextual follow-ups", () => {
  const history: FileChatMessage[] = [
    {
      id: "user-1",
      role: "user",
      content: "首页工具卡片样式丢失，先分析原因",
      createdAt: new Date().toISOString()
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "需要修改 src/views/HomeView.vue 中的工具卡片样式。",
      createdAt: new Date().toISOString()
    }
  ];
  const editRequest = buildContextualEditRequest(history, "改 App.tsx", undefined);

  assert.equal(editRequest, "改 App.tsx");
});

test("expands short edit follow-ups with recent conversation context", () => {
  const history: FileChatMessage[] = [
    {
      id: "user-1",
      role: "user",
      content: "运行发生警告：export 'createWebHistory' was not found in 'vue-router' 进行修复",
      createdAt: new Date().toISOString()
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "项目使用 vue-router 3.x，但代码使用了 vue-router 4.x API，需要修改 src/router/index.js。",
      createdAt: new Date().toISOString()
    }
  ];
  const editRequest = buildContextualEditRequest(history, "进行修复", "修复 vue-router 3 项目中 createWebHistory 不存在的警告");

  assert.match(editRequest, /createWebHistory/);
  assert.match(editRequest, /src\/router\/index\.js/);
  assert.match(editRequest, /不要把当前短 follow-up 作为孤立请求|Do not treat the current short follow-up as an isolated request/);
});
