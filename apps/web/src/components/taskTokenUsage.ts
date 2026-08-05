import type { TaskSession } from "../api";

/** 将任务累计的模型用量整理为页面展示所需的稳定口径。 */
export function getTaskTokenUsageText(usage: TaskSession["modelUsage"]) {
  if (!usage) return null;

  // 缓存 Token 已包含在输入 Token 内，因此总计只计算输入与输出，避免重复统计。
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return {
    totalTokens,
    summary: `总计 ${totalTokens.toLocaleString()} tokens（输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()}）`,
    detail: `推理 ${usage.reasoningTokens.toLocaleString()} · 缓存输入 ${usage.cachedInputTokens.toLocaleString()}`
  };
}
