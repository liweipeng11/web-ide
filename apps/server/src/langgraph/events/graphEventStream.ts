import type { AgentStep } from "../../types.js";
import { graphEventToAgentStep, type GraphLifecycleEvent } from "./agentStepAdapter.js";

export type GraphLifecycleEventInput = Omit<GraphLifecycleEvent, "runId" | "sequence">;

/**
 * 为单次 Graph 运行生成稳定序号，并复用现有 AgentStep 协议实时推送事件。
 * 观测回调失败只进入 onError，不得改变 Graph 业务结果或触发副作用重跑。
 */
export function createGraphAgentStepEmitter(options: {
  runId: string;
  seenStepIds?: Iterable<string>;
  onStep?: (step: AgentStep) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}) {
  const seen = new Set(options.seenStepIds ?? []);
  let sequence = 0;
  return {
    async emit(event: GraphLifecycleEventInput): Promise<AgentStep | null> {
      sequence += 1;
      const step = graphEventToAgentStep({ ...event, runId: options.runId, sequence });
      if (seen.has(step.id)) return null;
      seen.add(step.id);
      try {
        await options.onStep?.(step);
      } catch (error) {
        try {
          await options.onError?.(error);
        } catch {
          // 错误观测仍属于非关键路径，不能反向改变 Graph 结果。
        }
      }
      return step;
    }
  };
}

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
