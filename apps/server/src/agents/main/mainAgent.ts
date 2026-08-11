import type {
  Agent,
  AgentContext,
  AgentResult,
  AgentState,
  AgentTaskPacket,
  MainComplexity,
  MainIntent,
  MainRoute,
  NextAction,
  RouteDecision,
  RuntimeToolDescriptor
} from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import type { MainAgentDecisionModel } from "./mainAgentModel.js";
import { ProviderMainAgentDecisionModel } from "./mainAgentModel.js";
import { buildMainActionPrompt } from "./prompt.js";

export const MAX_MAIN_AGENT_STEPS = 30;

const INTENTS = new Set<MainIntent>(["question", "code_change", "debug", "analysis"]);
const COMPLEXITIES = new Set<MainComplexity>(["simple", "medium", "complex"]);
const ROUTES = new Set<MainRoute>(["direct", "main_loop", "planned"]);

const READ_ONLY_PATTERN = /(?:只|仅)(?:分析|检查|排查|解释|说明)|不要(?:修改|改动|编辑)|do not (?:edit|modify)|read[- ]only/i;
const CODE_CHANGE_PATTERN = /修改|改成|修复|实现|新增|添加|删除|移除|重构|迁移|升级|优化|fix|implement|add|remove|refactor|migrate/i;
const DEBUG_PATTERN = /报错|错误|异常|失败|不生效|无法|不能|bug|error|exception|failed/i;
const ANALYSIS_PATTERN = /分析|检查|排查|评估|审查|调研|analy[sz]e|inspect|review/i;
const COMPLEX_PATTERN = /整个|全部|全量|全面|跨模块|架构|系统|迁移|重构|兼容|所有|批量|architecture|system-wide|migrate|refactor/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function deriveCapabilities(intent: MainIntent, route: MainRoute) {
  if (route === "direct") return [];
  if (route === "planned") {
    return intent === "code_change"
      ? ["planning", "exploration", "editing", "testing"]
      : ["planning", "exploration"];
  }
  if (intent === "code_change") return ["read", "edit"];
  return ["read"];
}

function fallbackRoute(userRequest: string): RouteDecision {
  const readOnly = READ_ONLY_PATTERN.test(userRequest);
  const diagnostic = DEBUG_PATTERN.test(userRequest);
  const codeChange = CODE_CHANGE_PATTERN.test(userRequest);
  const analysis = ANALYSIS_PATTERN.test(userRequest);

  let intent: MainIntent = "question";
  if (readOnly) intent = diagnostic ? "debug" : "analysis";
  else if (codeChange) intent = "code_change";
  else if (diagnostic) intent = "debug";
  else if (analysis) intent = "analysis";

  const complexity: MainComplexity = COMPLEX_PATTERN.test(userRequest)
    ? "complex"
    : intent === "question" ? "simple" : "medium";
  const route: MainRoute = complexity === "simple" ? "direct" : complexity === "complex" ? "planned" : "main_loop";
  return { intent, complexity, route, requiredCapabilities: deriveCapabilities(intent, route) };
}

function parseRouteDecision(value: unknown, userRequest: string): RouteDecision {
  if (!isRecord(value) || !INTENTS.has(value.intent as MainIntent)
    || !COMPLEXITIES.has(value.complexity as MainComplexity) || !ROUTES.has(value.route as MainRoute)) {
    throw runtimeError("INVALID_CONTRACT", "Main Agent 返回了无效的 RouteDecision。");
  }

  let intent = value.intent as MainIntent;
  if (READ_ONLY_PATTERN.test(userRequest) && intent === "code_change") {
    intent = DEBUG_PATTERN.test(userRequest) ? "debug" : "analysis";
  }
  const complexity = value.complexity as MainComplexity;
  const expectedRoute: MainRoute = complexity === "simple" ? "direct" : complexity === "complex" ? "planned" : "main_loop";
  if (value.route !== expectedRoute) {
    throw runtimeError("INVALID_CONTRACT", "RouteDecision 的复杂度与路由不一致。", {
      complexity,
      route: value.route
    });
  }
  return { intent, complexity, route: expectedRoute, requiredCapabilities: deriveCapabilities(intent, expectedRoute) };
}

