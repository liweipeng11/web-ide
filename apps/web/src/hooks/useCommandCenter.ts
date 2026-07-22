import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fetchCommandPolicy, recordTaskSessionCommand, startCommandExecution, streamGenerateEdit, validateAndFix, type AutoValidationResponse, type CommandResult, type VerificationIssueCategory } from "../api";
import { createClientErrorStep, createCommandAgentStep, type AppState, type CommandSuggestion } from "../appState";
import type { TerminalCommandCompletion, TerminalCommandRequest } from "../components/TerminalPanel";

const MAX_FIX_ATTEMPTS = 3;
const commandOutputPreviewChars = 2000;

// 验证类建议统一交给 Verifier，避免终端路径和自动回修路径产生两套结果。
function isValidationSuggestion(command: string) {
  const normalized = command.trim().toLowerCase();
  return /(?:^|\s|:)(?:format:check|format-check|check|typecheck|type-check|lint|test|build)(?::[a-z0-9_.-]+)*(?:\s|$)/.test(normalized)
    || /(?:^|\s)(?:tsc|eslint|vitest|jest|pytest|mypy|ruff\s+check)(?:\s|$)/.test(normalized);
}

type UseCommandCenterOptions = {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  refreshTaskSessions: (selectedTaskSessionId?: string | null) => Promise<void>;
};

