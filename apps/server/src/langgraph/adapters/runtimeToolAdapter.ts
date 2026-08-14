import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import type { RuntimeToolDescriptor } from "../../runtime/contracts.js";

type ToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * 将 Runtime 工具暴露为 LangChain Tool，但真实执行必须回到 RuntimeContext.callTool。
 * 因此模型无法绕过 Registry、PermissionManager、写入范围或副作用重试策略。
 */
export function adaptRuntimeToolsForLangChain(
  descriptors: readonly RuntimeToolDescriptor[],
  callTool: ToolCaller
): DynamicStructuredTool[] {
  return descriptors.map((descriptor) => tool(
    async (args) => callTool(descriptor.name, args as Record<string, unknown>),
    {
      name: descriptor.name,
      description: descriptor.description,
      schema: descriptor.inputSchema as Parameters<typeof tool>[1]["schema"]
    }
  ) as DynamicStructuredTool);
}
