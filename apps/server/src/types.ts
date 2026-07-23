export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type ReadFileResponse = {
  path: string;
  content: string;
};

export type GenerateEditRequest = {
  path?: string | null;
  userRequest: string;
};

export type SaveFileRequest = {
  path: string;
  content: string;
  // 客户端最后一次已保存内容，用于阻止覆盖磁盘上的并发修改。
  baseContent?: string;
};

// 文件内精确替换参数，供底层编辑服务和后续 Agent 工具复用。
export type ReplaceInFileInput = {
  filePath: string;
  search: string;
  replace: string;
  replaceAll?: boolean;
};

// 整文件写入参数；默认只允许覆盖已存在文件，避免意外创建路径。
export type WriteFileInput = {
  filePath: string;
  content: string;
  createIfMissing?: boolean;
};

// 文件编辑执行结果，finalContent 是后续链路继续编辑时的最新事实来源。
export type FileEditResult = {
  filePath: string;
  oldContent: string;
  finalContent: string;
  changed: boolean;
  replacements?: number;
  // 记录编辑前后的文件存在状态，checkpoint 回滚新建文件时需要据此删除文件。
  beforeExists?: boolean;
  afterExists?: boolean;
};

export type CodeSearchResult = {
  filePath: string;
  path: string;
  line: number;
  column: number;
  content: string;
  text: string;
  match: string;
  contextBefore?: Array<{ line: number; content: string }>;
  contextAfter?: Array<{ line: number; content: string }>;
};

export type SearchResult = {
  filePath: string;
  line: number;
  content: string;
};

export type PackageScript = {
  name: string;
  command: string;
};

export type ProjectCommand = PackageScript & {
  source: string;
  language: string;
  packageManager?: string;
  dependencyState?: "installed" | "missing" | "unknown";
};

export type ProjectRule = {
  path: string;
  scope: "global" | "project" | "legacy";
  source: "agents" | "cursor" | "windsurf" | "mini-ai";
  title: string;
  content: string;
  globs: string[];
  alwaysApply: boolean;
  active: boolean;
  truncated: boolean;
};

export type ProjectRulesResponse = {
  rules: ProjectRule[];
  combinedInstructions: string | null;
  supportedFiles: string[];
};

export type CommandResult = {
  executionId?: string;
  command: string;
  chatId?: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  summary?: string;
  status?: "success" | "failed" | "running" | "timeout" | "cancelled";
  detectedUrl?: string;
  detectedUrls?: string[];
  waitTimedOut?: boolean;
  outputTruncated?: boolean;
  readiness?: import("./commandExecution/types.js").CommandReadiness;
  interaction?: import("./commandExecution/types.js").CommandInteraction;
  startedAt: string;
  finishedAt: string;
};

export type CommandRiskLevel = "safe" | "confirm" | "blocked";

export type CommandPolicyResult = {
  level: CommandRiskLevel;
  reason: string;
};

export type RunCommandRequest = {
  command: string;
  chatId?: string;
  taskSessionId?: string;
  cwd?: string;
  confirmed?: boolean;
};

export type AutoValidationRequest = {
  // 未指定命令时由 Verifier 根据当前项目自动生成完整验证流水线。
  command?: string | null;
  selectedPath?: string | null;
  taskSessionId?: string | null;
  attempts?: number;
  maxAttempts?: number;
  // 完整应用 patch 后传入实际变更文件，供增量验证器收敛包和测试范围。
  changedFiles?: string[];
  failureCategories?: import("./verifier/types.js").VerificationIssueCategory[];
  changeContext?: string;
  confirmed?: boolean;
};

export type FileChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type FileChatHistoryItem = {
  path: string;
  messageCount: number;
  updatedAt: string;
  preview: string;
};

export type ChatContextFile = {
  path: string;
  content: string;
};

export type FileChatRequest = {
  chatId?: string;
  path?: string;
  paths?: string[];
  userRequest: string;
  replayFromMessageId?: string;
  approvedTaskSessionId?: string;
  agentMode?: AgentMode;
  modelSelection?: import("./contracts/model.js").ModelSelection;
};

export type FileChatResponse = {
  messages: FileChatMessage[];
  taskSessionId?: string;
  planPending?: boolean;
};

