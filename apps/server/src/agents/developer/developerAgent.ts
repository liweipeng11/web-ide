import type {
  Agent,
  AgentContext,
  AgentTaskPacket,
  RuntimeToolDescriptor
} from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { isPathInScope } from "../../runtime/permissionManager.js";
import type {
  DeveloperAction,
  DeveloperAgentResult,
  DeveloperCompletion,
  DeveloperPatchResult
} from "./contracts.js";
import type { DeveloperAgentDecisionModel } from "./developerAgentModel.js";
import { ProviderDeveloperAgentDecisionModel } from "./developerAgentModel.js";
import { DEVELOPER_TOOL_NAMES } from "./developerTools.js";
import { buildDeveloperPrompt, type DeveloperPromptObservation } from "./prompt.js";

export const MAX_DEVELOPER_STEPS = 30;
const MAX_OBSERVATION_CHARS = 20_000;
const ALLOWED_TOOLS = new Set<string>(DEVELOPER_TOOL_NAMES);

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

function parseCompletion(value: unknown): DeveloperCompletion {
  if (!isRecord(value)) throw runtimeError("INVALID_CONTRACT", "Developer completion 格式无效。");
  return {
    summary: requiredString(value.summary, "Developer completion.summary"),
    facts: stringArray(value.facts, "Developer completion.facts"),
    evidence: stringArray(value.evidence, "Developer completion.evidence")
  };
}

function parseAction(value: unknown, availableTools: RuntimeToolDescriptor[]): DeveloperAction {
  if (!isRecord(value)) throw runtimeError("INVALID_CONTRACT", "Developer action 格式无效。");
  if (value.type === "finish") return { type: "finish", result: parseCompletion(value.result) };
  if (value.type === "request_scope_change") {
    const requiredScope = stringArray(value.requiredScope, "Developer action.requiredScope", 20);
    if (!requiredScope.length) throw runtimeError("INVALID_CONTRACT", "Developer 范围申请至少需要一个路径。");
    if (requiredScope.some((filePath) => !isPathInScope(filePath, ["**"]))) {
      throw runtimeError("SCOPE_VIOLATION", "Developer 范围申请只能包含工作区相对路径。", { requiredScope });
    }
    return {
      type: "request_scope_change",
      reason: requiredString(value.reason, "Developer action.reason", 1_000),
      requiredScope
    };
  }
  if (value.type !== "tool") {
    throw runtimeError("INVALID_CONTRACT", `Developer action.type 无效：${String(value.type)}`);
  }
  const tool = requiredString(value.tool, "Developer action.tool", 80);
  const availableNames = new Set(availableTools.map((item) => item.name));
  if (!ALLOWED_TOOLS.has(tool) || !availableNames.has(tool)) {
    throw runtimeError("PERMISSION_DENIED", `Developer 无权调用工具 ${tool}。`, { toolName: tool });
  }
  if (!isRecord(value.args)) throw runtimeError("INVALID_CONTRACT", "Developer action.args 必须是对象。");
  return { type: "tool", tool, args: value.args };
}

function compactObservation(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= MAX_OBSERVATION_CHARS) return value;
  return { truncated: true, preview: serialized.slice(0, MAX_OBSERVATION_CHARS) };
}

function normalizedFilePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function parsePatchResult(value: unknown): DeveloperPatchResult {
  if (!isRecord(value)
    || typeof value.filePath !== "string"
    || (value.operation !== "replace" && value.operation !== "create")
    || typeof value.changed !== "boolean") {
    throw runtimeError("INVALID_CONTRACT", "apply_patch 必须返回合法的变更结果。");
  }
  return {
    filePath: value.filePath,
    operation: value.operation,
    changed: value.changed,
    ...(typeof value.replacements === "number" ? { replacements: value.replacements } : {}),
    ...(typeof value.checkpointId === "string" ? { checkpointId: value.checkpointId } : {})
  };
}