// 管理终端命令、验证流程和自动修复循环，避免与聊天逻辑相互缠绕。
export function useCommandCenter({ state, setState, setTerminalOpen, refreshTaskSessions }: UseCommandCenterOptions) {
  const [terminalCommandRequest, setTerminalCommandRequest] = useState<TerminalCommandRequest | null>(null);
  const streamAbortController = useRef<AbortController | null>(null);
  const terminalCommandResolvers = useRef<Record<string, (result: CommandResult | null) => void>>({});
  const terminalCommandTaskSessions = useRef<Record<string, string | null>>({});

  function summarizeCommandFailure(result: CommandResult) {
    const outputPreview = [
      result.summary && "summary:\n" + result.summary.slice(-commandOutputPreviewChars),
      result.stderr && "stderr tail:\n" + result.stderr.slice(-commandOutputPreviewChars),
      result.stdout && "stdout tail:\n" + result.stdout.slice(-commandOutputPreviewChars)
    ]
      .filter(Boolean)
      .join("\n\n");

    return [
      `Command: ${result.command}`,
      `CWD: ${result.cwd}`,
      `Status: ${result.status || "unknown"}`,
      `Exit code: ${result.exitCode ?? "null"}`,
      "",
      outputPreview || "(no output)"
    ].join("\n");
  }

  function buildAutoFixPrompt(result: CommandResult, nextAttempt: number) {
    return [
      "自动修复验证失败。请根据下面的错误日志生成一个新的修复 patch。",
      "",
      `限制：这是第 ${nextAttempt} 次修复尝试，最多 ${MAX_FIX_ATTEMPTS} 次。`,
      `验证命令：${result.command}`,
      "",
      "要求：",
      "- 只修改导致验证失败的相关代码。",
      "- 返回可审查的 patch，不要声称已经运行命令。",
      "- commandsToRun 必须包含同一条验证命令。",
      "",
      "失败日志：",
      summarizeCommandFailure(result)
    ].join("\n");
  }

  async function generateAutoFixPatch(result: CommandResult) {
    const currentAutoFix = state.autoFix?.command === result.command ? state.autoFix : null;
    const nextAttempt = (currentAutoFix?.attempts || 0) + 1;
    const failureSummary = summarizeCommandFailure(result);

    if (nextAttempt > MAX_FIX_ATTEMPTS) {
      const message = [`自动修复已停止：${result.command} 连续失败，已达到最多 ${MAX_FIX_ATTEMPTS} 次修复尝试。`, "", "最后一次失败摘要：", failureSummary].join("\n");
      setState((current) => ({
        ...current,
        autoFix: {
          command: result.command,
          attempts: MAX_FIX_ATTEMPTS,
          maxAttempts: MAX_FIX_ATTEMPTS,
          awaitingPatchId: null,
          lastFailureSummary: failureSummary,
          failureCategories: []
        },
        error: message,
        agentSteps: [...current.agentSteps, createClientErrorStep(message)]
      }));
      return;
    }

    setState((current) => ({
      ...current,
      loading: true,
      error: null,
      patch: null,
      autoFix: {
        command: result.command,
        attempts: nextAttempt,
        maxAttempts: MAX_FIX_ATTEMPTS,
        awaitingPatchId: null,
        lastFailureSummary: failureSummary,
        failureCategories: []
      },
      agentSteps: [
        ...current.agentSteps,
        {
          id: `auto-fix:${Date.now()}:${crypto.randomUUID()}`,
          type: "message",
          content: `验证失败，正在生成第 ${nextAttempt}/${MAX_FIX_ATTEMPTS} 次修复 patch：${result.command}`,
          createdAt: Date.now()
        }
      ]
    }));

    let streamTaskSessionId: string | null = null;

    try {
      const controller = new AbortController();
      streamAbortController.current = controller;

      await streamGenerateEdit(
        state.selectedPath,
        buildAutoFixPrompt(result, nextAttempt),
        (streamEvent) => {
          if (streamEvent.event === "task_session") {
            streamTaskSessionId = streamEvent.data.session.id;
            setState((current) => ({
              ...current,
              currentTaskSessionId: streamEvent.data.session.id,
              taskSessions: [streamEvent.data.session, ...current.taskSessions.filter((session) => session.id !== streamEvent.data.session.id)]
            }));
          }

          if (streamEvent.event === "agent_step") {
            setState((current) => ({
              ...current,
              agentSteps: [...current.agentSteps.filter((step) => step.id !== streamEvent.data.step.id), streamEvent.data.step]
            }));
          }

          if (streamEvent.event === "plan_pending") {
            streamTaskSessionId = streamEvent.data.taskSessionId;
            setState((current) => ({
              ...current,
              currentTaskSessionId: streamEvent.data.taskSessionId,
              error: streamEvent.data.message,
              agentSteps: [...current.agentSteps, createClientErrorStep(streamEvent.data.message)]
            }));
          }

          if (streamEvent.event === "done") {
            streamTaskSessionId = streamEvent.data.patch.taskSessionId || streamTaskSessionId;
            setState((current) => ({
              ...current,
              currentTaskSessionId: streamEvent.data.patch.taskSessionId || current.currentTaskSessionId,
              patch: streamEvent.data.patch,
              autoFix: {
                command: result.command,
                attempts: nextAttempt,
                maxAttempts: MAX_FIX_ATTEMPTS,
                awaitingPatchId: streamEvent.data.patch.patchId,
                lastFailureSummary: failureSummary,
                failureCategories: []
              },
              agentSteps: streamEvent.data.patch.agentSteps || current.agentSteps
            }));
            void refreshTaskSessions(streamTaskSessionId);
          }

          if (streamEvent.event === "error") {
            throw new Error(streamEvent.data.error);
          }
        },
        controller.signal
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : "生成自动修复 patch 失败";
        setState((current) => ({
          ...current,
          error: message,
          agentSteps: [...current.agentSteps, createClientErrorStep(message)]
        }));
      }
    } finally {
      streamAbortController.current = null;
      void refreshTaskSessions(streamTaskSessionId);
      setState((current) => ({ ...current, loading: false }));
    }
  }

  async function handleValidateAndFix(command: string | null = null, options: {
    confirmed?: boolean;
    changedFiles?: string[];
    failureCategories?: VerificationIssueCategory[];
    changeContext?: string;
  } = {}): Promise<AutoValidationResponse | null> {
    if (!state.workspaceRoot || state.loading || state.streaming) return null;

    // 自动流水线没有固定命令，回修次数需要跨不同失败阶段连续累计。
    const currentAutoFix = command ? state.autoFix?.command === command ? state.autoFix : null : state.autoFix;
    const attempts = currentAutoFix?.attempts || 0;
    const maxAttempts = currentAutoFix?.maxAttempts || MAX_FIX_ATTEMPTS;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const validation = await validateAndFix(command, {
        selectedPath: state.selectedPath,
        taskSessionId: state.currentTaskSessionId,
        attempts,
        maxAttempts,
        changedFiles: options.changedFiles,
        failureCategories: options.failureCategories,
        changeContext: options.changeContext,
        confirmed: options.confirmed
      });

      if (validation.status === "needs_confirmation") {
        const confirmed = window.confirm(`该验证命令需要确认后执行：\n\n${validation.command}\n\n原因：${validation.policy.reason}\n\n确认执行？`);
        setState((current) => ({ ...current, loading: false }));
        return confirmed ? handleValidateAndFix(command, { ...options, confirmed: true }) : null;
      }

      const nextAgentSteps = (currentSteps: AppState["agentSteps"]) => [...currentSteps, ...validation.agentSteps.filter((step) => !currentSteps.some((item) => item.id === step.id))];
      const failureSummary = validation.failureSummary || validation.result?.summary || "";
      const failureCategories = [...new Set(validation.verification?.failedExecution?.issues.map((issue) => issue.category) || [])];

      if (validation.status === "fix_generated" && validation.patch) {
        const fixPatch = validation.patch;
        setState((current) => ({
          ...current,
          loading: false,
          error: null,
          currentTaskSessionId: fixPatch.taskSessionId || current.currentTaskSessionId,
          patch: fixPatch,
          autoFix: {
            command: validation.command,
            attempts: validation.attempts,
            maxAttempts: validation.maxAttempts,
            awaitingPatchId: fixPatch.patchId,
            lastFailureSummary: failureSummary,
            failureCategories
          },
          agentSteps: nextAgentSteps(fixPatch.agentSteps || current.agentSteps)
        }));
        void refreshTaskSessions(fixPatch.taskSessionId || state.currentTaskSessionId);
        return validation;
      }

      if (validation.status === "success") {
        setState((current) => ({
          ...current,
          loading: false,
          error: null,
          autoFix: null,
          agentSteps: nextAgentSteps(current.agentSteps)
        }));
        void refreshTaskSessions(state.currentTaskSessionId);
        return validation;
      }

      if (validation.status === "no_commands") {
        const message = "当前项目未发现可执行的验证命令，请先添加 typecheck、lint、test 或 build 脚本。";
        setState((current) => ({ ...current, loading: false, error: message, autoFix: null, agentSteps: nextAgentSteps(current.agentSteps) }));
        void refreshTaskSessions(state.currentTaskSessionId);
        return validation;
      }

      const message =
        validation.status === "blocked"
          ? validation.policy.reason
          : [`自动修复已停止：${validation.command} 连续失败，已达到最多 ${validation.maxAttempts} 次修复尝试。`, "", failureSummary].filter(Boolean).join("\n");

      setState((current) => ({
        ...current,
        loading: false,
        error: message,
        autoFix: {
          command: validation.command,
          attempts: validation.attempts,
          maxAttempts: validation.maxAttempts,
          awaitingPatchId: null,
          lastFailureSummary: failureSummary,
          failureCategories
        },
        agentSteps: nextAgentSteps(current.agentSteps)
      }));
      void refreshTaskSessions(state.currentTaskSessionId);
      return validation;
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动验证失败";
      setState((current) => ({
        ...current,
        loading: false,
        error: message,
        agentSteps: [...current.agentSteps, createClientErrorStep(message)]
      }));
      return null;
    }
  }

  function commandResultForAgentStep(result: CommandResult): CommandResult {
    return {
      ...result,
      stdout: "",
      stderr: "",
      summary: result.summary ? "命令输出已发送到终端面板。" : undefined,
      outputTruncated: result.outputTruncated || Boolean(result.stdout || result.stderr || result.summary)
    };
  }

  async function handleRunCommandSuggestion(suggestion: CommandSuggestion, options?: { autoSafeOnly?: boolean }) {
    if (!state.workspaceRoot || state.loading || state.streaming) return null;

    try {
      const { policy } = await fetchCommandPolicy(suggestion.command);

      if (options?.autoSafeOnly && policy.level !== "safe") {
        return null;
      }

      if (isValidationSuggestion(suggestion.command)) {
        const validation = await handleValidateAndFix(suggestion.command, { confirmed: policy.level === "safe" });
        return validation?.result || null;
      }

      setState((current) => ({ ...current, loading: true, error: null }));

      if (policy.level === "blocked") {
        setState((current) => ({
          ...current,
          loading: false,
          error: policy.reason,
          agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, "blocked", policy, null)]
        }));
        return null;
      }

      let confirmed = policy.level === "safe";

      if (policy.level === "confirm") {
        confirmed = window.confirm(`该命令需要确认后执行：\n\n${suggestion.command}\n\n原因：${policy.reason}\n\n确认执行？`);
      }

      if (!confirmed) {
        setState((current) => ({
          ...current,
          loading: false,
          agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, "cancelled", policy, null)]
        }));
        return null;
      }

      const runningStep = createCommandAgentStep(suggestion.command, "running", policy, null);
      setState((current) => ({ ...current, agentSteps: [...current.agentSteps, runningStep] }));
      setTerminalOpen(true);
      const { execution } = await startCommandExecution({
        command: suggestion.command,
        cwd: state.workspaceRoot,
        chatId: state.chatId,
        taskSessionId: state.currentTaskSessionId,
        mode: "auto",
        confirmed
      });
      const result = await new Promise<CommandResult | null>((resolve) => {
        terminalCommandResolvers.current[execution.id] = resolve;
        terminalCommandTaskSessions.current[execution.id] = state.currentTaskSessionId;
        setState((current) => ({
          ...current,
          agentSteps: current.agentSteps.map((step) => step.id === runningStep.id && step.type === "command" ? { ...step, executionId: execution.id } : step)
        }));
        setTerminalCommandRequest({ id: execution.id, execution });
      });

      if (!result) {
        setState((current) => ({
          ...current,
          loading: false,
          agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, "failed", policy, null)]
        }));
        return null;
      }

      const status = result.status === "success" ? "success" : result.status === "running" ? "running" : "failed";
      const visibleResult = commandResultForAgentStep(result);

      setState((current) => ({
        ...current,
        loading: false,
        agentSteps: current.agentSteps.map((step) => step.type === "command" && step.executionId === execution.id ? { ...step, status, result: visibleResult } : step)
      }));

      if (status === "failed") {
        await generateAutoFixPatch(result);
      } else if (status === "success") {
        setState((current) => ({ ...current, autoFix: null }));
      }

      return visibleResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "命令执行失败";
      setState((current) => ({
        ...current,
        loading: false,
        error: message,
        agentSteps: [...current.agentSteps, createClientErrorStep(message)]
      }));
      return null;
    }
  }

  function handleTerminalCommandComplete(completion: TerminalCommandCompletion) {
    const resolve = terminalCommandResolvers.current[completion.id];
    const wasAwaiting = Boolean(resolve);

    if (resolve) {
      resolve(completion.result);
      delete terminalCommandResolvers.current[completion.id];
    }

    const taskSessionId = terminalCommandTaskSessions.current[completion.id];
    if (completion.phase === "finished") delete terminalCommandTaskSessions.current[completion.id];

    if (completion.phase === "finished" && taskSessionId && completion.result) {
      void recordTaskSessionCommand(taskSessionId, completion.result.command, completion.result).then(() => refreshTaskSessions(taskSessionId));
    }

    if (completion.result) {
      const status = completion.result.status === "success" ? "success" : completion.result.status === "running" ? "running" : completion.execution?.state === "cancelled" ? "cancelled" : "failed";
      const visibleResult = commandResultForAgentStep(completion.result);
      setState((current) => ({
        ...current,
        loading: false,
        agentSteps: current.agentSteps.map((step) => step.type === "command" && step.executionId === completion.id ? { ...step, status, result: visibleResult } : step)
      }));

      if (completion.phase === "finished" && status === "failed" && !wasAwaiting) void generateAutoFixPatch(completion.result);
    }

    if (completion.error) {
      setState((current) => ({ ...current, loading: false, error: completion.error || null }));
    }
  }

  return {
    terminalCommandRequest,
    handleValidateAndFix,
    handleRunCommandSuggestion,
    handleTerminalCommandComplete
  };
}