export type GenerateEditResponse = {
  taskSessionId?: string;
  patchId: string;
  // 模型原始摘要仅作为参考，主展示必须使用 finalSummary。
  modelSummary?: string;
  // 服务端基于最终 files 生成的摘要，是前端展示变更数量的唯一事实源。
  finalSummary: string;
  // 模型本轮返回的候选 patch 数量，用于提示候选变更被清洗的情况。
  rawPatchCount?: number;
  // 最终进入 diff 面板的文件数量，始终与 files.length 保持一致。
  finalPatchCount: number;
  // 记录模型候选变更被清洗、去重和过滤的过程，用于历史中解释“候选为何变少”。
  diagnostics?: PatchGenerationDiagnostics;
  summary: string;
  files: PatchFileChange[];
  commandsToRun?: string[];
  diffHtml: string;
  oldContent: string;
  newContent: string;
  agentSteps?: AgentStep[];
};

export type AutoValidationResponse = {
  status: "success" | "fix_generated" | "needs_confirmation" | "blocked" | "max_attempts_reached" | "no_commands" | "cancelled";
  command: string;
  attempts: number;
  maxAttempts: number;
  policy: CommandPolicyResult;
  result?: CommandResult;
  verification?: import("./verifier/types.js").VerificationReport;
  patch?: GenerateEditResponse;
  failureSummary?: string;
  agentSteps: AgentStep[];
};

export type AgentStep = {
  id: string;
  createdAt: number;
} & (
  | {
      type: "message";
      content: string;
    }
  | {
      type: "strategy";
      event:
        | "repeated_tool_warning"
        | "repeated_tool_blocked"
        | "negative_evidence"
        | "no_progress_recovery"
        | "budget_convergence"
        | "no_progress_stop"
        | "budget_stop";
      message: string;
      toolName?: string;
      repeatCount?: number;
      currentStep?: number;
      maxSteps?: number;
      facts?: string[];
    }
  | {
      type: "approval_request";
      actionId: string;
      actionType: "inspect_project" | "search_code" | "read_file" | "edit_files" | "run_command" | "apply_patch" | "write_file" | "delete_file" | "ask_user" | "tool_call";
      title: string;
      summary: string;
      riskLevel: "low" | "medium" | "high";
      status: "pending" | "approved" | "rejected" | "auto_approved";
      targets?: string[];
      command?: string;
      details?: unknown;
    }
  | {
      type: "tool_call";
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      toolName: string;
      output: unknown;
    }
  | {
      type: "edit";
      files: string[];
    }
  | {
      type: "command";
      command: string;
      executionId?: string;
      policy?: CommandPolicyResult;
      status?: "suggested" | "running" | "success" | "failed" | "blocked" | "cancelled";
      result?: CommandResult | null;
    }
  | {
      type: "checkpoint";
      checkpointId: string;
      files: string[];
      source?: CheckpointSource;
    }
  | {
      type: "error";
      message: string;
    }
);

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentMessageToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string | null;
  toolCallId?: string;
  toolCalls?: AgentMessageToolCall[];
  createdAt: number;
};

export type PendingAgentToolCall = {
  actionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  riskLevel: "low" | "medium" | "high";
  status: "pending";
  createdAt: number;
  // 审批恢复必须保留编辑门禁依赖的上下文，避免恢复后退回空白 Agent 状态。
  agentContext?: AgentContextSnapshot;
};

export type AgentContextSnapshot = {
  userGoal: string;
  filesRead: string[];
  searchQueries: string[];
  searchResultFiles: string[];
  relevantFiles: string[];
  negativeEvidence?: import("./agentToolTypes.js").NegativeEvidence[];
  patternSearchPerformed?: boolean;
  patternCandidateFiles?: string[];
  existenceCheckPerformed?: boolean;
  unresolvedExistenceChecks?: string[];
  impactAnalyses?: import("./impactAnalyzer/index.js").ImpactAnalysisResult[];
  commandsRun?: Array<{ command: string; status: "success" | "failed" | "running" | "cancelled"; exitCode: number | null }>;
  externalSources?: import("./externalContext/types.js").ExternalContextSource[];
};

export type AgentMode = "plan" | "act";

export type TaskPlanItemStatus = "pending" | "in_progress" | "completed" | "blocked";

export type TaskPlanItem = {
  id: string;
  // 关联工作流模板中的稳定步骤，状态推进不再依赖可编辑的展示标题。
  workflowStepId?: string;
  title: string;
  status: TaskPlanItemStatus;
  note?: string;
  evidence?: {
    stepIds: string[];
    files: string[];
    commands: string[];
  };
  createdAt: number;
  updatedAt: number;
};

export type TaskPlanRevisionTrigger = "user" | "agent" | "validation" | "system";