function parseLocalCheckResult(value: unknown) {
  if (!isRecord(value)
    || typeof value.command !== "string"
    || (value.status !== "success" && value.status !== "failed" && value.status !== "timeout" && value.status !== "cancelled")) {
    throw runtimeError("INVALID_CONTRACT", "run_local_check 必须返回合法的命令结果。");
  }
  return { command: value.command.trim(), status: value.status };
}

/** Developer 只执行当前实现任务，Plan 和访问范围始终由 Main 与 Runtime 持有。 */
export class DeveloperAgent implements Agent {
  readonly id = "developer";
  readonly capabilities = ["editing"];

  constructor(
    private readonly model: DeveloperAgentDecisionModel = new ProviderDeveloperAgentDecisionModel(),
    private readonly maxSteps = MAX_DEVELOPER_STEPS
  ) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw runtimeError("INVALID_CONTRACT", "Developer 的步骤预算必须是正整数。");
    }
  }

  async run(task: AgentTaskPacket, context: AgentContext): Promise<DeveloperAgentResult> {
    if (!task.writeScope.length) {
      throw runtimeError("INVALID_CONTRACT", "Developer Task 必须声明非空 writeScope。");
    }
    const observations: DeveloperPromptObservation[] = [];
    const changedFiles = new Set<string>();
    const checkpointIds = new Set<string>();
    const filesRead = new Set<string>();
    const localCheckStatuses = new Map<string, string>();

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const action = parseAction(
        await this.model.nextAction(buildDeveloperPrompt(task, context.availableTools, observations)),
        context.availableTools
      );
      if (action.type === "request_scope_change") {
        return {
          taskId: task.taskId,
          status: "blocked",
          summary: `实现需要扩展写入范围：${action.reason}`,
          facts: [],
          changedFiles: [...changedFiles],
          evidence: [],
          blockers: [action.reason],
          scopeChangeRequest: {
            reason: action.reason,
            requiredScope: action.requiredScope
          },
          checkpointIds: [...checkpointIds]
        };
      }
      if (action.type === "finish") {
        if (!changedFiles.size) {
          throw runtimeError("INVALID_CONTRACT", "Developer 没有产生 Runtime 确认的文件变更，不能报告成功。");
        }
        const failedChecks = [...localCheckStatuses.entries()]
          .filter(([, status]) => status !== "success")
          .map(([command]) => command);
        if (failedChecks.length) {
          throw runtimeError("INVALID_CONTRACT", "Developer 存在尚未通过的局部检查，不能报告成功。", { failedChecks });
        }
        return {
          taskId: task.taskId,
          status: "success",
          summary: action.result.summary,
          facts: action.result.facts,
          changedFiles: [...changedFiles],
          evidence: action.result.evidence,
          blockers: [],
          implementation: action.result,
          checkpointIds: [...checkpointIds]
        };
      }

      if (action.tool === "apply_patch" && action.args.operation === "replace") {
        const filePath = normalizedFilePath(requiredString(action.args.filePath, "apply_patch.filePath"));
        if (!filesRead.has(filePath)) {
          throw runtimeError("INVALID_CONTRACT", `Developer 修改已有文件前必须先读取该文件：${filePath}`);
        }
      }
      const result = await context.callTool(action.tool, action.args);
      if (action.tool === "read_file") {
        filesRead.add(normalizedFilePath(requiredString(action.args.filePath, "read_file.filePath")));
      }
      if (action.tool === "apply_patch") {
        const patch = parsePatchResult(result);
        if (patch.changed) changedFiles.add(patch.filePath);
        if (patch.checkpointId) checkpointIds.add(patch.checkpointId);
      }
      if (action.tool === "run_local_check") {
        const check = parseLocalCheckResult(result);
        localCheckStatuses.set(check.command, check.status);
      }
      observations.push({ tool: action.tool, result: compactObservation(result) });
    }

    throw runtimeError("AGENT_LOOP_LIMIT_EXCEEDED", `Developer 超过最大执行步数 ${this.maxSteps}。`, {
      maxSteps: this.maxSteps
    });
  }
}
