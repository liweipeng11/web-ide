import type { TaskWorkflowSnapshot, TaskWorkflowStep, TaskWorkflowType } from "./types.js";
import { resolveTaskWorkflowDecisionPolicy } from "./decisionPolicy.js";

const workflowDefinitions: Record<TaskWorkflowType, TaskWorkflowStep[]> = {
  bugfix: [
    { id: "collect-symptoms", title: "收集问题现象", description: "确认错误表现、触发条件和预期行为。" },
    { id: "reproduce", title: "尝试复现问题", description: "使用最小场景或现有测试稳定复现问题。" },
    { id: "locate-root-cause", title: "定位问题根因", description: "结合代码与运行证据确认根因，而不是只处理表象。" },
    { id: "minimal-fix", title: "实施最小修复", description: "限定修改范围，避免夹带无关重构。" },
    { id: "add-regression-test", title: "补充回归测试", description: "覆盖问题场景与关键边界条件。" },
    { id: "regression-validation", title: "执行回归验证", description: "运行相关测试和必要的类型、构建检查。" }
  ],
  feature: [
    { id: "analyze-project", title: "分析项目与需求", description: "确认技术栈、现有结构、需求边界和输入输出。" },
    { id: "find-patterns", title: "查找相似实现", description: "优先复用项目中的组件、服务、类型和测试模式。" },
    { id: "plan-files", title: "确认文件实现计划", description: "按职责列出新增或修改文件及验证范围。" },
    { id: "implement", title: "实现聚焦变更", description: "按文件计划完成最小且完整的功能实现。" },
    { id: "validate", title: "验证功能实现", description: "运行相关测试、类型检查或构建命令。" },
    { id: "summarize", title: "输出变更说明", description: "说明修改内容、验证结果和必要注意事项。" }
  ],
  refactor: [
    { id: "baseline", title: "确认现有行为基线", description: "读取实现与测试，明确重构前必须保持的行为。" },
    { id: "impact", title: "分析影响范围", description: "检查调用方、公共类型、接口和关联测试。" },
    { id: "scope", title: "限定重构边界", description: "列出允许修改的文件和保持不变的外部契约。" },
    { id: "refactor", title: "执行结构重构", description: "改善内部结构，同时避免引入功能变化。" },
    { id: "tests", title: "调整或补充测试", description: "用测试固定对外行为和关键边界。" },
    { id: "regression", title: "验证行为未改变", description: "运行受影响范围内的回归、类型和构建检查。" }
  ],
  "analysis-only": [
    { id: "clarify", title: "明确分析问题", description: "确认分析目标、范围和期望产出。" },
    { id: "collect-evidence", title: "收集相关证据", description: "只读检索代码、配置、日志或测试结果。" },
    { id: "analyze", title: "分析原因与影响", description: "基于证据形成结论，并标注不确定项。" },
    { id: "report", title: "输出结论与建议", description: "汇总发现、风险和可选后续动作，不修改文件。" }
  ]
};

// 返回副本，防止调用方意外修改全局工作流模板。
export function getTaskWorkflowSteps(type: TaskWorkflowType): TaskWorkflowStep[] {
  return workflowDefinitions[type].map((step) => ({ ...step }));
}

// Runtime 使用同一份工作流快照生成约束，避免计划面板和实际执行策略发生漂移。
export function buildTaskWorkflowRuntimePrompt(workflow: TaskWorkflowSnapshot): string {
  const policy = resolveTaskWorkflowDecisionPolicy(workflow);
  const phases = workflow.steps.map((step, index) => `${index + 1}. ${step.title}: ${step.description}`).join("\n");
  const rules = policy.runtimeRules.map((rule) => `- ${rule}`).join("\n");
  const requiredEvidence = policy.requiredBeforeEdit.length ? policy.requiredBeforeEdit.join(", ") : "none";

  return `Task workflow: ${workflow.type}
Selection source: ${workflow.source}; confidence: ${workflow.confidence.toFixed(2)}
Reason: ${workflow.reason}
Authorization boundary: workspace mutation=${policy.mutationAllowed}; command execution=${policy.commandAllowed}
Required evidence before editing: ${requiredEvidence}
Required phases (follow in order):
${phases}
Workflow enforcement rules:
${rules}`;
}
