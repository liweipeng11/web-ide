import test from "node:test";
import assert from "node:assert/strict";
import type { AgentContext } from "../agentToolTypes.js";
import { buildTaskWorkflowProgressPrompt, createTaskWorkflow, evaluateTaskWorkflowToolDecision, getTaskWorkflowDecisionPolicy } from "./index.js";
import { createReferenceCheckKey } from "./referenceChecks.js";
import type { ExistenceCheckTarget, ReferenceResolution } from "../existenceChecker/types.js";

const allTools = new Set([
  "readFile",
  "readFileChunk",
  "findSimilarPatterns",
  "checkExistence",
  "analyzeImpact",
  "proposePatch",
  "replaceInFile",
  "writeFile",
  "applyPatch",
  "runCommand",
  "automateBrowser"
]);

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userGoal: "测试工作流决策",
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: [],
    patternSearchPerformed: false,
    patternCandidateFiles: [],
    existenceCheckPerformed: false,
    unresolvedExistenceChecks: [],
    commandsRun: [],
    externalSources: [],
    ...overrides
  };
}

function workflow(intent: "inspect" | "edit" | "diagnose_then_edit", goal: string) {
  return createTaskWorkflow(goal, { intent, confidence: 0.9, normalizedGoal: goal, reason: "test" });
}

function referenceCheck(target: ExistenceCheckTarget, resolution: ReferenceResolution) {
  return { [createReferenceCheckKey(target)]: resolution };
}

function readyFeatureContext(overrides: Partial<AgentContext> = {}) {
  return context({
    filesRead: ["src/main.js"],
    patternSearchPerformed: true,
    patternCandidateFiles: ["src/main.js"],
    existenceCheckPerformed: true,
    referenceChecks: {},
    ...overrides
  });
}

test("所有工作流策略返回独立副本且权限边界明确", () => {
  const feature = getTaskWorkflowDecisionPolicy("feature");
  const analysis = getTaskWorkflowDecisionPolicy("analysis-only");
  feature.requiredBeforeEdit.length = 0;

  assert.equal(analysis.mutationAllowed, false);
  assert.equal(analysis.commandAllowed, false);
  assert.equal(getTaskWorkflowDecisionPolicy("feature").requiredBeforeEdit.includes("pattern_search"), true);
});

test("只读工作流阻止所有副作用工具但允许检索", () => {
  const currentWorkflow = workflow("inspect", "只分析模块依赖");

  for (const toolName of ["proposePatch", "replaceInFile", "writeFile", "applyPatch", "runCommand", "automateBrowser"]) {
    const decision = evaluateTaskWorkflowToolDecision({ workflow: currentWorkflow, toolName, agentContext: context(), availableTools: allTools });
    assert.equal(decision.allowed, false, `${toolName} 应被只读工作流阻止`);
  }

  assert.equal(evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "searchCode",
    agentContext: context(),
    availableTools: allTools
  }).allowed, true);
});

test("用户可对编辑工作流单独禁用命令且不会形成死锁前置条件", () => {
  const currentWorkflow = createTaskWorkflow("修复服务异常，但不要运行命令", {
    intent: "diagnose_then_edit",
    confidence: 0.9,
    normalizedGoal: "修复服务异常，但不要运行命令",
    reason: "test"
  });
  const readyContext = context({
    filesRead: ["src/service.ts"],
    patternSearchPerformed: true,
    patternCandidateFiles: ["src/service.ts"],
    existenceCheckPerformed: true
  });

  const commandDecision = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "runCommand",
    agentContext: readyContext,
    availableTools: allTools
  });
  const editDecision = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "proposePatch",
    agentContext: readyContext,
    availableTools: allTools
  });

  assert.equal(commandDecision.allowed, false);
  assert.match(commandDecision.reason || "", /does not allow command execution/);
  assert.equal(editDecision.allowed, true);
});

