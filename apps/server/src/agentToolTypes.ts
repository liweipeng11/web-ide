import type { AgentStep } from "./types.js";
import type { FileEditResult } from "./types.js";
import type { ContextCache } from "./codeDiscovery/index.js";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentContext = {
  userGoal: string;
  filesRead: string[];
  searchQueries: string[];
  searchResultFiles: string[];
  relevantFiles: string[];
  /** 记录本轮是否已经执行过相似实现检索，供编辑门禁判断。 */
  patternSearchPerformed?: boolean;
  /** 最近一次检索得到的候选文件，存在候选时至少应阅读一个。 */
  patternCandidateFiles?: string[];
  /** 本轮是否已执行引用存在性检查，避免在未确认路径或符号时直接编辑。 */
  existenceCheckPerformed?: boolean;
  /** 最近一次检查中仍缺失或歧义的引用，用于阻止不可靠的代码生成。 */
  unresolvedExistenceChecks?: string[];
};

export type AgentToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AgentMessage = {
  role: AgentRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
};

export type AgentToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export type JsonSchema = Record<string, unknown>;

export type AgentToolRuntime = {
  agentContext: AgentContext;
  runId: string;
  // 记录本轮连续 Agent 中生成的待审核补丁，路由层据此把 diff 推送给前端。
  generatedPatchIds?: string[];
  // 关联任务会话，用于把副作用工具的文件、命令和 checkpoint 记录回任务历史。
  taskSessionId?: string | null;
  cache: ContextCache;
  // 记录当前工具调用来源，副作用工具会写入 checkpoint，方便从任务步骤追溯和回滚。
  currentToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    actionId?: string | null;
  };
  pendingActionId?: string | null;
  // 连续 Agent Runtime 会统一生成审批步骤，旧编辑链路仍可保留工具内部的自动审批步骤。
  emitToolApprovalSteps?: boolean;
  onAgentStep?: (step: AgentStep) => void;
};

export type AgentFileEditToolResult = FileEditResult & {
  // 给步骤日志展示用的编辑前摘要，完整最终内容仍通过 finalContent 返回给模型继续判断。
  oldContentPreview: string;
  // 工具式编辑成功后生成的回滚点，用于任务历史审计和后续恢复。
  checkpointId?: string;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  // 副作用工具必须关闭缓存，避免审批后拿到旧结果却没有真实执行。
  cacheable?: boolean;
  execute: (args: Record<string, unknown>, runtime: AgentToolRuntime) => Promise<unknown>;
  summarize: (result: unknown, cached: boolean, args: Record<string, unknown>) => unknown;
};

export type AgentToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

export type AgentCompletionMessage = {
  role?: "assistant";
  content?: string | null;
  tool_calls?: AgentToolCall[];
};

export type AgentCompletionResponse = {
  choices?: Array<{
    message?: AgentCompletionMessage;
  }>;
};
