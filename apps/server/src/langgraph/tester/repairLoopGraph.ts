import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { config } from "../../config.js";
import { runtimeError } from "../../runtime/errors.js";
import type { TesterGraphStateValue } from "./testerGraphState.js";

export type RepairLoopOutcome = "running" | "passed" | "blocked" | "incomplete" | "cancelled";

function appendHistory(current: string[], update: string[]) {
  return [...current, ...update].slice(-50);
}

const RepairLoopState = Annotation.Root({
  tester: Annotation<TesterGraphStateValue>,
  outcome: Annotation<RepairLoopOutcome>,
  developerAttempts: Annotation<number>,
  replanAttempts: Annotation<number>,
  verificationAttempts: Annotation<number>,
  history: Annotation<string[]>({ reducer: appendHistory, default: () => [] }),
  blocker: Annotation<string | null>
});

export type RepairLoopStateValue = typeof RepairLoopState.State;

export interface RepairLoopDependencies {
  verify: (state: Readonly<TesterGraphStateValue>) => Promise<Partial<TesterGraphStateValue>>;
  develop: (state: Readonly<RepairLoopStateValue>) => Promise<TesterGraphStateValue>;
  replan: (state: Readonly<RepairLoopStateValue>) => Promise<TesterGraphStateValue>;
}

export interface RepairLoopOptions {
  dependencies: RepairLoopDependencies;
  maxDeveloperAttempts?: number;
  maxReplans?: number;
  maxSteps?: number;
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw runtimeError("INVALID_CONTRACT", `${field} 必须是正整数。`, { [field]: value });
  }
  return value;
}

function assertPreparedTester(state: TesterGraphStateValue, source: "Developer" | "Planner") {
  if (state.status !== "plan_ready" || !state.verificationPlan) {
    throw runtimeError("INVALID_CONTRACT", `${source} 返回后必须重新通过 Tester 验证计划门禁。`, {
      status: state.status,
      hasVerificationPlan: Boolean(state.verificationPlan)
    });
  }
  if (state.failureClass !== "none" || state.validation !== null) {
    throw runtimeError("INVALID_CONTRACT", `${source} 不能复用旧验证终态或伪造验证结果。`, {
      failureClass: state.failureClass,
      hasValidation: Boolean(state.validation)
    });
  }
}

function routeAfterVerification(state: RepairLoopStateValue, maxDeveloperAttempts: number, maxReplans: number) {
  if (state.outcome !== "running") return "stop";
  if (state.tester.failureClass === "implementation") {
    return state.developerAttempts < maxDeveloperAttempts ? "develop" : "exhausted";
  }
  if (state.tester.failureClass === "plan") {
    return state.replanAttempts < maxReplans ? "replan" : "exhausted";
  }
  return "exhausted";
}

/**
 * Developer / Tester / Planner 的有界修复图。条件边只读取结构化失败分类，
 * 环境错误和用户取消不会进入代码修改节点。
 */
export function createRepairLoopGraph(options: RepairLoopOptions) {
  const maxDeveloperAttempts = positiveInteger(
    options.maxDeveloperAttempts ?? config.agentRuntimeStabilityPolicy.maxAttempts,
    "maxDeveloperAttempts"
  );
  const maxReplans = positiveInteger(
    options.maxReplans ?? config.agentRuntimeStabilityPolicy.maxReplans,
    "maxReplans"
  );
  const maxSteps = positiveInteger(
    options.maxSteps ?? config.agentRuntimeStabilityPolicy.maxOrchestrationSteps,
    "maxSteps"
  );

  const graph = new StateGraph(RepairLoopState)
    .addNode("verify", async (state) => {
      if (state.verificationAttempts >= maxSteps) {
        return { outcome: "incomplete" as const, blocker: `验证次数已达到上限 ${maxSteps}。`, history: ["verification_exhausted"] };
      }
      const update = await options.dependencies.verify(state.tester);
      const tester = { ...state.tester, ...update };
      const outcome: RepairLoopOutcome = tester.status === "passed"
        ? "passed"
        : tester.failureClass === "cancelled"
          ? "cancelled"
          : tester.failureClass === "environment"
            ? "blocked"
            : "running";
      return {
        tester,
        outcome,
        verificationAttempts: state.verificationAttempts + 1,
        blocker: outcome === "blocked" || outcome === "cancelled" ? tester.blockers.join("；") || null : null,
        history: [`verify:${tester.failureClass}:${tester.status}`]
      };
    })
    .addNode("develop", async (state) => {
      const tester = await options.dependencies.develop(state);
      assertPreparedTester(tester, "Developer");
      return {
        tester,
        developerAttempts: state.developerAttempts + 1,
        history: [`develop:${state.developerAttempts + 1}`]
      };
    })
    .addNode("replan", async (state) => {
      const tester = await options.dependencies.replan(state);
      assertPreparedTester(tester, "Planner");
      return {
        tester,
        replanAttempts: state.replanAttempts + 1,
        history: [`replan:${state.replanAttempts + 1}`]
      };
    })
    .addNode("mark_exhausted", async (state) => ({
      outcome: "incomplete" as const,
      blocker: state.tester.failureClass === "implementation"
        ? `Developer 修复次数已达到上限 ${maxDeveloperAttempts}。`
        : `重规划次数已达到上限 ${maxReplans}。`,
      history: ["loop_exhausted"]
    }))
    .addEdge(START, "verify")
    .addConditionalEdges("verify", (state) => routeAfterVerification(state, maxDeveloperAttempts, maxReplans), {
      develop: "develop",
      replan: "replan",
      exhausted: "mark_exhausted",
      stop: END
    })
    .addEdge("develop", "verify")
    .addEdge("replan", "verify")
    .addEdge("mark_exhausted", END)
    .compile();

  return {
    graph,
    maxSteps,
    async invoke(tester: TesterGraphStateValue): Promise<RepairLoopStateValue> {
      assertPreparedTester(tester, "Planner");
      return graph.invoke({
        tester,
        outcome: "running",
        developerAttempts: 0,
        replanAttempts: 0,
        verificationAttempts: 0,
        history: [],
        blocker: null
      }, { recursionLimit: Math.max(10, maxSteps * 3 + 5) }) as Promise<RepairLoopStateValue>;
    }
  };
}
