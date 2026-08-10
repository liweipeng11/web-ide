import type { Agent } from "./contracts.js";
import { runtimeError } from "./errors.js";

/** Agent Registry 只管理身份和能力，不负责选择或调度 Agent。 */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  constructor(agents: Agent[] = []) {
    for (const agent of agents) this.register(agent);
  }

  register(agent: Agent) {
    const id = agent.id.trim();
    if (!id) throw runtimeError("INVALID_CONTRACT", "Agent.id 不能为空。");
    if (this.agents.has(id)) throw runtimeError("DUPLICATE_AGENT", `Agent 已注册：${id}`, { agentId: id });
    if (typeof agent.run !== "function") {
      throw runtimeError("INVALID_CONTRACT", `Agent ${id} 缺少 run 方法。`, { agentId: id });
    }
    // 显式绑定方法，避免对象展开丢失 class Agent 定义在原型上的 run 实现。
    this.agents.set(id, {
      id,
      capabilities: [...new Set(agent.capabilities)],
      run: agent.run.bind(agent)
    });
  }

  get(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent) throw runtimeError("UNKNOWN_AGENT", `未知 Agent：${agentId}`, { agentId });
    return agent;
  }

  requireCapabilities(agentId: string, requiredCapabilities: string[]) {
    const agent = this.get(agentId);
    const available = new Set(agent.capabilities);
    const missingCapabilities = [...new Set(requiredCapabilities)].filter((capability) => !available.has(capability));
    if (missingCapabilities.length) {
      throw runtimeError("CAPABILITY_MISMATCH", `Agent ${agentId} 缺少任务所需能力。`, {
        agentId,
        missingCapabilities
      });
    }
    return agent;
  }
}
