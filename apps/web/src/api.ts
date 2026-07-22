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

export type LanguageServiceSource = "lsp" | "symbol_graph" | "text_search" | "combined" | "none";
export type SourceLocation = { filePath: string; line: number; column: number; endLine?: number; endColumn?: number; source?: LanguageServiceSource; complete?: boolean };
export type SourceRange = { start: { line: number; column: number }; end: { line: number; column: number } };
export type LanguageServiceCapability = {
  languageId: string;
  diagnostics: boolean;
  definition: boolean;
  references: boolean;
  hover: boolean;
  workspaceSymbols: boolean;
  codeActions: boolean;
  rename: boolean;
  source: LanguageServiceSource;
  available: boolean;
  degraded: boolean;
  detail?: string;
};
export type UnifiedDiagnostic = { filePath: string; range: SourceRange; severity: "error" | "warning" | "information" | "hint"; message: string; code?: string | number; source: LanguageServiceSource; documentVersion?: number };
export type UnifiedSymbol = { name: string; kind: string; location: SourceLocation; containerName?: string; source: LanguageServiceSource };
export type HoverInfo = { contents: string; range?: SourceRange; source: LanguageServiceSource };
export type LanguageWorkspaceEdit = { changes: Record<string, Array<{ range: SourceRange; newText: string }>>; source: LanguageServiceSource };
export type UnifiedCodeAction = { title: string; kind?: string; diagnostics: UnifiedDiagnostic[]; edit?: LanguageWorkspaceEdit; preferred?: boolean; source: LanguageServiceSource };

export type InlineEditRequest = {
  filePath: string;
  documentVersion: number;
  documentLineCount: number;
  selectionStartLineMaxColumn: number;
  selectionEndLineMaxColumn: number;
  selection: SourceRange;
  selectedText: string;
  instruction: string;
  prefix: string;
  suffix: string;
  languageId: string;
  diagnostics?: Array<{ message: string; severity: "error" | "warning" | "info"; range?: SourceRange }>;
  projectRules?: string | null;
};
export type InlineEditCandidate = { filePath: string; baseVersion: number; range: SourceRange; replacement: string; explanation?: string };
export type InlineEditResult = { mode: "inline"; candidate: InlineEditCandidate } | { mode: "patch_review"; reason: string };
export type InlineEditStreamEvent =
  | { type: "started" }
  | { type: "delta"; generatedCharacters: number }
  | { type: "candidate_delta"; replacement: string }
  | { type: "result"; result: InlineEditResult }
  | { type: "error"; message: string };

export type GenerateEditResponse = {
  taskSessionId?: string;
  patchId: string;
  // 模型原始摘要仅用于参考展示，不能作为变更数量事实源。
  modelSummary?: string;
  // 服务端基于最终 diff 文件生成的摘要，前端主展示统一使用它。
  finalSummary: string;
  rawPatchCount?: number;
  finalPatchCount: number;
  diagnostics?: PatchGenerationDiagnostics;
  summary: string;
  files: PatchFileChange[];
  commandsToRun?: string[];
  oldContent: string;
  newContent: string;
  diffHtml: string;
  agentSteps?: AgentStep[];
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
  safeEditReport?: SafeEditReport;
  generatedAt: number;
};

export type SafeEditFileRole = "required" | "supporting" | "validation_only" | "expansion";

export type SafeEditRisk = {
  kind: "scope_expansion" | "missing_impact_analysis" | "incomplete_impact_analysis" | "opportunistic_refactor" | "formatting_only" | "broad_rewrite" | "bulk_rename";
  level: "low" | "medium" | "high";
  filePath: string;
  message: string;
};