test("功能工作流按证据顺序推荐工具并在证据齐全后允许编辑", () => {
  const currentWorkflow = workflow("edit", "新增导出功能");
  const initial = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "proposePatch",
    agentContext: context(),
    availableTools: allTools
  });

  assert.equal(initial.allowed, false);
  assert.deepEqual(initial.recommendedTools, ["readFile", "readFileChunk", "findSimilarPatterns", "checkExistence"]);

  const ready = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "proposePatch",
    agentContext: context({
      filesRead: ["src/export.ts"],
      patternSearchPerformed: true,
      patternCandidateFiles: ["src/export.ts"],
      existenceCheckPerformed: true
    }),
    availableTools: allTools
  });
  assert.equal(ready.allowed, true);
  assert.deepEqual(ready.missingEvidence, []);
});

test("候选模式存在时必须读取候选文件", () => {
  const currentWorkflow = workflow("edit", "新增导出功能");
  const decision = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "writeFile",
    agentContext: context({
      filesRead: ["src/other.ts"],
      patternSearchPerformed: true,
      patternCandidateFiles: ["src/exportPattern.ts"],
      existenceCheckPerformed: true
    }),
    availableTools: allTools
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.missingEvidence.includes("pattern_candidate_read"), true);
  assert.match(decision.reason || "", /Read at least one candidate/);
});

test("修复与重构工作流分别要求命令尝试和影响分析", () => {
  const commonContext = context({
    filesRead: ["src/service.ts"],
    patternSearchPerformed: true,
    patternCandidateFiles: ["src/service.ts"],
    existenceCheckPerformed: true
  });
  const bugfixDecision = evaluateTaskWorkflowToolDecision({
    workflow: workflow("diagnose_then_edit", "修复服务异常"),
    toolName: "proposePatch",
    agentContext: commonContext,
    availableTools: allTools
  });
  const refactorDecision = evaluateTaskWorkflowToolDecision({
    workflow: workflow("edit", "重构服务但不改变行为"),
    toolName: "proposePatch",
    agentContext: commonContext,
    availableTools: allTools
  });

  assert.deepEqual(bugfixDecision.missingEvidence, ["command_attempt"]);
  assert.deepEqual(refactorDecision.missingEvidence, ["impact_analysis"]);
});

test("缺失源码、存在性检查和未解析引用返回可执行原因", () => {
  const bugfixWorkflow = workflow("diagnose_then_edit", "修复服务异常");
  const featureWorkflow = workflow("edit", "新增导出功能");
  const base = {
    patternSearchPerformed: true,
    patternCandidateFiles: [] as string[]
  };

  const missingSource = evaluateTaskWorkflowToolDecision({
    workflow: bugfixWorkflow,
    toolName: "proposePatch",
    agentContext: context({ ...base }),
    availableTools: allTools
  });
  const missingCheck = evaluateTaskWorkflowToolDecision({
    workflow: featureWorkflow,
    toolName: "proposePatch",
    agentContext: context({ ...base, filesRead: ["src/export.ts"] }),
    availableTools: allTools
  });
  const unresolved = evaluateTaskWorkflowToolDecision({
    workflow: featureWorkflow,
    toolName: "proposePatch",
    agentContext: context({
      ...base,
      filesRead: ["src/export.ts"],
      existenceCheckPerformed: true,
      unresolvedExistenceChecks: ["missing:ExportType"]
    }),
    availableTools: allTools
  });

  assert.match(missingSource.reason || "", /reading failure-related code/);
  assert.match(missingCheck.reason || "", /call checkExistence/);
  assert.match(unresolved.reason || "", /Resolve missing or ambiguous references/);
});

test("旧工作流快照保持兼容且证据齐全时允许重构", () => {
  const legacyWorkflow = workflow("edit", "重构任务存储");
  delete legacyWorkflow.authorization;
  const decision = evaluateTaskWorkflowToolDecision({
    workflow: legacyWorkflow,
    toolName: "proposePatch",
    agentContext: context({
      filesRead: ["src/store.ts"],
      patternSearchPerformed: true,
      patternCandidateFiles: [],
      existenceCheckPerformed: true,
      impactAnalyses: [{ target: { symbolName: "Store" } } as never]
    }),
    availableTools: allTools
  });

  assert.equal(decision.allowed, true);
});

