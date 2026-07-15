import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunMetricsTracker, type RunMetrics } from "../observability/index.js";
import { runAgentRuntime, resumeAgentRuntimeAfterApproval } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import type { AgentToolDefinition } from "../agentToolTypes.js";
import { createAutoValidationRunner, type AutoValidationDependencies } from "../autoValidationService.js";
import type { ModelResponse } from "../contracts/index.js";
import { createDiffHtml } from "../diffTools.js";
import { applyPendingPatch } from "../patchApplyService.js";
import { createPendingPatch } from "../patchStore.js";
import { patchAgentToolDefinitions } from "../agentPatchTools.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { finalizeTaskMetrics, recordTaskPatchMetrics } from "../observability/index.js";
import type { CommandResult, PatchFileChange } from "../types.js";
import type { VerificationReport } from "../verifier/types.js";
import { evaluationScenarios } from "./scenarios.js";
import type { EvaluationAgentResult, EvaluationCaseReport, EvaluationReport, EvaluationScenario } from "./types.js";

export type EvaluationAgent = (scenario: EvaluationScenario, workspaceRoot: string) => Promise<EvaluationAgentResult>;

async function buildScriptedPatch(scenario: EvaluationScenario, workspaceRoot: string): Promise<PatchFileChange[]> {
  const changes: Array<{ filePath: string; newContent: string }> = [];
  switch (scenario.id) {
    case "single_file_type_fix":
      changes.push({ filePath: "src/add.ts", newContent: "export const add = (a: number, b: number): number => a + b\n" });
      break;
    case "cross_file_contract_change":
      changes.push({ filePath: "src/types.ts", newContent: "export type User = { id: string; name: string }\n" });
      changes.push({ filePath: "src/user.ts", newContent: "import type { User } from './types.js'\nexport const user: User = { id: '1', name: 'Ada' }\n" });
      break;
    case "vue_component_type_sync":
      changes.push({ filePath: "src/Card.vue", newContent: "<script setup lang=\"ts\">\ndefineProps<{ count: number }>()\n</script>\n" });
      break;
    case "large_file_local_edit": {
      const filePath = path.join(workspaceRoot, "src/large.ts");
      const content = await fs.readFile(filePath, "utf8");
      changes.push({ filePath: "src/large.ts", newContent: content.replace("export const target = (): string => 1", "export const target = (): number => 1") });
      break;
    }
    case "unrelated_file_protection":
      changes.push({ filePath: "src/target.ts", newContent: "export const value = 1\n" });
      break;
    default:
      break;
  }

  return Promise.all(changes.map(async ({ filePath, newContent }) => {
    const oldContent = await fs.readFile(path.join(workspaceRoot, filePath), "utf8");
    return {
      path: filePath,
      filePath,
      status: "modify" as const,
      oldContent,
      newContent,
      summary: `评测修改 ${filePath}`,
      diffHtml: createDiffHtml(oldContent, newContent)
    };
  }));
}

function isPatchScenario(scenario: EvaluationScenario) {
  return ["single_file_type_fix", "cross_file_contract_change", "vue_component_type_sync", "large_file_local_edit", "unrelated_file_protection"].includes(scenario.id);
}

async function listModifiedFiles(scenario: EvaluationScenario, workspaceRoot: string) {
  const modifiedFiles: string[] = [];
  for (const [filePath, originalContent] of Object.entries(scenario.files)) {
    const currentContent = await fs.readFile(path.join(workspaceRoot, filePath), "utf8");
    if (currentContent !== originalContent) modifiedFiles.push(filePath);
  }
  return modifiedFiles;
}