export type TaskPlanRevision = {
  id: string;
  trigger: TaskPlanRevisionTrigger;
  reason: string;
  beforeItems: {
    title: string;
    status: TaskPlanItemStatus;
  }[];
  afterItems: {
    title: string;
    status: TaskPlanItemStatus;
  }[];
  createdAt: number;
};

export type TaskPlanApproval = {
  required: boolean;
  status: "not_required" | "pending" | "approved";
  requestedAt?: number;
  approvedAt?: number;
};

// 任务会话状态会被连续 Agent 暂停/恢复复用，后续工具审批和用户追问都依赖这些状态。
export type TaskSessionStatus = "running" | "awaiting_approval" | "awaiting_user" | "paused" | "success" | "failed" | "cancelled" | "awaiting_replan";

export type TaskSession = {
  id: string;
  userGoal: string;
  agentMode?: AgentMode;
  // 记录任务实际使用的 Provider/模型，恢复时优先复用且不静默换型。
  modelSelection?: import("./contracts/model.js").ModelSelection;
  modelUsage?: import("./contracts/model.js").ModelUsage;
  estimatedCostUsd?: number | null;
  // 保存任务开始时选中的流程，供计划生成、历史回放和界面解释共同使用。
  workflow?: import("./taskWorkflow/index.js").TaskWorkflowSnapshot;
  chatId?: string;
  messageIds?: string[];
  status: TaskSessionStatus;
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  steps: AgentStep[];
  agentMessages?: AgentMessage[];
  pendingToolCall?: PendingAgentToolCall | null;
  planItems?: TaskPlanItem[];
  planRevisions?: TaskPlanRevision[];
  planApproval?: TaskPlanApproval;
  checkpointIds: string[];
  // 任务历史里的真实变更视图：预览仍看 pending patch，历史回放优先看 checkpoint。
  diffView?: TaskSessionDiffView;
  // 按 patch 维度沉淀生成诊断，旧任务读取时会自动补成空数组。
  patchDiagnostics?: PatchGenerationDiagnostics[];
  // 记录每轮 patch 前的上下文选取快照，用于回放“为什么这些文件足够或不足”。
  contextSelectionSnapshots?: import("./contextSelection/types.js").ContextSelectionSnapshot[];
  // 阶段 1 只保存预算数字和结构化摘要；原始消息仍由 agentMessages 独立持久化以便审计恢复。
  contextBudgetSnapshot?: import("./contracts/context.js").ContextBudgetSnapshot;
  contextSummary?: import("./contracts/context.js").StructuredContextSummary;
  // 按时间顺序沉淀 patch 生命周期事件，用于历史回放和审计。
  patchEvents?: PatchLifecycleEvent[];
  // 按时间顺序沉淀工具式文件编辑事件，用于追踪 replaceInFile/writeFile 的真实落盘历史。
  fileEditEvents?: FileEditLifecycleEvent[];
  gitCommits?: {
    hash: string;
    message: string;
    files: string[];
    createdAt: number;
  }[];
  createdAt: number;
  updatedAt: number;
};

export type TaskSessionCheckpointDiffFiles = {
  checkpointId: string;
  patchId?: string | null;
  files: string[];
};

export type TaskSessionDiffView = {
  // 模型曾提出或服务端生成过的文件，用于解释“建议修改过什么”。
  generatedFiles: string[];
  // 已经真实写入工作区的文件，优先来自 checkpoint，旧任务回退到 filesChanged。
  appliedFiles: string[];
  // 生成过但没有落盘的文件，用于区分被拒绝或未应用的候选修改。
  rejectedFiles: string[];
  // checkpoint 中保存的真实 before/after 文件，是历史 diff 的事实来源。
  checkpointDiffFiles: TaskSessionCheckpointDiffFiles[];
  source: "checkpoint" | "legacy";
};

export type UpsertTaskPlanItemRequest = {
  id?: string;
  title: string;
  status?: TaskPlanItemStatus;
  note?: string;
};

export type UpdateTaskPlanItemRequest = {
  title?: string;
  status?: TaskPlanItemStatus;
  note?: string;
};

export type RewriteTaskPlanRequest = {
  instruction: string;
};

export type InterruptTaskPlanRequest = {
  instruction?: string;
};

export type ApprovalDecisionRequest = {
  decision: "approved" | "rejected";
};

export type UpdateAgentModeRequest = {
  mode: AgentMode;
};

export type ApplyPatchRequest = {
  patchId: string;
  filePath?: string;
  acknowledgeSafeEditRisk?: boolean;
};

export type ApplyPatchResponse = {
  success: boolean;
  checkpoint: Checkpoint;
};