export type SafeEditReport = {
  status: "clean" | "warning" | "high_risk";
  recommendation: {
    requiredFiles: string[];
    conditionalFiles: string[];
    validationFiles: string[];
    editableScopeFiles: string[];
    impactAnalysisComplete: boolean | null;
    evidenceSource: "impact_analysis" | "explicit_target" | "none";
    diagnostics: string[];
  };
  files: Array<{
    filePath: string;
    role: SafeEditFileRole;
    reasons: string[];
    addedLines: number;
    removedLines: number;
    risks: SafeEditRisk[];
  }>;
  necessaryFiles: string[];
  expansionFiles: string[];
  risks: SafeEditRisk[];
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

export type AutoValidationResponse = {
  status: "success" | "fix_generated" | "needs_confirmation" | "blocked" | "max_attempts_reached" | "no_commands" | "cancelled";
  command: string;
  attempts: number;
  maxAttempts: number;
  policy: CommandPolicyResult;
  result?: CommandResult;
  verification?: VerificationReport;
  patch?: GenerateEditResponse;
  failureSummary?: string;
  agentSteps: AgentStep[];
};

export type VerificationStage = "format_syntax" | "typecheck" | "lint" | "test" | "build";

export type VerificationIssueCategory = "syntax" | "type" | "lint" | "test" | "build" | "timeout" | "command" | "unknown";

export type VerificationIssue = {
  category: VerificationIssueCategory;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
};

export type VerificationReport = {
  status: "success" | "failed" | "needs_confirmation" | "blocked" | "no_commands";
  plannedCommands: Array<{ name: string; command: string; source: string; reason: string; stage: VerificationStage }>;
  plan: {
    mode: "full" | "incremental" | "package_fallback";
    changedFiles: string[];
    affectedPackages: string[];
    relatedTests: string[];
    buildRequired: boolean;
    reasons: string[];
    diagnostics: string[];
  };
  executions: VerificationExecution[];
  failedExecution?: VerificationExecution;
};

export type VerificationExecution = {
  command: { name: string; command: string; source: string; reason: string; stage: VerificationStage };
  policy: CommandPolicyResult;
  result?: CommandResult;
  issues: VerificationIssue[];
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

export type CheckpointSource = {
  taskSessionId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  actionId?: string | null;
  patchId?: string | null;
  reason?: string | null;
};

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

export type FileChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
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

export type TaskPlanItemStatus = "pending" | "in_progress" | "completed" | "blocked";

export type TaskPlanItem = {
  id: string;
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

export type AgentMode = "plan" | "act";

export type ModelSelection = { providerId: string; modelId: string };
export type ModelSelectionDefaults = { chat: ModelSelection; plan: ModelSelection; act: ModelSelection };
export type ProviderSettings = {
  providerId: string;
  name: string;
  type: "openai-compatible";
  baseUrl: string;
  credentialConfigured: boolean;
  credentialPreview: string;
  models: string[];
  enabled: boolean;
};
export type ProviderSettingsInput = {
  providerId: string;
  name: string;
  type: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
};
export type CreateProviderInput = {
  name: string;
  type: "openai-compatible";
};
export type ProviderConnectionTestResult = {
  available: boolean;
  message: string;
  discoveredModelCount?: number;
  /** 检测接口从 Provider `/models` 获取的模型 ID。 */
  models: string[];
};
export type ModelDescriptor = {
  id: string;
  providerId: string;
  displayName: string;
  capabilities: {
    contextWindowTokens: number;
    maxOutputTokens: number;
    toolCalling: boolean;
    parallelToolCalling: boolean;
    imageInput: boolean;
    reasoningEffort: boolean;
    promptCache: boolean;
  };
  price?: { inputPerMillionTokens?: number; outputPerMillionTokens?: number; cachedInputPerMillionTokens?: number; currency: "USD" };
  recommendedFor?: string[];
  disabledReason?: string;
};
export type ModelCatalogResponse = {
  providers: Array<{ id: string; health: { configured: boolean; available: boolean; message?: string }; models: ModelDescriptor[] }>;
  defaults: ModelSelectionDefaults;
  providerSettings: ProviderSettings[];
};

export type TaskWorkflowType = "bugfix" | "feature" | "refactor" | "analysis-only";

export type TaskWorkflowSnapshot = {
  type: TaskWorkflowType;
  source: "intent" | "keyword" | "fallback";
  confidence: number;
  reason: string;
  steps: Array<{ id: string; title: string; description: string }>;
  version: number;
  selectedAt: number;
};

// 任务状态会被连续 Agent 的审批、暂停和重规划流程复用。
export type TaskSessionStatus = "running" | "awaiting_approval" | "awaiting_user" | "paused" | "success" | "failed" | "cancelled" | "awaiting_replan";

export type ContextBudgetSnapshot = {
  modelContextWindowTokens: number;
  reservedOutputTokens: number;
  reservedToolSchemaTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  estimatedInputTokensBeforeCompression: number;
  estimatedInputTokensAfterCompression: number;
  compressionCount: number;
  truncatedArtifactCount: number;
  includedFileCount: number;
  usageRatio: number;
  automaticCompression: boolean;
  generatedAt: number;
  estimator: "provider" | "conservative" | "unknown";
};

export type StructuredContextSummary = {
  version: 1;
  coveredMessageIds: string[];
  generatedAt: number;
  currentUserGoal: string;
  confirmedDecisions: string[];
  unresolvedQuestions: string[];
  filesRead: string[];
  filesModified: string[];
  commands: Array<{ command: string; status: "success" | "failed"; exitCode: number | null }>;
  planStatus: string[];
  recentValidationFailures: string[];
  pendingApproval: { actionId: string; toolName: string; arguments: unknown } | null;
};

export type TaskSession = {
  id: string;
  userGoal: string;
  agentMode?: AgentMode;
  modelSelection?: ModelSelection;
  modelUsage?: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedInputTokens: number };
  estimatedCostUsd?: number | null;
  workflow?: TaskWorkflowSnapshot;
  chatId?: string;
  messageIds?: string[];
  status: TaskSessionStatus;
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  steps: AgentStep[];
  contextBudgetSnapshot?: ContextBudgetSnapshot;
  contextSummary?: StructuredContextSummary;
  patchDiagnostics?: PatchGenerationDiagnostics[];
  patchEvents?: PatchLifecycleEvent[];
  planItems?: TaskPlanItem[];
  planRevisions?: TaskPlanRevision[];
  planApproval?: TaskPlanApproval;
  checkpointIds: string[];
  // 任务历史真实变更视图，历史 diff 展示优先以 checkpoint 为准。
  diffView?: TaskSessionDiffView;
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
  generatedFiles: string[];
  appliedFiles: string[];
  rejectedFiles: string[];
  checkpointDiffFiles: TaskSessionCheckpointDiffFiles[];
  source: "checkpoint" | "legacy";
};

export type FileChatHistoryItem = {
  path: string;
  messageCount: number;
  updatedAt: string;
  preview: string;
};

export type FileChatResponse = {
  messages: FileChatMessage[];
  taskSessionId?: string;
  planPending?: boolean;
};

export type FileChatHistoriesResponse = {
  histories: FileChatHistoryItem[];
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

export type CodeSearchResponse = {
  results: CodeSearchResult[];
};

export type CodeSearchMode = "literal" | "regex";

export type CodeSearchOptions = {
  mode?: CodeSearchMode;
  path?: string;
  filePattern?: string;
  limit?: number;
  caseSensitive?: boolean;
  contextLines?: number;
};

export type FileNameSearchResult = {
  name: string;
  path: string;
  type: "file" | "directory";
  depth: number;
  score: number;
  matchedBy: "name" | "extension" | "path";
};

export type FileNameSearchResponse = {
  results: FileNameSearchResult[];
};

export type ProjectCommand = {
  name: string;
  command: string;
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

export type AgentRulesSettings = {
  global: { path: string; content: string };
  project: { path: string; content: string; available: boolean };
};

export type ProjectMemoryTechStack = {
  packageManager: string | null;
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  lintTools: string[];
  typeSystems: string[];
  testTools: string[];
  workspacePackages: string[];
  scannedAt: number;
};

export type ProjectSnapshot = {
  projectSummary: string;
  projectSummarySource: "generated" | "manual";
  techStack: ProjectMemoryTechStack;
  currentGoals: string[];
  recentChanges: Array<{ taskSessionId: string; summary: string; files: string[]; changedAt: number }>;
  pendingItems: Array<{ taskSessionId: string; summary: string; status: TaskSessionStatus; updatedAt: number }>;
  confirmedRisks: string[];
};

export type ProjectMemoryItem = {
  id: string;
  kind: "convention" | "decision" | "fact" | "risk";
  content: string;
  status: "candidate" | "active" | "stale" | "rejected" | "superseded" | "archived";
  scope: { type: "project" | "path"; paths: string[] };
  sourceRefs: Array<{
    type: "schema_migration" | "task" | "user" | "file" | "symbol" | "dependency" | "git_commit" | "branch";
    value: string;
    contentHash?: string;
    filePath?: string;
  }>;
  createdBy: "migration" | "user" | "system";
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  lastValidatedAt?: number;
  validationStatus: "unverified" | "valid" | "possibly_stale" | "invalid" | "superseded" | "archived";
  expiresAt?: number;
  supersededBy?: string;
  promotedTo?: {
    rulePath: string;
    scope: "project" | "path";
    paths: string[];
    alwaysApply: boolean;
    promotedAt: number;
  };
};

export type MemoryUsageRecord = {
  id: string;
  createdAt: number;
  requestSummary: string;
  contextPaths: string[];
  tokenBudget: number;
  estimatedTokens: number;
  entries: Array<{
    itemId: string;
    contentPreview: string;
    score: number | null;
    reasons: string[];
    sourceTypes: Array<ProjectMemoryItem["sourceRefs"][number]["type"]>;
    validationStatus: ProjectMemoryItem["validationStatus"];
    includedInPrompt: boolean;
    exclusionReason?: "token_budget" | "item_limit";
  }>;
};

export type PromoteMemoryInput = {
  ruleFile: string;
  scope: "project" | "path";
  paths: string[];
  alwaysApply: boolean;
  confirmed: boolean;
};

export type ProjectMemory = {
  schemaVersion: number;
  snapshot: ProjectSnapshot;
  items: ProjectMemoryItem[];
  createdAt: number;
  updatedAt: number;
};

export type UpdateProjectMemoryInput = Partial<Pick<ProjectSnapshot, "projectSummary" | "currentGoals" | "confirmedRisks">>;
export type CreateMemoryCandidateInput = Pick<ProjectMemoryItem, "kind" | "content"> & {
  scope?: ProjectMemoryItem["scope"];
  sourceRefs?: Array<{ type: "user"; value: string }>;
  confidence?: number;
};
export type UpdateMemoryCandidateInput = Partial<Pick<ProjectMemoryItem, "kind" | "content" | "scope">>;
export type MemoryCandidateMutationResult = {
  candidate: ProjectMemoryItem;
  created: boolean;
  conflictIds: string[];
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
  readiness?: CommandReadiness;
  interaction?: CommandExecution["interaction"];
  startedAt: string;
  finishedAt: string;
};

export type CommandExecutionState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type CommandExecutionMode = "foreground" | "background" | "auto";
export type CommandReadiness = "pending" | "ready" | "not_applicable";
export type ShellCapability = "rich" | "basic" | "none";
export type CommandExecution = {
  id: string;
  command: string;
  cwd: string;
  chatId?: string;
  taskSessionId?: string;
  initiator: "agent" | "validation" | "user";
  mode: CommandExecutionMode;
  shell: { name: string; capability: ShellCapability };
  state: CommandExecutionState;
  readiness: CommandReadiness;
  readyUrl?: string;
  detectedUrls: string[];
  exitCode: number | null;
  signal?: string;
  pid?: number;
  waitTimedOut: boolean;
  outputTruncated: boolean;
  outputCursor: number;
  interaction: { state: "none" | "needs_input"; kind?: "password" | "passphrase" | "pin" | "verification_code" | "login_confirmation" | "unknown"; detectedAt?: string };
  pinned: boolean;
  startedAt: string;
  readyAt?: string;
  finishedAt?: string;
  failureReason?: "non_zero_exit" | "execution_timeout" | "spawn_error" | "output_limit" | "server_restart";
};
export type CommandOutputChunk = { id: string; cursor: number; nextCursor: number; data: string; truncated: boolean };
export type StartCommandExecutionInput = {
  command: string;
  cwd?: string;
  chatId?: string;
  taskSessionId?: string | null;
  mode?: CommandExecutionMode;
  waitTimeoutMs?: number;
  executionTimeoutMs?: number;
  readyPattern?: string;
  killOnWaitTimeout?: boolean;
  confirmed?: boolean;
};

export type CommandRiskLevel = "safe" | "confirm" | "blocked";

export type CommandPolicyResult = {
  level: CommandRiskLevel;
  reason: string;
};

export type CommandsResponse = {
  commands: ProjectCommand[];
  results: CommandResult[];
};

export type TaskSessionsResponse = {
  sessions: TaskSession[];
};

export type ResumeTaskSessionChatResponse = {
  session: TaskSession;
  chatId: string;
  messages: FileChatMessage[];
};

export type DecideApprovalRequestResponse = {
  session: TaskSession;
  messages?: FileChatMessage[];
  patch?: GenerateEditResponse | null;
  runtime?: {
    status: "completed" | "awaiting_approval" | "step_limit_reached";
    content: string;
    pendingToolCall: unknown | null;
  };
};

export type FileChatStreamEvent =
  | { event: "user"; data: { message: FileChatMessage } }
  | { event: "assistant_start"; data: { message: FileChatMessage } }
  | { event: "chat"; data: { chatId: string; historyCount: number; taskSessionId?: string } }
  | { event: "task_session"; data: { session: TaskSession } }
  | { event: "context_budget"; data: { taskSessionId: string; snapshot: ContextBudgetSnapshot; summary: StructuredContextSummary | null } }
  | { event: "agent_step"; data: { step: AgentStep } }
  | { event: "patch"; data: { patch: GenerateEditResponse } }
  | { event: "delta"; data: { id: string; delta: string } }
  | { event: "done"; data: { messages: FileChatMessage[] } }
  | { event: "error"; data: { error: string } };

export type GenerateEditStreamEvent =
  | { event: "task_session"; data: { session: TaskSession } }
  | { event: "agent_step"; data: { step: AgentStep } }
  | { event: "plan_pending"; data: { taskSessionId: string; message: string } }
  | { event: "done"; data: { patch: GenerateEditResponse } }
  | { event: "error"; data: { error: string } };

export type WorkspaceResponse = {
  workspaceRoot: string | null;
};

export type PickWorkspaceResponse = WorkspaceResponse & {
  cancelled: boolean;
};

export type ServerCapabilities = {
  version: 1;
  features: Record<"contextBudgetV2" | "modelProviderGateway" | "lsp" | "inlineEdit" | "commandExecutionV2", { enabled: boolean; available: boolean; active: boolean; path: "legacy" | "next" }>;
  models: { selection: boolean; configured: boolean; defaultModel: string; catalogEndpoint?: string };
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    },
    ...options
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || data?.summary || "请求失败");
  }

  return data as T;
}

export function fetchFiles(dir = "", includeIgnored = false) {
  return request<FileTreeNode[]>(`/api/files?dir=${encodeURIComponent(dir)}&includeIgnored=${includeIgnored ? "true" : "false"}`);
}

export function fetchWorkspace() {
  return request<WorkspaceResponse>("/api/workspace");
}

// 前端只消费服务端裁决后的实际能力，不直接读取构建环境变量。
export function fetchServerCapabilities() {
  return request<ServerCapabilities>("/api/capabilities");
}

export function fetchModelCatalog() {
  return request<ModelCatalogResponse>("/api/models");
}

export function updateModelDefaults(defaults: ModelSelectionDefaults) {
  return request<{ defaults: ModelSelectionDefaults }>("/api/models/defaults", { method: "PUT", body: JSON.stringify(defaults) });
}

export function updateProviderSettings(settings: ProviderSettingsInput) {
  return request<{ settings: ProviderSettings; providerSettings: ProviderSettings[]; defaults: ModelSelectionDefaults; providers: ModelCatalogResponse["providers"] }>("/api/models/provider-settings", {
    method: "PUT",
    body: JSON.stringify(settings)
  });
}

export function createProvider(settings: CreateProviderInput) {
  return request<{ settings: ProviderSettings; providerSettings: ProviderSettings[]; providers: ModelCatalogResponse["providers"] }>("/api/models/providers", {
    method: "POST",
    body: JSON.stringify(settings)
  });
}

export function testProviderConnection(settings: Pick<ProviderSettingsInput, "providerId" | "baseUrl" | "apiKey">) {
  return request<ProviderConnectionTestResult>("/api/models/provider-settings/test", {
    method: "POST",
    body: JSON.stringify(settings)
  });
}

export function openWorkspace(workspaceRoot: string) {
  return request<WorkspaceResponse>("/api/workspace/open", {
    method: "POST",
    body: JSON.stringify({ workspaceRoot })
  });
}

export function pickWorkspace() {
  return request<PickWorkspaceResponse>("/api/workspace/pick", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function fetchFile(path: string, includeIgnored = false) {
  return request<ReadFileResponse>(`/api/file?path=${encodeURIComponent(path)}&includeIgnored=${includeIgnored ? "true" : "false"}`);
}

function appendOptionalSearchParam(params: URLSearchParams, key: string, value: string | number | boolean | undefined) {
  if (value === undefined || value === "" || value === false) return;
  params.set(key, String(value));
}

export function searchCode(query: string, options: CodeSearchOptions = {}) {
  const params = new URLSearchParams({ q: query });

  // 搜索参数在前端集中序列化，避免组件直接拼接查询字符串导致遗漏编码。
  appendOptionalSearchParam(params, "mode", options.mode);
  appendOptionalSearchParam(params, "path", options.path?.trim());
  appendOptionalSearchParam(params, "filePattern", options.filePattern?.trim());
  appendOptionalSearchParam(params, "limit", options.limit);
  appendOptionalSearchParam(params, "caseSensitive", options.caseSensitive);
  appendOptionalSearchParam(params, "contextLines", options.contextLines);

  return request<CodeSearchResponse>(`/api/search?${params.toString()}`);
}

export function searchFilesByName(query: string, options: Pick<CodeSearchOptions, "path" | "limit"> = {}) {
  const params = new URLSearchParams({ q: query });

  // 文件名搜索用于低成本路径发现，不携带正文搜索才需要的 filePattern/contextLines。
  appendOptionalSearchParam(params, "path", options.path?.trim());
  appendOptionalSearchParam(params, "limit", options.limit);

  return request<FileNameSearchResponse>(`/api/search/files?${params.toString()}`);
}

export function fetchProjectCommands() {
  return request<CommandsResponse>("/api/commands");
}

export function fetchProjectRules(paths: string[] = []) {
  const query = paths.map((path) => `path=${encodeURIComponent(path)}`).join("&");
  return request<ProjectRulesResponse>(`/api/project-rules${query ? `?${query}` : ""}`);
}

export function fetchAgentRulesSettings() {
  return request<{ settings: AgentRulesSettings }>("/api/agent-rules");
}

export function updateAgentRulesSettings(input: { globalContent: string; projectContent?: string }) {
  return request<{ settings: AgentRulesSettings }>("/api/agent-rules", {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function fetchProjectMemory() {
  return request<{ memory: ProjectMemory }>("/api/project-memory");
}

export function updateProjectMemory(input: UpdateProjectMemoryInput) {
  return request<{ memory: ProjectMemory }>("/api/project-memory", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function refreshProjectMemory() {
  return request<{ memory: ProjectMemory }>("/api/project-memory/refresh", { method: "POST", body: JSON.stringify({}) });
}

export function fetchMemoryCandidates() {
  return request<{ candidates: ProjectMemoryItem[] }>("/api/project-memory/candidates");
}

export function fetchMemoryItems() {
  return request<{ items: ProjectMemoryItem[] }>("/api/project-memory/items");
}

export function fetchMemoryUsage(limit = 10) {
  return request<{ records: MemoryUsageRecord[] }>(`/api/project-memory/usage?limit=${encodeURIComponent(limit)}`);
}

export function createMemoryCandidate(input: CreateMemoryCandidateInput) {
  return request<MemoryCandidateMutationResult>("/api/project-memory/candidates", { method: "POST", body: JSON.stringify(input) });
}

export function updateMemoryCandidate(id: string, input: UpdateMemoryCandidateInput) {
  return request<{ candidate: ProjectMemoryItem }>(`/api/project-memory/candidates/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function acceptMemoryCandidate(id: string) {
  return request<{ candidate: ProjectMemoryItem }>(`/api/project-memory/candidates/${encodeURIComponent(id)}/accept`, { method: "POST", body: JSON.stringify({}) });
}

export function rejectMemoryCandidate(id: string) {
  return request<void>(`/api/project-memory/candidates/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({}) });
}

export function deleteMemoryItem(id: string) {
  return request<void>(`/api/project-memory/items/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function updateMemoryItem(id: string, input: UpdateMemoryCandidateInput) {
  return request<{ item: ProjectMemoryItem }>(`/api/project-memory/items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteMemoryItems(ids: string[]) {
  return request<{ deletedCount: number }>("/api/project-memory/items/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids, confirmed: true })
  });
}

export function promoteMemoryItem(id: string, input: PromoteMemoryInput) {
  return request<{ item: ProjectMemoryItem; rulePath: string }>(`/api/project-memory/items/${encodeURIComponent(id)}/promote`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function fetchCommandPolicy(command: string) {
  return request<{ policy: CommandPolicyResult }>("/api/commands/policy", {
    method: "POST",
    body: JSON.stringify({ command })
  });
}

export function runProjectCommand(command: string, cwd?: string, chatId?: string, confirmed = false, taskSessionId?: string | null) {
  return request<{ result: CommandResult }>("/api/commands/run", {
    method: "POST",
    body: JSON.stringify({ command, cwd, chatId, confirmed, taskSessionId })
  });
}

export function startCommandExecution(input: StartCommandExecutionInput) {
  return request<{ execution: CommandExecution }>("/api/command-executions", { method: "POST", body: JSON.stringify(input) });
}

export function fetchCommandExecutions(filter: { chatId?: string; taskSessionId?: string; state?: CommandExecutionState } = {}) {
  const query = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return request<{ executions: CommandExecution[] }>(`/api/command-executions${query.size ? `?${query}` : ""}`);
}

export function fetchCommandExecution(id: string) {
  return request<{ execution: CommandExecution }>(`/api/command-executions/${encodeURIComponent(id)}`);
}

export function fetchCommandExecutionOutput(id: string, cursor = 0) {
  return request<{ output: CommandOutputChunk }>(`/api/command-executions/${encodeURIComponent(id)}/output?cursor=${encodeURIComponent(cursor)}`);
}

export function stopCommandExecution(id: string) {
  return request<{ execution: CommandExecution }>(`/api/command-executions/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" });
}

export function pinCommandExecution(id: string, pinned: boolean) {
  return request<{ execution: CommandExecution }>(`/api/command-executions/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
}

export function fetchCommandExecutionMetrics() {
  return request<{ metrics: Record<string, unknown> }>("/api/command-executions/metrics");
}

export function moveCommandExecutionToBackground(id: string) {
  return request<{ execution: CommandExecution }>(`/api/command-executions/${encodeURIComponent(id)}/background`, { method: "POST", body: "{}" });
}

export function removeCommandExecution(id: string) {
  return request<void>(`/api/command-executions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchCommandExecutionSummary(id: string) {
  return request<{ summary: { summary: string; output: string; truncated: boolean } }>(`/api/command-executions/${encodeURIComponent(id)}/summary`);
}

export function validateAndFix(command?: string | null, options: {
  selectedPath?: string | null;
  taskSessionId?: string | null;
  attempts?: number;
  maxAttempts?: number;
  changedFiles?: string[];
  failureCategories?: VerificationIssueCategory[];
  changeContext?: string;
  confirmed?: boolean;
} = {}) {
  return request<AutoValidationResponse>("/api/ai/validate-and-fix", {
    method: "POST",
    body: JSON.stringify({
      command,
      ...options
    })
  });
}

export function saveFile(path: string, content: string, baseContent?: string) {
  return request<{ success: boolean; path: string; checkpoint: Checkpoint | null }>("/api/file", {
    method: "POST",
    body: JSON.stringify({ path, content, baseContent })
  });
}

export async function streamInlineEdit(input: InlineEditRequest, onEvent: (event: InlineEditStreamEvent) => void, signal?: AbortSignal) {
  const response = await fetch("/api/inline-edit/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `Inline Edit 请求失败，状态码 ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split("\n\n");
    buffer = packets.pop() || "";
    for (const packet of packets) {
      const dataLine = packet.match(/^data:\s*(.+)$/m)?.[1];
      if (dataLine) onEvent(JSON.parse(dataLine) as InlineEditStreamEvent);
    }
  }
}

export function fetchLanguageServiceCapabilities(path: string) {
  return request<LanguageServiceCapability>(`/api/language-service/capabilities?path=${encodeURIComponent(path)}`);
}

export function syncLanguageDocument(input: { filePath: string; content?: string; version: number; action: "open" | "change" | "save" | "close" }) {
  return request<{ success: boolean; version: number }>("/api/language-service/documents", { method: "POST", body: JSON.stringify(input) });
}

export function fetchLanguageDiagnostics(path: string, version: number) {
  return request<{ diagnostics: UnifiedDiagnostic[] }>(`/api/language-service/diagnostics?path=${encodeURIComponent(path)}&version=${version}`);
}

export function findLanguageDefinition(location: SourceLocation) {
  return request<{ result: SourceLocation[] }>("/api/language-service/definition", { method: "POST", body: JSON.stringify({ location }) });
}

export function findLanguageReferences(location: SourceLocation) {
  return request<{ result: SourceLocation[] }>("/api/language-service/references", { method: "POST", body: JSON.stringify({ location }) });
}

export function fetchLanguageHover(location: SourceLocation) {
  return request<{ result: HoverInfo | null }>("/api/language-service/hover", { method: "POST", body: JSON.stringify({ location }) });
}

export function fetchLanguageCodeActions(filePath: string, range: SourceRange, diagnostics: UnifiedDiagnostic[]) {
  return request<{ actions: UnifiedCodeAction[] }>("/api/language-service/code-actions", { method: "POST", body: JSON.stringify({ filePath, range, diagnostics }) });
}

export function createLanguageWorkspaceEditPatch(edit: LanguageWorkspaceEdit, summary: string) {
  return request<{ patch: GenerateEditResponse }>("/api/language-service/workspace-edit/patch", { method: "POST", body: JSON.stringify({ edit, summary }) });
}

export function renameLanguageSymbol(location: SourceLocation, newName: string) {
  return request<{ edit: LanguageWorkspaceEdit; patch: GenerateEditResponse }>("/api/language-service/rename", { method: "POST", body: JSON.stringify({ location, newName }) });
}

export function searchLanguageWorkspaceSymbols(query: string) {
  return request<{ symbols: UnifiedSymbol[] }>(`/api/language-service/symbols?query=${encodeURIComponent(query)}`);
}

export function generateEdit(path: string | null, userRequest: string) {
  return request<GenerateEditResponse>("/api/ai/generate-edit", {
    method: "POST",
    body: JSON.stringify({ path, userRequest })
  });
}

export async function streamGenerateEdit(path: string | null, userRequest: string, onEvent: (event: GenerateEditStreamEvent) => void, signal?: AbortSignal) {
  const response = await fetch("/api/ai/generate-edit/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({ path, userRequest })
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `请求失败，状态码 ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split("\n\n");
    buffer = packets.pop() || "";

    for (const packet of packets) {
      const event = packet.match(/^event:\s*(.+)$/m)?.[1]?.trim() as GenerateEditStreamEvent["event"] | undefined;
      const dataLine = packet.match(/^data:\s*(.+)$/m)?.[1];

      if (!event || !dataLine) continue;

      onEvent({ event, data: JSON.parse(dataLine) } as GenerateEditStreamEvent);
    }
  }
}

export function fetchFileChat(chatId?: string) {
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
  return request<FileChatResponse>(`/api/ai/file-chat${query}`);
}

export function fetchFileChatHistories() {
  return request<FileChatHistoriesResponse>("/api/ai/file-chat/histories");
}

export function fetchTaskSessions() {
  return request<TaskSessionsResponse>("/api/task-sessions");
}

export function fetchTaskSession(taskSessionId: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}`);
}

export function resumeTaskSessionChat(taskSessionId: string) {
  return request<ResumeTaskSessionChatResponse>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/resume-chat`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function deleteTaskSession(taskSessionId: string) {
  return request<TaskSessionsResponse>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}`, {
    method: "DELETE"
  });
}

export function recordTaskSessionCommand(taskSessionId: string, command: string, result?: CommandResult | null) {
  return request<{ success: boolean }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ command, result })
  });
}

export function createTaskPlanItem(taskSessionId: string, title: string, status: TaskPlanItemStatus = "pending", note = "") {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items`, {
    method: "POST",
    body: JSON.stringify({ title, status, note })
  });
}

export function updateTaskPlanItem(taskSessionId: string, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items/${encodeURIComponent(planItemId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
}

export function deleteTaskPlanItem(taskSessionId: string, planItemId: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items/${encodeURIComponent(planItemId)}`, {
    method: "DELETE"
  });
}

export function rewriteTaskPlan(taskSessionId: string, instruction: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items/rewrite`, {
    method: "POST",
    body: JSON.stringify({ instruction })
  });
}

export function interruptTaskSessionPlan(taskSessionId: string, instruction = "") {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan/replan`, {
    method: "POST",
    body: JSON.stringify({ instruction })
  });
}

export function approveTaskPlan(taskSessionId: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan/approve`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function updateTaskSessionMode(taskSessionId: string, mode: AgentMode) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode })
  });
}

export function decideApprovalRequest(taskSessionId: string, actionId: string, decision: "approved" | "rejected") {
  return request<DecideApprovalRequestResponse>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/approvals/${encodeURIComponent(actionId)}`, {
    method: "POST",
    body: JSON.stringify({ decision })
  });
}

export function deleteFileChatHistory(path: string) {
  return request<FileChatHistoriesResponse>(`/api/ai/file-chat/histories?path=${encodeURIComponent(path)}`, {
    method: "DELETE"
  });
}

export function sendFileChatMessage(userRequest: string, paths: string[] = [], chatId?: string, agentMode: AgentMode = "act") {
  return request<FileChatResponse>("/api/ai/file-chat", {
    method: "POST",
    body: JSON.stringify({ chatId, paths, userRequest, agentMode })
  });
}

export async function streamFileChatMessage(userRequest: string, paths: string[], chatId: string, agentMode: AgentMode, onEvent: (event: FileChatStreamEvent) => void, signal?: AbortSignal, replayFromMessageId?: string, path?: string | null, approvedTaskSessionId?: string, modelSelection?: ModelSelection) {
  const response = await fetch("/api/ai/file-chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({ chatId, path, paths, userRequest, replayFromMessageId, approvedTaskSessionId, agentMode, modelSelection })
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `请求失败，状态码 ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split("\n\n");
    buffer = packets.pop() || "";

    for (const packet of packets) {
      const event = packet.match(/^event:\s*(.+)$/m)?.[1]?.trim() as FileChatStreamEvent["event"] | undefined;
      const dataLine = packet.match(/^data:\s*(.+)$/m)?.[1];

      if (!event || !dataLine) continue;

      onEvent({ event, data: JSON.parse(dataLine) } as FileChatStreamEvent);
    }
  }
}

export function clearFileChat(chatId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat?chatId=${encodeURIComponent(chatId)}`, {
    method: "DELETE"
  });
}

export function deleteFileChatMessage(chatId: string, messageId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat/messages/${encodeURIComponent(messageId)}?chatId=${encodeURIComponent(chatId)}`, {
    method: "DELETE"
  });
}

export function branchFileChatMessage(chatId: string, messageId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat/messages/${encodeURIComponent(messageId)}/branch`, {
    method: "POST",
    body: JSON.stringify({ chatId })
  });
}

export function applyPatch(patchId: string, filePath?: string, acknowledgeSafeEditRisk = false) {
  return request<{ success: boolean; checkpoint: Checkpoint }>("/api/patch/apply", {
    method: "POST",
    body: JSON.stringify({ patchId, filePath, acknowledgeSafeEditRisk })
  });
}

export function fetchCheckpoint(checkpointId: string) {
  return request<{ checkpoint: Checkpoint }>(`/api/checkpoints/${encodeURIComponent(checkpointId)}`);
}

export function rollbackCheckpoint(checkpointId: string) {
  return request<{ success: boolean }>("/api/checkpoints/rollback", {
    method: "POST",
    body: JSON.stringify({ checkpointId })
  });
}

export function rejectPatch(patchId: string, filePath?: string) {
  return request<{ success: boolean }>("/api/patch/reject", {
    method: "POST",
    body: JSON.stringify({ patchId, filePath })
  });
}
