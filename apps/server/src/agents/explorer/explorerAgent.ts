import type {
  Agent,
  AgentContext,
  AgentTaskPacket,
  RuntimeToolDescriptor
} from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { recoverableToolObservation } from "../toolRecovery.js";
import type { ExplorerAction, ExplorerAgentResult, ExplorerFact, ExplorerResult } from "./contracts.js";
import type { ExplorerAgentDecisionModel } from "./explorerAgentModel.js";
import { ProviderExplorerAgentDecisionModel } from "./explorerAgentModel.js";
import { EXPLORER_TOOL_NAMES } from "./explorerTools.js";
import { buildExplorerPrompt, type ExplorerPromptObservation } from "./prompt.js";

export const MAX_EXPLORER_STEPS = 30;
export const MAX_EXPLORER_READ_FILES = 30;
const MAX_OBSERVATION_CHARS = 20_000;
const ALLOWED_TOOLS = new Set<string>(EXPLORER_TOOL_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: unknown, field: string, maxLength = 4_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw runtimeError("INVALID_CONTRACT", `${field} 不能为空。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw runtimeError("INVALID_CONTRACT", `${field} 超过长度上限。`);
  return normalized;
}

function stringArray(value: unknown, field: string, maxItems = 100) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw runtimeError("INVALID_CONTRACT", `${field} 必须是字符串数组。`);
  }
  const normalized = [...new Set(value.map((item) => (item as string).trim()))];
  if (normalized.length > maxItems) throw runtimeError("INVALID_CONTRACT", `${field} 超过数量上限。`);
  return normalized;
}

function parseFact(value: unknown, index: number): ExplorerFact {
  if (!isRecord(value)) throw runtimeError("INVALID_CONTRACT", `facts[${index}] 格式无效。`);
  const evidence = stringArray(value.evidence, `facts[${index}].evidence`, 20);
  if (!evidence.length) {
    throw runtimeError("INVALID_CONTRACT", `facts[${index}] 必须包含至少一项证据。`);
  }
  return {
    statement: requiredString(value.statement, `facts[${index}].statement`, 1_000),
    evidence
  };
}

function parseExplorerResult(value: unknown): ExplorerResult {
  if (!isRecord(value)) throw runtimeError("INVALID_CONTRACT", "ExplorerResult 格式无效。");
  if (!Array.isArray(value.facts)) throw runtimeError("INVALID_CONTRACT", "ExplorerResult.facts 必须是数组。");
  return {
    summary: requiredString(value.summary, "ExplorerResult.summary"),
    relevantFiles: stringArray(value.relevantFiles, "ExplorerResult.relevantFiles"),
    facts: value.facts.map(parseFact),
    unknowns: stringArray(value.unknowns, "ExplorerResult.unknowns")
  };
}

function parseAction(value: unknown, availableTools: RuntimeToolDescriptor[]): ExplorerAction {
  if (!isRecord(value)) throw runtimeError("INVALID_CONTRACT", "Explorer action 格式无效。");
  if (value.type === "finish") return { type: "finish", result: parseExplorerResult(value.result) };
  if (value.type !== "tool") throw runtimeError("INVALID_CONTRACT", `Explorer action.type 无效：${String(value.type)}`);
  const tool = requiredString(value.tool, "Explorer action.tool", 80);
  const availableNames = new Set(availableTools.map((item) => item.name));
  if (!ALLOWED_TOOLS.has(tool) || !availableNames.has(tool)) {
    throw runtimeError("PERMISSION_DENIED", `Explorer 无权调用工具 ${tool}。`, { toolName: tool });
  }
  if (!isRecord(value.args)) throw runtimeError("INVALID_CONTRACT", "Explorer action.args 必须是对象。");
  return { type: "tool", tool, args: value.args };
}

function compactObservation(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= MAX_OBSERVATION_CHARS) return value;
  return { truncated: true, preview: serialized.slice(0, MAX_OBSERVATION_CHARS) };
}

/** Explorer 仅负责发现仓库事实，所有真实读取仍通过 Runtime 权限边界执行。 */
export class ExplorerAgent implements Agent {
  readonly id = "explorer";
  readonly capabilities = ["exploration"];

  constructor(
    private readonly model: ExplorerAgentDecisionModel = new ProviderExplorerAgentDecisionModel(),
    private readonly maxSteps = MAX_EXPLORER_STEPS,
    private readonly maxReadFiles = MAX_EXPLORER_READ_FILES
  ) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || !Number.isInteger(maxReadFiles) || maxReadFiles < 1) {
      throw runtimeError("INVALID_CONTRACT", "Explorer 的步骤和文件预算必须是正整数。");
    }
  }

  async run(task: AgentTaskPacket, context: AgentContext): Promise<ExplorerAgentResult> {
    if (task.writeScope.length) {
      throw runtimeError("PERMISSION_DENIED", "Explorer Task 的 writeScope 必须为空。");
    }
    const observations: ExplorerPromptObservation[] = [];
    const filesRead = new Set<string>();

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const action = parseAction(
        await this.model.nextAction(buildExplorerPrompt(task, context.availableTools, observations)),
        context.availableTools
      );
      if (action.type === "finish") {
        return {
          taskId: task.taskId,
          status: "success",
          summary: action.result.summary,
          facts: action.result.facts.map((fact) => fact.statement),
          changedFiles: [],
          evidence: [...new Set(action.result.facts.flatMap((fact) => fact.evidence))],
          blockers: [],
          exploration: action.result
        };
      }

      if (action.tool === "read_file") {
        const filePath = requiredString(action.args.filePath, "read_file.filePath");
        filesRead.add(filePath);
        if (filesRead.size > this.maxReadFiles) {
          throw runtimeError("AGENT_LOOP_LIMIT_EXCEEDED", `Explorer 超过最多读取 ${this.maxReadFiles} 个文件的限制。`, {
            maxReadFiles: this.maxReadFiles
          });
        }
      }
      try {
        const result = await context.callTool(action.tool, action.args);
        observations.push({ tool: action.tool, result: compactObservation(result) });
      } catch (error) {
        const recovery = recoverableToolObservation(error);
        if (!recovery) throw error;
        // 将局部查找失败作为观察返回模型，使 Explorer 可以改用 search_files 或 grep。
        observations.push({ tool: action.tool, result: recovery });
      }
    }

    throw runtimeError("AGENT_LOOP_LIMIT_EXCEEDED", `Explorer 超过最大执行步数 ${this.maxSteps}。`, {
      maxSteps: this.maxSteps
    });
  }
}
