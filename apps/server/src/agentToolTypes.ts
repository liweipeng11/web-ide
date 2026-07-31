import type { AgentStep } from "./types.js";
import type { FileEditResult } from "./types.js";
import type { ContextCache } from "./codeDiscovery/index.js";
import type { ImpactAnalysisResult } from "./impactAnalyzer/index.js";
import type { ExternalContextSource } from "./externalContext/types.js";
import type { ReferenceResolution } from "./existenceChecker/types.js";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export type SearchConclusion = "matches_found" | "target_absent" | "scope_incomplete";

export type SearchToolResult<T> = {
  matches: T[];
  query: string;
  searchedPath: string;
  exhaustive: boolean;
  cached: boolean;
  conclusion: SearchConclusion;
};

export type NegativeEvidence = {
  kind: "path_absent" | "symbol_absent" | "text_absent";
  query: string;
  scope: string;
  sourceTool: string;
  exhaustive: boolean;
  createdAt: number;
};

export type CreateIntentFact = {
  target: string;
  scope: string;
  sourceTool: string;
  reason: "exhaustive_target_absent";
  createdAt: number;
};

/**
 * Agent 每次工具调用前后的可比较状态。
 * 这里只保存计数，不包含文件内容或命令输出，避免快照扩大运行时上下文。
 */
export type AgentProgressSnapshot = {
  discoveredFiles: number;
  filesRead: number;
  searchResults: number;
  negativeEvidence: number;
  generatedPatches: number;
  modifiedFiles: number;
  commandsRun: number;
  completedWorkflowSteps: number;
};

export type AgentContext = {
  userGoal: string;
  filesRead: string[];
  searchQueries: string[];
  searchResultFiles: string[];
  relevantFiles: string[];
  /** 完整搜索得到的未命中事实；Runtime 会把它作为后续决策依据，避免重复搜索。 */
  negativeEvidence?: NegativeEvidence[];
  /** 编辑型任务中由完整路径未命中推导出的创建事实，用于停止无效搜索并推进文件计划。 */
  createIntents?: CreateIntentFact[];
  /** 记录本轮是否已经执行过相似实现检索，供编辑门禁判断。 */
  patternSearchPerformed?: boolean;
  /** 最近一次检索得到的候选文件，存在候选时至少应阅读一个。 */
  patternCandidateFiles?: string[];
  /** 本轮是否已执行引用存在性检查，避免在未确认路径或符号时直接编辑。 */
  existenceCheckPerformed?: boolean;
  /** 最近一次检查中仍缺失或歧义的引用，用于阻止不可靠的代码生成。 */
  unresolvedExistenceChecks?: string[];
  /**
   * 按检查目标保存最新的结构化引用状态。
   * key 由 taskWorkflow/referenceChecks 统一生成，旧字符串字段仅用于兼容历史会话。
   */
  referenceChecks?: Record<string, ReferenceResolution>;
  /** 保存本轮影响分析证据，Safe Editor 据此生成最小修改集合。 */
  impactAnalyses?: ImpactAnalysisResult[];
  /** 补丁生成前确认的文件级修改计划，Safe Editor 将其作为 agent_plan 证据。 */
  modificationPlan?: import("./safeEditor/index.js").StructuredModificationPlan;
  /** 记录 Runtime 实际执行过的命令，bugfix 工作流据此确认已尝试复现或验证。 */
  commandsRun?: Array<{
    command: string;
    status: "success" | "failed" | "running" | "cancelled";
    exitCode: number | null;
    validation?: boolean;
    finishedAt?: number;
  }>;
  /** 保存本轮检索或抓取使用的外部来源，便于审批恢复、引用和审计。 */
  externalSources?: ExternalContextSource[];
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};
