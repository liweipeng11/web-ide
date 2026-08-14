import type { DynamicStructuredTool } from "@langchain/core/tools";
import { adaptRuntimeToolsForLangChain } from "../../langgraph/adapters/runtimeToolAdapter.js";
import type { RuntimeToolDescriptor } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";

const FORBIDDEN_SIDE_EFFECT_TOOLS = new Set([
  "writeFile",
  "replaceInFile",
  "proposePatch",
  "applyPatch",
  "deleteFile",
  "runCommand"
]);

export type ReadOnlyToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export type ReadOnlyToolRegistry = {
  descriptors: readonly RuntimeToolDescriptor[];
  tools: readonly DynamicStructuredTool[];
  has: (toolName: string) => boolean;
  call: ReadOnlyToolCaller;
};

/**
 * 只从服务端 Runtime 描述符构造模型可见工具，并在调用时再次校验白名单。
 * 即使模型伪造未暴露的写工具名，也无法越过这里调用真实 Runtime。
 */
export function createReadOnlyToolRegistry(
  descriptors: readonly RuntimeToolDescriptor[],
  callRuntimeTool: ReadOnlyToolCaller
): ReadOnlyToolRegistry {
  const allowed = new Map<string, RuntimeToolDescriptor>();
  const registeredNames = new Set<string>();
  for (const descriptor of descriptors) {
    const name = descriptor.name.trim();
    if (!name) throw runtimeError("INVALID_CONTRACT", "只读工具名称不能为空。");
    if (registeredNames.has(name)) throw runtimeError("DUPLICATE_TOOL", `只读工具重复：${name}`, { toolName: name });
    registeredNames.add(name);
    if (!isReadOnlyDescriptor(descriptor)) continue;
    allowed.set(name, { ...descriptor, name });
  }

  const safeCall: ReadOnlyToolCaller = async (toolName, args) => {
    if (!allowed.has(toolName)) {
      throw runtimeError("PERMISSION_DENIED", `只读 Agent 无权调用工具 ${toolName}。`, { toolName });
    }
    return callRuntimeTool(toolName, args);
  };
  const safeDescriptors = [...allowed.values()];

  return {
    descriptors: safeDescriptors,
    tools: adaptRuntimeToolsForLangChain(safeDescriptors, safeCall),
    has: (toolName) => allowed.has(toolName),
    call: safeCall
  };
}

function isReadOnlyDescriptor(descriptor: RuntimeToolDescriptor): boolean {
  // 显式名称黑名单防止工具 effect 被错误标注时提前暴露高风险能力。
  if (FORBIDDEN_SIDE_EFFECT_TOOLS.has(descriptor.name)) return false;
  return descriptor.effect === "read" || descriptor.effect === "none";
}
