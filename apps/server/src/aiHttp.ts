import { config } from "./config.js";
import { HttpError } from "./errors.js";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
};

const AI_LOG_PREVIEW_CHARS = 500;
const AI_FETCH_ATTEMPTS_PER_URL = 2;

function getChatCompletionUrls() {
  const normalizedBaseUrl = config.aiBaseUrl.replace(/\/$/, "");
  const urls = [`${normalizedBaseUrl}/chat/completions`];

  try {
    const parsed = new URL(normalizedBaseUrl);

    if (parsed.pathname === "" || parsed.pathname === "/") {
      urls.push(`${normalizedBaseUrl}/v1/chat/completions`);
    }
  } catch {
    // Let fetch surface the invalid URL error with a useful message.
  }

  return urls;
}

export function createAiRunId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function previewForLog(value: unknown, maxLength = AI_LOG_PREVIEW_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength} chars>` : text;
}

export function logAi(runId: string, event: string, detail?: unknown) {
  const suffix = detail === undefined ? "" : ` ${previewForLog(detail)}`;
  console.log(`[ai:${runId}] ${event}${suffix}`);
}

function formatFetchError(error: unknown) {
  if (!(error instanceof Error)) {
    return "AI request failed";
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return [error.message, cause.message, code ? `code=${code}` : ""].filter(Boolean).join("; ");
  }

  if (cause && typeof cause === "object") {
    const detail = cause as { message?: unknown; code?: unknown; errno?: unknown; syscall?: unknown; address?: unknown; port?: unknown };
    return [
      error.message,
      typeof detail.message === "string" ? detail.message : "",
      typeof detail.code === "string" ? `code=${detail.code}` : "",
      typeof detail.errno === "string" || typeof detail.errno === "number" ? `errno=${detail.errno}` : "",
      typeof detail.syscall === "string" ? `syscall=${detail.syscall}` : "",
      typeof detail.address === "string" ? `address=${detail.address}` : "",
      typeof detail.port === "number" ? `port=${detail.port}` : ""
    ]
      .filter(Boolean)
      .join("; ");
  }

  return error.message;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProviderCompatibilityError(error: unknown) {
  if (!(error instanceof HttpError)) {
    return false;
  }

  if (![400, 422, 500].includes(error.status)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.status === 400 ||
    error.status === 422 ||
    message.includes("string indices must be integers") ||
    message.includes("sglang") ||
    message.includes("tool_choice") ||
    message.includes("response_format")
  );
}

export async function requestChatCompletion(body: unknown) {
  let lastErrorText = "";

  for (const url of getChatCompletionUrls()) {
    let response: Response | null = null;

    for (let attempt = 1; attempt <= AI_FETCH_ATTEMPTS_PER_URL; attempt += 1) {
      try {
        logAi("http", "request", { url, attempt, model: typeof body === "object" && body && "model" in body ? (body as { model?: unknown }).model : undefined });
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.aiApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        break;
      } catch (error) {
        const message = formatFetchError(error);
        lastErrorText = message;
        logAi("http", "fetch.error", { url, attempt, error: message });

        if (attempt < AI_FETCH_ATTEMPTS_PER_URL) {
          await delay(400 * attempt);
          continue;
        }

        throw new HttpError(502, `AI request failed: ${message}`);
      }
    }

    if (!response) {
      continue;
    }

    if (response.ok) {
      return (await response.json()) as ChatCompletionResponse;
    }

    lastErrorText = await response.text();

    if (response.status !== 404 && response.status !== 405) {
      throw new HttpError(response.status, lastErrorText || `AI request failed with status ${response.status}`);
    }
  }

  throw new HttpError(502, lastErrorText || "AI request failed");
}

export async function requestJsonChatCompletion(body: Record<string, unknown>) {
  try {
    return await requestChatCompletion({
      ...body,
      response_format: { type: "json_object" }
    });
  } catch (error) {
    if (isProviderCompatibilityError(error)) {
      return requestChatCompletion(body);
    }

    throw error;
  }
}

function omitRequestField(body: Record<string, unknown>, field: string) {
  const nextBody = { ...body };
  delete nextBody[field];
  return nextBody;
}

export async function requestJsonChatCompletionWithToolChoiceFallback(body: Record<string, unknown>, fallbackBody: Record<string, unknown>, runId: string) {
  try {
    return await requestJsonChatCompletion(body);
  } catch (error) {
    if (isProviderCompatibilityError(error)) {
      logAi(runId, "completion.toolChoiceFallback", {
        status: error instanceof HttpError ? error.status : undefined,
        error: error instanceof Error ? error.message : "AI request failed"
      });

      try {
        return await requestJsonChatCompletion(fallbackBody);
      } catch (fallbackError) {
        if (isProviderCompatibilityError(fallbackError)) {
          logAi(runId, "completion.toolChoiceOmitFallback", {
            status: fallbackError instanceof HttpError ? fallbackError.status : undefined,
            error: fallbackError instanceof Error ? fallbackError.message : "AI request failed"
          });
          return requestJsonChatCompletion(omitRequestField(fallbackBody, "tool_choice"));
        }

        throw fallbackError;
      }
    }

    throw error;
  }
}

export async function requestChatCompletionWithToolChoiceFallback(body: Record<string, unknown>, fallbackBody: Record<string, unknown>, runId: string) {
  try {
    return await requestChatCompletion(body);
  } catch (error) {
    if (isProviderCompatibilityError(error)) {
      logAi(runId, "completion.chatToolChoiceFallback", {
        status: error instanceof HttpError ? error.status : undefined,
        error: error instanceof Error ? error.message : "AI request failed"
      });

      try {
        return await requestChatCompletion(fallbackBody);
      } catch (fallbackError) {
        if (isProviderCompatibilityError(fallbackError)) {
          logAi(runId, "completion.chatToolChoiceOmitFallback", {
            status: fallbackError instanceof HttpError ? fallbackError.status : undefined,
            error: fallbackError instanceof Error ? fallbackError.message : "AI request failed"
          });
          return requestChatCompletion(omitRequestField(fallbackBody, "tool_choice"));
        }

        throw fallbackError;
      }
    }

    throw error;
  }
}

export async function requestChatCompletionStream(body: unknown, onDelta: (delta: string) => void, signal?: AbortSignal) {
  let lastErrorText = "";

  for (const url of getChatCompletionUrls()) {
    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.aiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return "";
      }

      const message = error instanceof Error ? error.message : "AI request failed";
      throw new HttpError(502, `AI request failed: ${message}`);
    }

    if (!response.ok) {
      lastErrorText = await response.text();

      if (response.status === 404 || response.status === 405) {
        continue;
      }

      throw new HttpError(response.status, lastErrorText || `AI request failed with status ${response.status}`);
    }

    if (!response.body) {
      throw new HttpError(502, "AI response did not include a stream body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice(5).trim();

        if (!payload || payload === "[DONE]") continue;

        const data = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = data.choices?.[0]?.delta?.content || "";

        if (delta) {
          answer += delta;
          onDelta(delta);
        }
      }
    }

    return answer;
  }

  throw new HttpError(502, lastErrorText || "AI request failed");
}
