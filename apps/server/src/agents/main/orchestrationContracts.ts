import type { AcceptanceEvidenceInput } from "../tester/contracts.js";
import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import type { DeveloperExecution } from "../developer/developerAgentRuntime.js";
import type { TesterExecution } from "../tester/testerAgentRuntime.js";
import type { AgentResult, Plan, RouteDecision, Task } from "../../runtime/contracts.js";
import type { MainAgentRequest, MainAgentRuntimeResult } from "./mainAgentRuntime.js";

export type OrchestrationAgentId = "main" | "planner" | "explorer" | "developer" | "tester";

export interface OrchestrationTraceEvent {
  agent: OrchestrationAgentId;
  action: "route" | "plan" | "replan" | "execute" | "finish" | "stop";
  taskId?: string;
  status?: AgentResult["status"] | "ready" | "missing_context";
  reason?: string;
}

export interface OrchestrationTrace {
  /** 按首次调用顺序去重，便于 E2E 稳定断言实际参与的 Agent。 */
  calledAgents: OrchestrationAgentId[];
  events: OrchestrationTraceEvent[];
}

export interface MainOrchestrationRequest extends MainAgentRequest {
  testScope?: string[];
  acceptanceEvidence?: AcceptanceEvidenceInput[];
}

export type PreparedOrchestration =
  | {
      status: "direct";
      decision: RouteDecision;
      trace: OrchestrationTrace;
    }
  | {
      status: "ready";
      decision: RouteDecision;
      plan: Plan;
      explorations: ExplorerExecution[];
      trace: OrchestrationTrace;
    }
  | {
      status: "blocked";
      decision: RouteDecision;
      reason: string;
      trace: OrchestrationTrace;
    };

export interface ExecuteOrchestrationPlanOptions {
  constraints?: string[];
  testScope?: string[];
  acceptanceEvidence?: AcceptanceEvidenceInput[];
  initialChangedFiles?: string[];
  initialFailureCounts?: Record<string, number>;
  context?: unknown;
  trace?: OrchestrationTrace;
  authorizedScope?: { readScope: string[]; writeScope: string[] };
  resolveTestContext?: (
    task: Task,
    changedFiles: string[]
  ) => Promise<{ testScope: string[]; acceptanceEvidence: AcceptanceEvidenceInput[] }>;
  onExecution?: (execution: OrchestrationExecution) => Promise<void> | void;
  onPlanUpdate?: (plan: Plan, reason: "scope_expansion" | "retry" | "replan") => Promise<void> | void;
  onReplanExplorations?: (plan: Plan, explorations: ExplorerExecution[]) => Promise<void> | void;
}

export type OrchestrationExecution =
  | { agent: "explorer"; execution: ExplorerExecution }
  | { agent: "developer"; execution: DeveloperExecution }
  | { agent: "tester"; execution: TesterExecution };

export type MainOrchestrationResult = {
  status: "completed" | "failed" | "blocked";
  decision: RouteDecision;
  plan?: Plan;
  summary: string;
  changedFiles: string[];
  results: AgentResult[];
  executions: OrchestrationExecution[];
  directExecution?: MainAgentRuntimeResult;
  trace: OrchestrationTrace;
};
