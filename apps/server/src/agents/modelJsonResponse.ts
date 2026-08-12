export type JsonResponseSource = "content" | "reasoning_content";

export type ParsedJsonModelResponse = {
  value: unknown;
  source: JsonResponseSource;
};

function normalizeJsonText(value: string) {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const firstObject = trimmed.indexOf("{");
  const firstArray = trimmed.indexOf("[");
  const start = [firstObject, firstArray].filter((index) => index >= 0).sort((left, right) => left - right)[0];
  return start === undefined ? trimmed : trimmed.slice(start);
}

function parseCandidate(value: string) {
  const normalized = normalizeJsonText(value);
  return JSON.parse(normalized) as unknown;
}

/**
 * 兼容少数 Provider 将 response_format 的 JSON 错置到 reasoning_content 的情况。
 * content 始终优先，避免把普通推理文本误当作最终响应。
 */
export function parseJsonModelResponse(input: {
  agentName: string;
  content: string | null | undefined;
  reasoningContent: string | null | undefined;
}): ParsedJsonModelResponse {
  if (input.content?.trim()) {
    try {
      return { value: parseCandidate(input.content), source: "content" };
    } catch {
      throw new Error(`${input.agentName} Agent 响应协议错误：content 不是有效 JSON。`);
    }
  }

  if (input.reasoningContent?.trim()) {
    try {
      return { value: parseCandidate(input.reasoningContent), source: "reasoning_content" };
    } catch {
      throw new Error(`${input.agentName} Agent 响应协议错误：content 为空，reasoning_content 中未找到有效 JSON。`);
    }
  }

  throw new Error(`${input.agentName} Agent 响应协议错误：content 和 reasoning_content 均为空。`);
}
