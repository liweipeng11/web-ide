import type { AgentStep } from "../../types.js";
import { graphEventToAgentStep, type GraphLifecycleEvent } from "./agentStepAdapter.js";

/**
 * 将 Graph 事件流增量转换为现有步骤流，并按稳定 step ID 抑制恢复或重放造成的重复事件。
 * 调用方可把 onStep 连接到现有 appendTaskSessionStep 与 SSE 推送，不需要修改前端契约。
 */
export async function* streamGraphAgentSteps(
  events: AsyncIterable<GraphLifecycleEvent>,
  options: { seenStepIds?: Iterable<string>; onStep?: (step: AgentStep) => Promise<void> | void } = {}
): AsyncGenerator<AgentStep> {
  const seen = new Set(options.seenStepIds ?? []);
  for await (const event of events) {
    const step = graphEventToAgentStep(event);
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    await options.onStep?.(step);
    yield step;
  }
}