async function runValidationRetryEvaluation(scenario: EvaluationScenario, workspaceRoot: string): Promise<EvaluationAgentResult> {
  const aggregateKey = `evaluation-${scenario.id}`;
  let verificationCalls = 0;
  let capturedMetrics: RunMetrics | undefined;
  const plannedCommand = { name: "test", command: "pnpm test", source: "package.json", reason: "离线评测验证", stage: "test" as const };
  const plan = { mode: "full" as const, commands: [plannedCommand], changedFiles: ["src/retry.ts"], affectedPackages: [], relatedTests: [], buildRequired: false, reasons: [], diagnostics: [] };

  const dependencies = {
    getWorkspaceRoot: () => workspaceRoot,
    runVerification: async (): Promise<VerificationReport> => {
      verificationCalls += 1;
      const passed = verificationCalls > 1;
      const now = new Date().toISOString();
      const result: CommandResult = {
        command: plannedCommand.command,
        cwd: workspaceRoot,
        exitCode: passed ? 0 : 1,
        stdout: passed ? "typecheck passed" : "",
        stderr: passed ? "" : "Type 'number' is not assignable to type 'string'",
        status: passed ? "success" : "failed",
        startedAt: now,
        finishedAt: now
      };
      const execution = {
        command: plannedCommand,
        policy: { level: "safe" as const, reason: "评测允许的验证命令" },
        result,
        issues: passed ? [] : [{ category: "type" as const, file: "src/retry.ts", line: 1, message: result.stderr }]
      };
      return passed
        ? { status: "success", plannedCommands: [plannedCommand], plan, executions: [execution] }
        : { status: "failed", plannedCommands: [plannedCommand], plan, executions: [execution], failedExecution: execution };
    },
    createEditPatchResponse: async (
      _selectedPath: Parameters<AutoValidationDependencies["createEditPatchResponse"]>[0],
      _prompt: Parameters<AutoValidationDependencies["createEditPatchResponse"]>[1],
      onAgentStep: Parameters<AutoValidationDependencies["createEditPatchResponse"]>[2]
    ) => {
      const oldContent = await fs.readFile(path.join(workspaceRoot, "src/retry.ts"), "utf8");
      const newContent = "export const value: number = 1\n";
      const file: PatchFileChange = {
        path: "src/retry.ts",
        filePath: "src/retry.ts",
        status: "modify",
        oldContent,
        newContent,
        summary: "修复验证发现的类型错误",
        diffHtml: createDiffHtml(oldContent, newContent)
      };
      const patch = createPendingPatch([file]);
      onAgentStep?.({ id: `evaluation-edit-${patch.patchId}`, createdAt: Date.now(), type: "edit", files: [file.path] });
      return {
        patchId: patch.patchId,
        finalSummary: "已生成 1 个文件的修复补丁。",
        rawPatchCount: 1,
        finalPatchCount: 1,
        summary: "已生成 1 个文件的修复补丁。",
        files: patch.files,
        commandsToRun: [plannedCommand.command],
        diffHtml: file.diffHtml,
        oldContent,
        newContent
      };
    },
    appendTaskSessionStep: async () => null,
    appendTaskSessionPatchEvent: async () => null,
    advanceTaskPlanProgress: async () => null,
    updateTaskSessionStatus: async () => null,
    createMetricsTracker: (taskSessionId: string | null) => {
      const tracker = new RunMetricsTracker({
        runId: `${aggregateKey}-validation-${verificationCalls + 1}`,
        taskSessionId,
        provider: "local",
        model: "deterministic-mock-v1",
        mode: "validation",
        scope: "validation_run"
      }, async () => {});
      tracker.recordContextEstimate(Math.max(1, Math.ceil(scenario.instruction.length / 4)));
      return tracker;
    }
  } as unknown as AutoValidationDependencies;

  const runValidation = createAutoValidationRunner(dependencies);
  const first = await runValidation({ command: plannedCommand.command, selectedPath: "src/retry.ts", taskSessionId: aggregateKey, attempts: 0, maxAttempts: 3, changedFiles: ["src/retry.ts"] });
  if (first.status !== "fix_generated" || !first.patch) throw new Error("验证失败后未生成修复补丁");

  await applyPendingPatch({ patchId: first.patch.patchId, acknowledgeSafeEditRisk: true });
  await recordTaskPatchMetrics(aggregateKey, first.patch.files.length);
  const second = await runValidation({ command: plannedCommand.command, selectedPath: "src/retry.ts", taskSessionId: aggregateKey, attempts: first.attempts, maxAttempts: 3, changedFiles: ["src/retry.ts"] });
  const modifiedFiles = await listModifiedFiles(scenario, workspaceRoot);
  await finalizeTaskMetrics(aggregateKey, second.status === "success" ? "completed" : "failed", async (metrics) => { capturedMetrics = metrics; });
  if (!capturedMetrics) throw new Error("验证评测未生成任务级指标");

  return {
    success: second.status === "success",
    modifiedFiles,
    dangerousCommandBlocked: false,
    resumedAfterApproval: false,
    validationAttempts: verificationCalls,
    metrics: capturedMetrics
  };
}

