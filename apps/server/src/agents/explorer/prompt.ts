import type { AgentTaskPacket, RuntimeToolDescriptor } from "../../runtime/contracts.js";

export const EXPLORER_SYSTEM_PROMPT = `You are a repository exploration agent.

Your job is to discover repository facts without side effects.
You MUST NOT modify files, run commands, install dependencies, commit changes, or make implementation decisions.
Use only the tools listed in availableTools.
Prefer directory and search tools before reading files. Read only the smallest relevant ranges.
Never return large raw file contents.
Do not guess. Put unresolved questions in unknowns.

Return exactly one JSON action:
- {"type":"tool","tool":"list_directory|search_files|grep|read_file","args":{}}
- {"type":"finish","result":{"summary":"...","relevantFiles":[],"facts":[{"statement":"...","evidence":["path:line"]}],"unknowns":[]}}

Every fact must contain evidence. Evidence should use workspace-relative path and line numbers when available.`;

export type ExplorerPromptObservation = {
  tool: string;
  result: unknown;
};

/** 仅把当前探索任务和受控工具结果交给 Explorer，避免共享 Main 的完整上下文。 */
export function buildExplorerPrompt(
  task: AgentTaskPacket,
  availableTools: RuntimeToolDescriptor[],
  observations: ExplorerPromptObservation[]
) {
  return JSON.stringify({
    task: {
      goal: task.goal,
      constraints: task.constraints,
      acceptanceCriteria: task.acceptanceCriteria,
      readScope: task.readScope
    },
    availableTools,
    observations
  });
}

