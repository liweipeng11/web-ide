import assert from "node:assert/strict";
import test from "node:test";
import type { RouteDecision } from "../../runtime/contracts.js";
import { createMainGraph, type MainGraphDependencies } from "./mainGraph.js";

function decision(route: RouteDecision["route"], intent: RouteDecision["intent"] = "code_change"): RouteDecision {
  return {
    route,
    intent,
    complexity: route === "direct" ? "simple" : route === "main_loop" ? "medium" : "complex",
    requiredCapabilities: route === "direct" ? [] : ["read"]
  };
}

function dependencies(route: RouteDecision["route"] = "direct") {
  const calls: string[] = [];
  const value: MainGraphDependencies = {
    async route() { calls.push("route"); return decision(route, route === "direct" ? "question" : "code_change"); },
    async runDirect() { calls.push("direct"); return { outcome: "completed", summary: "直接回答完成。", facts: ["answer"] }; },
    async runMainLoop() { calls.push("main_loop"); return { outcome: "completed", summary: "简单修改完成。", changedFiles: ["src/a.ts"] }; },
    async runPlanning() { calls.push("planning"); return { status: "ready", value: { id: "plan-1" }, facts: ["planned"] }; },
    async runPlanned(_request, _decision, planning) {
      calls.push(`planned:${(planning as { id: string }).id}`);
      return { outcome: "completed", summary: "复杂任务完成。", changedFiles: ["src/a.ts", "src/b.ts"] };
    }
  };
  return { calls, value };
}

test("direct 路由只执行直接响应分支", async () => {
  const runtime = dependencies("direct");
  const result = await createMainGraph(runtime.value).invoke({ goal: "解释这段代码" });
  assert.equal(result.outcome, "completed");
  assert.equal(result.branch, "direct");
  assert.deepEqual(runtime.calls, ["route", "direct"]);
  assert.deepEqual(result.history, ["route:direct", "direct:completed"]);
});

test("main_loop 统一承载只读分析和简单修改", async () => {
  const runtime = dependencies("main_loop");
  runtime.value.route = async () => { runtime.calls.push("route"); return decision("main_loop", "analysis"); };
  runtime.value.runMainLoop = async (_request, routeDecision) => {
    runtime.calls.push(`main_loop:${routeDecision.intent}`);
    return { outcome: "completed", summary: "只读分析完成。", facts: ["没有执行写入"] };
  };
  const result = await createMainGraph(runtime.value).invoke({ goal: "只分析，不修改", writeScope: ["src/**"] });
  assert.equal(result.branch, "main_loop");
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(runtime.calls, ["route", "main_loop:analysis"]);
});

test("planned 路由先运行 Planning 子图再执行计划子图", async () => {
  const runtime = dependencies("planned");
  const result = await createMainGraph(runtime.value).invoke({ goal: "完成跨模块迁移" });
  assert.equal(result.outcome, "completed");
  assert.equal(result.branch, "planned");
  assert.deepEqual(result.planning, { id: "plan-1" });
  assert.deepEqual(result.facts, ["planned"]);
  assert.deepEqual(runtime.calls, ["route", "planning", "planned:plan-1"]);
});

test("Planning 子图等待用户或阻塞时不会启动 Developer/Tester 执行链", async () => {
  const runtime = dependencies("planned");
  runtime.value.runPlanning = async () => {
    runtime.calls.push("planning");
    return { status: "awaiting_user", summary: "需要用户补充目标范围。", blockers: ["缺少模块范围"] };
  };
  const result = await createMainGraph(runtime.value).invoke({ goal: "迁移模块" });
  assert.equal(result.outcome, "awaiting_user");
  assert.equal(result.summary, "需要用户补充目标范围。");
  assert.deepEqual(runtime.calls, ["route", "planning"]);
});

test("取消在路由前停止，子图 AbortError 也保持 cancelled", async () => {
  const beforeRoute = dependencies("direct");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await createMainGraph(beforeRoute.value).invoke({ goal: "取消任务", signal: controller.signal });
  assert.equal(cancelled.outcome, "cancelled");
  assert.deepEqual(beforeRoute.calls, []);

  const duringBranch = dependencies("main_loop");
  duringBranch.value.runMainLoop = async () => { throw new DOMException("用户取消", "AbortError"); };
  const interrupted = await createMainGraph(duringBranch.value).invoke({ goal: "执行后取消" });
  assert.equal(interrupted.outcome, "cancelled");
});

test("无效路由和伪造的非终态子图结果被转换为 failed", async () => {
  const invalidRoute = dependencies("direct");
  invalidRoute.value.route = async () => ({ ...decision("direct"), route: "unknown" as RouteDecision["route"] });
  const routeResult = await createMainGraph(invalidRoute.value).invoke({ goal: "无效路由" });
  assert.equal(routeResult.outcome, "failed");
  assert.match(routeResult.blockers.join(" "), /无效路由/);

  const invalidBranch = dependencies("direct");
  invalidBranch.value.runDirect = async () => ({ outcome: "routing" as "completed", summary: "伪造状态" });
  const branchResult = await createMainGraph(invalidBranch.value).invoke({ goal: "无效终态" });
  assert.equal(branchResult.outcome, "failed");
  assert.match(branchResult.blockers.join(" "), /终态/);
});
