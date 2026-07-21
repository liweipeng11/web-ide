import assert from "node:assert/strict";
import test from "node:test";
import { rankProjectMemoryItems, scoreProjectMemoryItem } from "./memoryScoring.js";
import type { MemoryRetrievalContext, ProjectMemoryItem } from "./types.js";

const NOW = 1_750_000_000_000;

function item(id: string, content: string, overrides: Partial<ProjectMemoryItem> = {}): ProjectMemoryItem {
  return {
    id,
    kind: "fact",
    content,
    status: "active",
    scope: { type: "project", paths: [] },
    sourceRefs: [{ type: "user", value: `source-${id}` }],
    createdBy: "user",
    confidence: 0.9,
    createdAt: NOW - 100_000,
    updatedAt: NOW - 100_000,
    ...overrides
  };
}

function context(overrides: Partial<MemoryRetrievalContext> = {}): MemoryRetrievalContext {
  return { userRequest: "实现 JWT authentication", contextPaths: [], plannedFiles: [], languages: ["TypeScript"], frameworks: [], maxItems: 5, tokenBudget: 1_000, ...overrides };
}

test("认证任务优先召回较旧但相关的架构决策，忽略最新 UI 事实", () => {
  const ranked = rankProjectMemoryItems([
    item("ui-new", "React button color changed", { updatedAt: NOW }),
    item("auth-old", "JWT authentication uses rotating refresh tokens", { kind: "decision", updatedAt: NOW - 180 * 86_400_000 })
  ], context(), NOW);

  assert.deepEqual(ranked.map((entry) => entry.item.id), ["auth-old"]);
  assert.match(ranked[0]?.reasons.join(" ") || "", /request:/);
});

test("路径级 Memory 只在目录或文件作用域匹配时召回", () => {
  const scoped = item("server-auth", "authentication middleware", { scope: { type: "path", paths: ["apps/server/src/auth"] } });

  assert.equal(scoreProjectMemoryItem(scoped, context({ contextPaths: ["apps/web/src/App.tsx"] }), NOW), null);
  const matched = scoreProjectMemoryItem(scoped, context({ contextPaths: ["apps/server/src/auth/session.ts"] }), NOW);
  assert.ok(matched);
  assert.match(matched.reasons.join(" "), /path:apps\/server\/src\/auth/);
});

test("中文无空格请求仍能通过二元关键词稳定召回", () => {
  const memories = [item("auth-cn", "认证使用 JWT 与刷新令牌"), item("style-cn", "按钮采用蓝色主题")];
  const first = rankProjectMemoryItems(memories, context({ userRequest: "实现认证功能", languages: [] }), NOW);
  const second = rankProjectMemoryItems([...memories].reverse(), context({ userRequest: "实现认证功能", languages: [] }), NOW);

  assert.deepEqual(first.map((entry) => entry.item.id), ["auth-cn"]);
  assert.deepEqual(second.map((entry) => entry.item.id), ["auth-cn"]);
});

test("分支、来源可信度、状态与风险类型参与确定性评分", () => {
  const activeRisk = item("risk", "release branch authentication risk", { kind: "risk", sourceRefs: [{ type: "task", value: "release/v3" }] });
  const candidateFact = item("candidate", "release branch authentication note", { status: "candidate", createdBy: "migration", confidence: 0.4 });
  const ranked = rankProjectMemoryItems([candidateFact, activeRisk], context({ branch: "release/v3" }), NOW);

  assert.equal(ranked[0]?.item.id, "risk");
  assert.match(ranked[0]?.reasons.join(" ") || "", /branch/);
});
