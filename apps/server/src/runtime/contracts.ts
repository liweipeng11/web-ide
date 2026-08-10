export type TaskType = "explore" | "implement" | "test" | "respond";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "blocked";

/** Runtime 使用的原子任务契约，不包含具体 Agent 的实现细节。 */
export interface Task {
  id: string;
  type: TaskType;
  goal: string;
  dependencies: string[];
  requiredCapabilities: string[];
  readScope: string[];
  writeScope: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
}

export interface Plan {
  version: number;
  goal: string;
  assumptions: string[];
  tasks: Task[];
  completionCriteria: string[];
}

export type AgentResultStatus = "success" | "failed" | "blocked";

/** 所有 Agent 都必须返回的统一结果，Runtime 只消费该结构。 */
export interface AgentResult {
  taskId: string;
  status: AgentResultStatus;
  summary: string;
  facts: string[];
  changedFiles: string[];
  evidence: string[];
  blockers: string[];
  scopeChangeRequest?: {
    reason: string;
    requiredScope: string[];
  };
}

export type AgentStateStatus = "running" | "completed" | "failed" | "waiting_user";

export interface AgentState {
  goal: string;
  plan?: Plan;
  currentTask?: string;
  completedTasks: string[];
  failedTasks: string[];
  changedFiles: string[];
  facts: string[];
  status: AgentStateStatus;
}

export interface AgentTaskPacket {
  taskId: string;
  goal: string;
  context: unknown;
  constraints: string[];
  acceptanceCriteria: string[];
  readScope: string[];
  writeScope: string[];
  allowedTools: string[];
}

export type MainIntent = "question" | "code_change" | "debug" | "analysis";

export type MainComplexity = "simple" | "medium" | "complex";

export type MainRoute = "direct" | "main_loop" | "planned";

/** Main Agent 的统一路由结果；所需能力仅用于调度，不能替代 Runtime 权限检查。 */
export interface RouteDecision {
  intent: MainIntent;
  complexity: MainComplexity;
  route: MainRoute;
  requiredCapabilities: string[];
}

export type NextAction =
  | { type: "respond"; content: string }
  | { type: "tool"; tool: string; args: unknown }
  | { type: "delegate"; agent: string; taskId: string }
  | { type: "replan"; reason: string }
  | { type: "finish" };

export type RuntimeToolEffect = "none" | "read" | "write" | "execute";

export interface RuntimeToolExecutionContext {
  agentId: string;
  task: AgentTaskPacket;
}

/** 工具必须声明副作用，并向权限层暴露实际目标路径。 */
export interface RuntimeTool {
  name: string;
  description: string;
  effect: RuntimeToolEffect;
  /** 模型可见的参数契约；真实参数仍需由工具和权限层校验。 */
  inputSchema?: unknown;
  getTargetPaths?: (args: Record<string, unknown>) => string[];
  /** 写工具通过该函数声明本次真实变更，Runtime 会再次校验 writeScope。 */
  getChangedFiles?: (args: Record<string, unknown>, result: unknown) => string[];
  execute: (args: Record<string, unknown>, context: RuntimeToolExecutionContext) => Promise<unknown>;
}

export type RuntimeToolDescriptor = Pick<RuntimeTool, "name" | "description" | "effect" | "inputSchema">;

export interface AgentContext {
  agentId: string;
  state: Readonly<AgentState>;
  availableTools: RuntimeToolDescriptor[];
  getState: () => Readonly<AgentState>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface Agent {
  id: string;
  capabilities: string[];
  run(task: AgentTaskPacket, context: AgentContext): Promise<AgentResult>;
}

export interface AgentPermissionPolicy {
  agentId: string;
  allowedTools: string[];
}

export interface RuntimeExecutionResult {
  result: AgentResult;
  state: AgentState;
}