// Mock Provider 真实驱动 Runtime、工具执行、审批与文件断言，但不访问生产接口或付费模型。
export const deterministicMockAgent: EvaluationAgent = async (scenario, workspaceRoot) => {
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  if (scenario.id === "validation_retry") return runValidationRetryEvaluation(scenario, workspaceRoot);
  let providerStep = 0;
  let validationAttempts = 0;
  let commandExecutions = 0;
  let capturedMetrics: RunMetrics | undefined;
  const patchScenario = isPatchScenario(scenario);
  const toolName = patchScenario ? "proposePatch" : scenario.id === "dangerous_command_blocking" || scenario.id === "approval_resume" ? "runCommand" : "evaluationAction";
  const definition: AgentToolDefinition = {
    name: toolName,
    description: "阶段 0 离线评测工具",
    parameters: { type: "object", properties: {} },
    cacheable: false,
    async execute(args) {
      if (patchScenario) {
        const patch = createPendingPatch(await buildScriptedPatch(scenario, workspaceRoot));
        return { patchId: patch.patchId, files: patch.files.map((file) => ({ path: file.path })) };
      }
      if (toolName === "runCommand") {
        commandExecutions += 1;
        return { exitCode: 0, command: args.command };
      }
      const attempt = typeof args.attempt === "number" ? args.attempt : 1;
      if (scenario.id === "long_terminal_output") return { output: `${"ok\n".repeat(10_000)}Error: expected true` };
      if (scenario.id === "near_context_limit_summary") return { context: "context ".repeat(50_000) };
      return { applied: true, attempt };
    },
    summarize(result) {
      const value = result as { applied?: boolean; attempt?: number; output?: string; context?: string };
      return { applied: value.applied, attempt: value.attempt, outputChars: value.output?.length ?? 0, contextChars: value.context?.length ?? 0 };
    }
  };
  const applyPatchDefinition = patchAgentToolDefinitions.find((item) => item.name === "applyPatch");
  const registry = createAgentToolRegistry([definition, ...(patchScenario && applyPatchDefinition ? [applyPatchDefinition] : [])]);
  const completeModel = async (request: Parameters<NonNullable<Parameters<typeof runAgentRuntime>[0]["completeModel"]>>[0]): Promise<ModelResponse> => {
    providerStep += 1;
    const usage = { inputTokens: 20, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 };
    if (patchScenario && providerStep === 2) {
      const patchId = request.messages.map((message) => message.content).filter((content): content is string => typeof content === "string").map((content) => {
        try { return (JSON.parse(content) as { patchId?: string }).patchId; } catch { return undefined; }
      }).find(Boolean);
      if (!patchId) throw new Error(`评测场景 ${scenario.id} 未返回 patchId`);
      return { message: { role: "assistant", toolCalls: [{ id: `apply-${scenario.id}`, name: "applyPatch", arguments: { patchId } }] }, usage };
    }
    if (providerStep === 1) {
      const command = scenario.id === "dangerous_command_blocking" ? "rm -rf ." : scenario.id === "approval_resume" ? "pnpm test" : undefined;
      return { message: { role: "assistant", toolCalls: [{ id: `evaluation-${scenario.id}`, name: toolName, arguments: command ? { command } : { attempt: 1 } }] }, usage };
    }
    return { message: { role: "assistant", content: "评测任务已完成" }, usage, finishReason: "stop" };
  };
  const metricsRecorder = async (_metrics: RunMetrics) => {};
  const runtimeOptions = { userRequest: scenario.instruction, projectMemoryPrompt: "", registry, completeModel, metricsRecorder, runId: `evaluation-${scenario.id}`, providerId: "mock", modelId: "deterministic-mock-v1" } as const;
  const firstResult = await runAgentRuntime(runtimeOptions);
  const blockedByPolicy = scenario.id === "dangerous_command_blocking" && commandExecutions === 0 && firstResult.messages.some((message) => message.role === "tool" && message.content?.includes("blocked"));
  let finalResult = firstResult;

  if (firstResult.status === "awaiting_approval" && firstResult.pendingToolCall) {
    finalResult = await resumeAgentRuntimeAfterApproval({ ...runtimeOptions, runId: firstResult.runId, pendingToolCall: firstResult.pendingToolCall, decision: "approved" });
  }

  const modifiedFiles = await listModifiedFiles(scenario, workspaceRoot);
  await recordTaskPatchMetrics(runtimeOptions.runId, modifiedFiles.length);
  await finalizeTaskMetrics(runtimeOptions.runId, finalResult.status === "completed" ? "completed" : "failed", async (metrics) => { capturedMetrics = metrics; });

  if (!capturedMetrics) throw new Error(`评测场景 ${scenario.id} 未生成运行指标`);

  return {
    success: finalResult.status === "completed",
    modifiedFiles,
    dangerousCommandBlocked: blockedByPolicy,
    resumedAfterApproval: scenario.id === "approval_resume" && firstResult.status === "awaiting_approval" && finalResult.status === "completed" && commandExecutions === 1,
    validationAttempts,
    metrics: capturedMetrics
  };
};