export type RejectPatchRequest = {
  patchId: string;
  filePath?: string;
};

export type SearchReplaceEdit = {
  search: string;
  replace: string;
  replaceAll?: boolean;
};

export type FilePatch = {
  filePath: string;
  status?: "create" | "modify" | "delete";
  oldContent: string;
  newContent: string;
  oldContentBase64?: string;
  newContentBase64?: string;
  isBinary?: boolean;
  summary: string;
  edits?: SearchReplaceEdit[];
};

export type PatchFilterReason = "invalid_path" | "duplicate_path" | "no_effect_change" | "scope_violation" | "stale_full_rewrite_retry";

export type PatchFilterStage = "path_validation" | "scope_validation" | "dedupe" | "content_diff" | "retry";

export type PatchFilterRecord = {
  reason: PatchFilterReason;
  stage: PatchFilterStage;
  attempt: number;
  filePath: string;
  normalizedPath?: string;
  detail?: string;
};

export type PatchGenerationDiagnostics = {
  patchId?: string;
  modelSummary?: string;
  rawPatchCount: number;
  normalizedFilePaths: string[];
  preDedupeCount: number;
  postDedupeCount: number;
  finalPatchCount: number;
  filteredCount: number;
  noEffectCount: number;
  records: PatchFilterRecord[];
  contextSelection?: import("./contextSelection/types.js").ContextSelectionSnapshot;
  patchCompleteness?: import("./contextSelection/types.js").PatchCompletenessReport;
  // Safe Editor 报告用于在历史记录中区分必要改动和扩散改动。
  safeEditReport?: import("./safeEditor/types.js").SafeEditReport;
  generatedAt: number;
};

export type PatchLifecycleEventType =
  | "patch_created"
  | "patch_filtered"
  | "patch_file_applied"
  | "patch_file_rejected"
  | "patch_completed"
  | "patch_superseded"
  | "auto_fix_patch_created";

export type PatchLifecycleEvent = {
  id: string;
  type: PatchLifecycleEventType;
  patchId: string;
  taskSessionId?: string | null;
  filePath?: string | null;
  filePaths?: string[];
  sourcePatchId?: string | null;
  command?: string | null;
  attempt?: number | null;
  message?: string | null;
  detail?: Record<string, unknown>;
  createdAt: number;
};

export type FileEditLifecycleEventType = "file_edit_started" | "file_edit_applied" | "file_edit_failed";

export type FileEditLifecycleEvent = {
  id: string;
  taskSessionId?: string | null;
  createdAt: number;
  type: FileEditLifecycleEventType;
  toolName: "replaceInFile" | "writeFile";
  filePath: string;
  checkpointId?: string;
  detail?: Record<string, unknown>;
};

export type CheckpointSource = {
  taskSessionId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  actionId?: string | null;
  patchId?: string | null;
  reason?: string | null;
};

export type EditScope = {
  allowedExistingFiles: string[];
  allowNewFiles: boolean;
  createdFileDirectories: string[];
  safeEditRecommendation?: import("./safeEditor/types.js").SafeEditRecommendation;
};

export type Checkpoint = {
  id: string;
  taskId: string;
  createdAt: number;
  source?: CheckpointSource;
  files: {
    filePath: string;
    beforeContent: string;
    afterContent: string;
    beforeContentBase64?: string;
    afterContentBase64?: string;
    isBinary?: boolean;
    beforeExists?: boolean;
    afterExists?: boolean;
  }[];
};

export type RollbackCheckpointRequest = {
  checkpointId: string;
};

export type EditPlan = {
  summary: string;
  status?: "patch" | "needs_context" | "plan" | "blocked";
  patches: FilePatch[] | null;
  editScope?: EditScope;
  nextSearchKeywords?: string[];
  commandsToRun?: string[];
};

export type AiEditResult = EditPlan;

export type PatchFileChange = {
  path: string;
  filePath: string;
  status: "create" | "modify" | "delete";
  oldContent: string;
  newContent: string;
  oldContentBase64?: string;
  newContentBase64?: string;
  isBinary?: boolean;
  summary: string;
  diffHtml: string;
  editHunks?: EditHunk[];
};

export type EditHunkLine = {
  type: "context" | "add" | "remove";
  content: string;
};

export type EditHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: EditHunkLine[];
};

export type PendingPatch = {
  patchId: string;
  taskSessionId?: string;
  files: PatchFileChange[];
  commandsToRun?: string[];
  diagnostics?: PatchGenerationDiagnostics;
  createdAt: number;
};