function getTaskRouteDecision(task: AgentTaskPacket) {
  if (!isRecord(task.context) || !("routeDecision" in task.context)) return null;
  return parseRouteDecision(task.context.routeDecision, task.goal);
}

function parseNextAction(value: unknown, availableTools: RuntimeToolDescriptor[]): NextAction {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw runtimeError("INVALID_CONTRACT", "Main Agent 返回了无效的 NextAction。");
  }

  if (value.type === "respond") {
    const content = nonEmptyString(value.content);
    if (!content) throw runtimeError("INVALID_CONTRACT", "respond action 的 content 不能为空。");
    return { type: "respond", content };
  }
  if (value.type === "tool") {
    const tool = nonEmptyString(value.tool);
    if (!tool || !isRecord(value.args)) {
      throw runtimeError("INVALID_CONTRACT", "tool action 必须包含合法的工具名和参数对象。");
    }
    if (!availableTools.some((candidate) => candidate.name === tool)) {
      throw runtimeError("PERMISSION_DENIED", `Main Agent 不能调用任务未授权的工具 ${tool}。`, { toolName: tool });
    }
    return { type: "tool", tool, args: value.args };
  }
  if (value.type === "delegate") {
    const agent = nonEmptyString(value.agent);
    const taskId = nonEmptyString(value.taskId);
    if (!agent || !taskId) throw runtimeError("INVALID_CONTRACT", "delegate action 缺少 agent 或 taskId。");
    return { type: "delegate", agent, taskId };
  }
  if (value.type === "replan") {
    const reason = nonEmptyString(value.reason);
    if (!reason) throw runtimeError("INVALID_CONTRACT", "replan action 的 reason 不能为空。");
    return { type: "replan", reason };
  }
  if (value.type === "finish") return { type: "finish" };
  throw runtimeError("INVALID_CONTRACT", `未知 NextAction：${value.type}`);
}

function serializeObservation(result: unknown) {
  if (result === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(result)) as unknown;
  } catch {
    return String(result);
  }
}

function createResult(taskId: string, status: AgentResult["status"], summary: string, extras: Partial<AgentResult> = {}): AgentResult {
  return {
    taskId,
    status,
    summary,
    facts: extras.facts ?? [],
    changedFiles: extras.changedFiles ?? [],
    evidence: extras.evidence ?? [],
    blockers: extras.blockers ?? [],
    ...(extras.scopeChangeRequest ? { scopeChangeRequest: extras.scopeChangeRequest } : {})
  };
}

export type MainNextActionContext = {
  task: AgentTaskPacket;
  routeDecision: RouteDecision;
  availableTools: RuntimeToolDescriptor[];
  observations: Array<{ tool: string; result: unknown }>;
};

export type MainSummaryInput = {
  goal: string;
  routeDecision: RouteDecision;
  results: AgentResult[];
  changedFiles: string[];
};

/** Main Agent 只持有目标和控制流；所有真实工具调用仍由 Runtime 权限层执行。 */
export class MainAgent implements Agent {
  readonly id = "main";
  readonly capabilities = ["routing", "respond", "read", "edit", "execute", "delegate", "replan"];

