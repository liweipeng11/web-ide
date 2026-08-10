import type { RuntimeTool } from "./contracts.js";
import { runtimeError } from "./errors.js";

/** 工具注册中心保存 Runtime 可执行的真实工具，模型或 Agent 不能临时注入执行器。 */
export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  constructor(tools: RuntimeTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: RuntimeTool) {
    const name = tool.name.trim();
    if (!name) throw runtimeError("INVALID_CONTRACT", "RuntimeTool.name 不能为空。");
    if (this.tools.has(name)) throw runtimeError("DUPLICATE_TOOL", `工具已注册：${name}`, { toolName: name });
    this.tools.set(name, { ...tool, name });
  }

  get(toolName: string) {
    const tool = this.tools.get(toolName);
    if (!tool) throw runtimeError("UNKNOWN_TOOL", `未知工具：${toolName}`, { toolName });
    return tool;
  }

  /** 只暴露任务声明允许且已经注册的工具描述，不向 Agent 暴露执行函数。 */
  describeAvailable(toolNames: string[]) {
    return [...new Set(toolNames)].flatMap((toolName) => {
      const tool = this.tools.get(toolName);
      return tool ? [{
        name: tool.name,
        description: tool.description,
        effect: tool.effect,
        inputSchema: tool.inputSchema
      }] : [];
    });
  }
}
