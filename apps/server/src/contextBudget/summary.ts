import type { StructuredContextSummary } from "../contracts/context.js";
import type { ModelMessage } from "../contracts/model.js";
import type { AgentContext } from "../agentToolTypes.js";
import type { PendingAgentToolCall } from "../types.js";

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compactFailureEvidence(content: string) {
  if (content.length <= 1_000) return content;

  // 结构化错误通常位于输出头部，堆栈或命令尾部也可能包含关键定位，两端都必须保留。
  return `${content.slice(0, 650)}\n[已省略 ${content.length - 1_000} 个字符]\n${content.slice(-350)}`;
}

function recentFailures(messages: ModelMessage[]) {
  return messages
    .filter((message) => message.role === "tool" && typeof message.content === "string" && /error|failed|failure|exitCode[^0-9]*[1-9]/i.test(message.content))
    .slice(-3)
    .map((message) => compactFailureEvidence(message.content || ""));
}

function modifiedFiles(messages: ModelMessage[], pendingToolCallId?: string) {
  const editTools = /patch|write|replace|edit|delete/i;
  return messages.flatMap((message) =>
    (message.toolCalls ?? [])
      // 待审批工具尚未执行，不能提前作为文件变更事实写入上下文摘要。
      .filter((call) => call.id !== pendingToolCallId && editTools.test(call.name))
      .map((call) => {
        const args = call.arguments as Record<string, unknown>;
        return typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : "";
      })
  );
}

export function createStructuredContextSummary(input: {
  messages: ModelMessage[];
  coveredMessageIds?: string[];
  agentContext: AgentContext;
  pendingToolCall?: PendingAgentToolCall | null;
  planStatus?: string[];
  filesModified?: string[];
  unresolvedQuestions?: string[];
}): StructuredContextSummary {
  const decisions = input.messages
    .filter((message) => message.role === "assistant" && message.content)
    .slice(-3)
    .map((message) => String(message.content).slice(0, 500));

  return {
    version: 1,
    coveredMessageIds: input.coveredMessageIds ?? [],
    generatedAt: Date.now(),
    currentUserGoal: input.agentContext.userGoal,
    confirmedDecisions: unique(decisions),
    // 新会话使用结构化引用状态；旧字符串只在迁移前的历史上下文中回退使用。
    unresolvedQuestions: unique([
      ...(input.agentContext.referenceChecks ? [] : input.agentContext.unresolvedExistenceChecks ?? []),
      ...(input.unresolvedQuestions ?? [])
    ]),
    referenceChecks: input.agentContext.referenceChecks
      ? structuredClone(input.agentContext.referenceChecks)
      : undefined,
    filesRead: unique(input.agentContext.filesRead),
    filesModified: unique([...(input.filesModified ?? []), ...modifiedFiles(input.messages, input.pendingToolCall?.toolCallId)]),
    commands: (input.agentContext.commandsRun ?? []).slice(-10).map((command) => ({ ...command })),
    planStatus: input.planStatus ?? [],
    recentValidationFailures: recentFailures(input.messages),
    pendingApproval: input.pendingToolCall
      ? { actionId: input.pendingToolCall.actionId, toolName: input.pendingToolCall.toolName, arguments: input.pendingToolCall.arguments }
      : null
  };
}