  constructor(
    private readonly model: MainAgentDecisionModel = new ProviderMainAgentDecisionModel(),
    private readonly maxSteps = MAX_MAIN_AGENT_STEPS
  ) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw runtimeError("INVALID_CONTRACT", "Main Agent 最大步数必须是正整数。", { maxSteps });
    }
  }

  async route(userRequest: string) {
    const goal = nonEmptyString(userRequest);
    if (!goal) throw runtimeError("INVALID_CONTRACT", "用户目标不能为空。");
    try {
      return parseRouteDecision(await this.model.route(goal), goal);
    } catch {
      // 模型不可用或结构化输出非法时保守降级，复杂修改不会误入直接执行路径。
      return fallbackRoute(goal);
    }
  }

  async nextAction(state: Readonly<AgentState>, context: MainNextActionContext) {
    const rawAction = await this.model.nextAction(buildMainActionPrompt({
      goal: context.task.goal,
      routeDecision: context.routeDecision,
      state,
      availableTools: context.availableTools,
      observations: context.observations
    }));
    return parseNextAction(rawAction, context.availableTools);
  }

  /** Main 只基于结构化结果生成最终说明；模型不可用时回退为可审计的确定性摘要。 */
  async summarize(input: MainSummaryInput) {
    const fallback = input.results.map((result) => result.summary).filter(Boolean).join("\n") || "计划已完成。";
    if (!this.model.summarize) return fallback;
    try {
      const value = await this.model.summarize(JSON.stringify({
        goal: input.goal,
        routeDecision: input.routeDecision,
        changedFiles: input.changedFiles,
        results: input.results.map((result) => ({
          taskId: result.taskId,
          status: result.status,
          summary: result.summary,
          facts: result.facts,
          changedFiles: result.changedFiles,
          evidence: result.evidence,
          blockers: result.blockers
        }))
      }));
      if (!isRecord(value)) return fallback;
      return nonEmptyString(value.content) ?? fallback;
    } catch {
      return fallback;
    }
  }

  async run(task: AgentTaskPacket, context: AgentContext): Promise<AgentResult> {
    // 正式入口会预先完成一次路由并写入 Task context，避免重复调用模型。
    const routeDecision = getTaskRouteDecision(task) ?? await this.route(task.goal);
    if (routeDecision.route === "planned") {
      return createResult(task.taskId, "blocked", "该任务需要 Planner 生成计划。", {
        facts: [`路由结果：${routeDecision.intent}/${routeDecision.complexity}/${routeDecision.route}`],
        blockers: ["planned 路由必须由 MainAgentRuntime 规划入口执行。"]
      });
    }

    const observations: Array<{ tool: string; result: unknown }> = [];
    const evidence: string[] = [];
    let responseContent = "";
    for (let step = 1; step <= this.maxSteps; step += 1) {
      const action = await this.nextAction(context.getState(), {
        task,
        routeDecision,
        availableTools: context.availableTools,
        observations
      });

      if (action.type === "respond") {
        responseContent = action.content;
        continue;
      }
      if (action.type === "finish") {
        if (!responseContent) {
          throw runtimeError("INVALID_CONTRACT", "Main Agent 必须先生成 respond action，才能结束任务。");
        }
        const latestState = context.getState();
        if (routeDecision.route === "main_loop" && !evidence.length) {
          throw runtimeError("INVALID_CONTRACT", "main_loop 尚未执行任何受控工具，不能结束任务。");
        }
        if (routeDecision.intent === "code_change" && !latestState.changedFiles.length) {
          throw runtimeError("INVALID_CONTRACT", "代码修改任务没有经过 Runtime 确认的变更文件，不能结束任务。");
        }
        return createResult(task.taskId, "success", responseContent, {
          facts: [`路由结果：${routeDecision.intent}/${routeDecision.complexity}/${routeDecision.route}`],
          changedFiles: [...latestState.changedFiles],
          evidence
        });
      }
      if (action.type === "delegate") {
        return createResult(task.taskId, "blocked", `任务需要委派给 ${action.agent}。`, {
          blockers: ["阶段 1 尚未接入子 Agent 调度。"]
        });
      }
      if (action.type === "replan") {
        return createResult(task.taskId, "blocked", "任务需要重新规划。", {
          blockers: [action.reason, "当前执行已安全停止，请由 MainAgentRuntime.replan 创建新版计划。"]
        });
      }
      if (routeDecision.route === "direct") {
        throw runtimeError("PERMISSION_DENIED", "direct 路由不能调用工具。", { toolName: action.tool });
      }

      const result = await context.callTool(action.tool, action.args as Record<string, unknown>);
      observations.push({ tool: action.tool, result: serializeObservation(result) });
      evidence.push(`tool:${action.tool}`);
    }

    throw runtimeError("AGENT_LOOP_LIMIT_EXCEEDED", `Main Agent 超过最大执行步数 ${this.maxSteps}。`, {
      maxSteps: this.maxSteps
    });
  }
}