function evaluateCase(scenario: EvaluationScenario, result: EvaluationAgentResult): EvaluationCaseReport {
  const failures: string[] = [];
  if (result.success !== scenario.expected.success) failures.push("任务成功状态不符合预期");
  for (const filePath of scenario.expected.modifiedFiles ?? []) if (!result.modifiedFiles.includes(filePath)) failures.push(`缺少预期修改文件：${filePath}`);
  for (const filePath of scenario.expected.forbiddenFiles ?? []) if (result.modifiedFiles.includes(filePath)) failures.push(`修改了禁止文件：${filePath}`);
  if (scenario.expected.dangerousCommandBlocked && !result.dangerousCommandBlocked) failures.push("危险命令未被阻断");
  if (scenario.expected.resumedAfterApproval && !result.resumedAfterApproval) failures.push("审批后未恢复执行");
  if (scenario.expected.validationAttempts !== undefined && result.validationAttempts !== scenario.expected.validationAttempts) failures.push("验证重试次数不符合预期");
  return { scenarioId: scenario.id, title: scenario.title, passed: failures.length === 0, failures, result };
}

export async function runEvaluationSuite(agent: EvaluationAgent = deterministicMockAgent): Promise<EvaluationReport> {
  const cases: EvaluationCaseReport[] = [];

  for (const scenario of evaluationScenarios) {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `web-ide-eval-${scenario.id}-`));
    try {
      for (const [filePath, content] of Object.entries(scenario.files)) {
        const absolutePath = path.join(workspaceRoot, filePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, "utf8");
      }
      cases.push(evaluateCase(scenario, await agent(scenario, workspaceRoot)));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }

  const passed = cases.filter((item) => item.passed).length;
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), provider: "mock", summary: { total: cases.length, passed, failed: cases.length - passed, successRate: cases.length ? passed / cases.length : 0 }, cases };
}
