import type {
  AgentTaskPacket,
  Plan,
  RouteDecision,
  RuntimeExecutionResult,
  RuntimeTool,
  TaskType
} from "../../runtime/contracts.js";
import { AgentRegistry } from "../../runtime/agentRegistry.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import { RuntimeKernel } from "../../runtime/runtimeKernel.js";
import { createAgentState, StateManager } from "../../runtime/stateManager.js";
import { ToolRegistry } from "../../runtime/toolRegistry.js";
import { runtimeError } from "../../runtime/errors.js";
import { MainAgent } from "./mainAgent.js";

export type MainAgentRequest = {
  goal: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  readScope?: string[];
  writeScope?: string[];
  allowedTools?: string[];
};

export type MainAgentRuntimeResult = {
  decision: RouteDecision;
  execution: RuntimeExecutionResult;
};

export type MainAgentRuntimeOptions = {
  agent?: MainAgent;
  tools?: RuntimeTool[];
  allowedTools?: string[];
};

function taskTypeFor(decision: RouteDecision): TaskType {
  if (decision.intent === "code_change") return "implement";
  if (decision.intent === "question") return "respond";
  return "explore";
}

function createTask(goal: string, decision: RouteDecision, request: MainAgentRequest, allowedTools: string[]): AgentTaskPacket {
  const acceptanceCriteria = request.acceptanceCriteria?.map((item) => item.trim()).filter(Boolean)
    ?? ["Main Agent 已返回明确结果"];
  if (!acceptanceCriteria.length) {
    throw runtimeError("INVALID_CONTRACT", "Main Agent 请求至少需要一条验收标准。");
  }
  return {
    taskId: "MAIN-1",
    goal,
    context: { routeDecision: decision },
    constraints: request.constraints ?? [],
    acceptanceCriteria,
    readScope: request.readScope ?? [],
    // 只读意图即使收到调用方 writeScope，也不会把写权限带入任务。
    writeScope: decision.intent === "code_change" ? request.writeScope ?? [] : [],
    allowedTools
  };
}

function createPlan(task: AgentTaskPacket, decision: RouteDecision): Plan {
  return {
    version: 1,
    goal: task.goal,
    assumptions: [],
    tasks: [{
      id: task.taskId,
      type: taskTypeFor(decision),
      goal: task.goal,
      dependencies: [],
      // planned 只用于识别边界；阶段 1 不要求 Main 自己具备 Planner 的执行能力。
      requiredCapabilities: decision.route === "planned" ? [] : decision.requiredCapabilities,
      readScope: task.readScope,
      writeScope: task.writeScope,
      acceptanceCriteria: task.acceptanceCriteria,
      status: "pending"
    }],
    completionCriteria: [...task.acceptanceCriteria]
  };
}

/** 用户请求进入新 Runtime 的正式服务边界，调用方必须显式提供可用工具和访问范围。 */
export class MainAgentRuntime {
  private readonly agent: MainAgent;
  private readonly tools: ToolRegistry;
  private readonly policyTools: string[];

  constructor(options: MainAgentRuntimeOptions = {}) {
    this.agent = options.agent ?? new MainAgent();
    this.tools = new ToolRegistry(options.tools ?? []);
    this.policyTools = [...new Set(options.allowedTools ?? [])];
  }

  async execute(request: MainAgentRequest): Promise<MainAgentRuntimeResult> {
    const goal = request.goal.trim();
    if (!goal) throw runtimeError("INVALID_CONTRACT", "用户目标不能为空。");

    const decision = await this.agent.route(goal);
    const requestedTools = request.allowedTools ?? this.policyTools;
    const policyToolSet = new Set(this.policyTools);
    const available = this.tools.describeAvailable(requestedTools)
      .filter((tool) => policyToolSet.has(tool.name))
      .filter((tool) => decision.intent === "code_change" || tool.effect !== "write");
    const allowedTools = available.map((tool) => tool.name);
    const task = createTask(goal, decision, request, decision.route === "direct" ? [] : allowedTools);
    const state = new StateManager(createAgentState(goal, createPlan(task, decision)));
    const kernel = new RuntimeKernel({
      agents: new AgentRegistry([this.agent]),
      tools: this.tools,
      permissions: new PermissionManager([{ agentId: this.agent.id, allowedTools: this.policyTools }]),
      state
    });

    return {
      decision,
      execution: await kernel.execute(this.agent.id, task)
    };
  }
}