test("精简注册表不会生成无法满足的工具前置条件", () => {
  const currentWorkflow = workflow("edit", "新增纯文本说明");
  const availableTools = new Set(["readFile", "proposePatch"]);
  const decision = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "proposePatch",
    agentContext: context({ filesRead: ["README.md"] }),
    availableTools
  });

  assert.equal(decision.allowed, true);
});

test("动态决策提示展示事实、缺口与最低成本下一步", () => {
  const currentWorkflow = workflow("edit", "重构任务存储");
  const prompt = buildTaskWorkflowProgressPrompt(currentWorkflow, context({ filesRead: ["src/store.ts"] }), allTools);

  assert.match(prompt, /workflow: refactor/);
  assert.match(prompt, /evidence satisfied: workspace_read/);
  assert.match(prompt, /impact_analysis/);
  assert.match(prompt, /recommended next tools: findSimilarPatterns, checkExistence, analyzeImpact/);
  assert.match(prompt, /stop discovery once evidence is sufficient/);
});

test("proposePatch(create) 不会被旧缺失检查或 planned_create 循环阻塞", () => {
  const missingRouter: ReferenceResolution = {
    status: "planned_create",
    blocking: false,
    reason: "补丁将创建路由入口",
    candidates: [{ path: "src/router/index.js", detail: "planned file" }],
    resolvedPath: "src/router/index.js"
  };
  const decision = evaluateTaskWorkflowToolDecision({
    workflow: workflow("edit", "新增路由文件"),
    toolName: "proposePatch",
    toolArguments: { filePath: "src/router/index.js", changeKind: "create" },
    agentContext: readyFeatureContext({
      unresolvedExistenceChecks: ["import:./legacy-missing"],
      referenceChecks: referenceCheck(
        { kind: "import", value: "./router", fromPath: "src/main.js" },
        missingRouter
      )
    }),
    availableTools: allTools
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.blockingReferences, []);
  assert.equal(decision.recommendedTools.includes("checkExistence"), false);
});

test("旧缺失检查不阻止无关文件编辑，但相关真实缺失仍阻止直接写入", () => {
  const trulyMissing: ReferenceResolution = {
    status: "truly_missing",
    blocking: true,
    reason: "引用目标不存在",
    candidates: []
  };
  const referenceChecks = referenceCheck(
    { kind: "import", value: "./missing", fromPath: "src/main.js" },
    trulyMissing
  );
  const currentWorkflow = workflow("edit", "更新配置");

  const unrelated = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "writeFile",
    toolArguments: { filePath: "src/config.ts" },
    agentContext: readyFeatureContext({ filesRead: ["src/main.js", "src/config.ts"], referenceChecks }),
    availableTools: allTools
  });
  const related = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "writeFile",
    toolArguments: { filePath: "src/main.js" },
    agentContext: readyFeatureContext({ referenceChecks }),
    availableTools: allTools
  });

  assert.equal(unrelated.allowed, true);
  assert.equal(related.allowed, false);
  assert.equal(related.blockingReferences[0]?.status, "truly_missing");
  assert.deepEqual(related.recommendedTools, ["proposePatch"]);
  assert.equal(related.recoverable, true);
});

test("modify 与 delete 使用独立前置条件", () => {
  const currentWorkflow = workflow("edit", "维护服务文件");
  const unreadModify = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "replaceInFile",
    toolArguments: { filePath: "src/service.ts" },
    agentContext: readyFeatureContext(),
    availableTools: allTools
  });
  const deleteWithoutImpact = evaluateTaskWorkflowToolDecision({
    workflow: currentWorkflow,
    toolName: "deleteFile",
    toolArguments: { filePath: "src/service.ts" },
    agentContext: readyFeatureContext({ filesRead: ["src/main.js", "src/service.ts"] }),
    availableTools: allTools
  });

  assert.equal(unreadModify.allowed, false);
  assert.match(unreadModify.reason || "", /read the existing file/);
  assert.deepEqual(unreadModify.recommendedTools, ["readFile"]);
  assert.equal(deleteWithoutImpact.allowed, false);
  assert.match(deleteWithoutImpact.reason || "", /impact analysis/);
  assert.deepEqual(deleteWithoutImpact.recommendedTools, ["analyzeImpact"]);
});
