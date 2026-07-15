import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { projectRuntimeDirectory } from "./statePaths.js";

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

type AiExchangeLog = {
  id: string;
  createdAt: string;
  mode: "non_stream" | "stream";
  url: string;
  attempt: number;
  model?: unknown;
  requestBody: unknown;
  status?: number;
  ok?: boolean;
  responseBody?: unknown;
  responseText?: string;
  outputText?: string;
  aborted?: boolean;
  error?: string;
  durationMs: number;
};

const AI_LOG_PREVIEW_CHARS = 500;
const AI_FETCH_ATTEMPTS_PER_URL = 2;
const sensitiveLogFieldPattern = /(authorization|header|api[_-]?key|token|secret|password|userGoal|content|replacement|selectedText|prefix|suffix|snippet|output|requestBody|responseBody)/i;
const sensitiveLogValuePattern = /(Bearer\s+)[^\s,;]+|((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)[^\s,;]+/gi;

function getChatCompletionUrls() {
  const normalizedBaseUrl = config.aiBaseUrl.replace(/\/$/, "");
  const urls = [`${normalizedBaseUrl}/chat/completions`];

  try {
    const parsed = new URL(normalizedBaseUrl);

    if (parsed.pathname === "" || parsed.pathname === "/") {
      urls.push(`${normalizedBaseUrl}/v1/chat/completions`);
    }
  } catch {
    // 让 fetch 自己抛出更明确的 URL 错误。
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

function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (typeof value === "string") return value.replace(sensitiveLogValuePattern, (_match, bearerPrefix, assignmentPrefix) => `${bearerPrefix || assignmentPrefix}<redacted>`);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sensitiveLogFieldPattern.test(key) ? "<redacted>" : sanitizeForLog(entry)])
  );
}

export function logAi(runId: string, event: string, detail?: unknown) {
  const suffix = detail === undefined ? "" : ` ${previewForLog(sanitizeForLog(detail))}`;
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

function getBodyModel(body: unknown) {
  return typeof body === "object" && body && "model" in body ? (body as { model?: unknown }).model : undefined;
}

function serializeForFullLog(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  try {
    // 完整 IO 仅在显式开启 AI_FULL_IO_LOGGING 时写入；请求 Header 始终不进入该结构。
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return previewForLog(value, 4000);
  }
}

function createAiLogFileName(id: string) {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${iso}-${id}.json`;
}

async function persistAiExchangeLog(entry: Omit<AiExchangeLog, "id" | "createdAt">) {
  if (!config.aiFullIoLogging) {
    return;
  }

  try {
    const directory = projectRuntimeDirectory("ai-logs");
    await fs.mkdir(directory, { recursive: true });

    const payload: AiExchangeLog = {
      id: createAiRunId("ai-io"),
      createdAt: new Date().toISOString(),
      ...entry,
      // 完整日志只记录请求体/响应体，不写入 Authorization 等敏感请求头。
      requestBody: serializeForFullLog(entry.requestBody),
      responseBody: serializeForFullLog(entry.responseBody)
    };

    const filePath = path.join(directory, createAiLogFileName(payload.id));
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("[ai:http] failed to persist full AI exchange log", error instanceof Error ? error.message : String(error));
  }
}

export async function requestChatCompletion(body: unknown) {
  let lastErrorText = "";

  for (const url of getChatCompletionUrls()) {
    let response: Response | null = null;
    let responseAttempt = 1;

    for (let attempt = 1; attempt <= AI_FETCH_ATTEMPTS_PER_URL; attempt += 1) {
      const startedAt = Date.now();

      try {
        logAi("http", "request", { url, attempt, model: getBodyModel(body) });
        responseAttempt = attempt;
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
        await persistAiExchangeLog({
          mode: "non_stream",
          url,
          attempt,
          model: getBodyModel(body),
          requestBody: body,
          error: message,
          durationMs: Date.now() - startedAt
        });

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

    const startedAt = Date.now();

    if (response.ok) {
      const responseText = await response.text();
      let parsed: ChatCompletionResponse;

      try {
        parsed = (responseText ? JSON.parse(responseText) : {}) as ChatCompletionResponse;
      } catch (error) {
        await persistAiExchangeLog({
          mode: "non_stream",
          url,
          attempt: 1,
          model: getBodyModel(body),
          requestBody: body,
          status: response.status,
          ok: true,
          responseText,
          error: error instanceof Error ? error.message : "Failed to parse AI response JSON",
          durationMs: Date.now() - startedAt
        });
        throw error;
      }

      await persistAiExchangeLog({
        mode: "non_stream",
        url,
        attempt: 1,
        model: getBodyModel(body),
        requestBody: body,
        status: response.status,
        ok: true,
        responseBody: parsed,
        responseText,
        durationMs: Date.now() - startedAt
      });
      return parsed;
    }

    lastErrorText = await response.text();
    await persistAiExchangeLog({
      mode: "non_stream",
      url,
      attempt: 1,
      model: getBodyModel(body),
      requestBody: body,
      status: response.status,
      ok: false,
      responseText: lastErrorText,
      error: lastErrorText || `AI request failed with status ${response.status}`,
      durationMs: Date.now() - startedAt
    });

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
    const startedAt = Date.now();
    let response: Response;

    try {
      logAi("http", "stream.request", { url, model: getBodyModel(body) });
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
        await persistAiExchangeLog({
          mode: "stream",
          url,
          attempt: 1,
          model: getBodyModel(body),
          requestBody: body,
          aborted: true,
          outputText: "",
          durationMs: Date.now() - startedAt
        });
        return "";
      }

      const message = formatFetchError(error);
      await persistAiExchangeLog({
        mode: "stream",
        url,
        attempt: 1,
        model: getBodyModel(body),
        requestBody: body,
        error: message,
        durationMs: Date.now() - startedAt
      });
      throw new HttpError(502, `AI request failed: ${message}`);
    }

    if (!response.ok) {
      lastErrorText = await response.text();
      await persistAiExchangeLog({
        mode: "stream",
        url,
        attempt: 1,
        model: getBodyModel(body),
        requestBody: body,
        status: response.status,
        ok: false,
        responseText: lastErrorText,
        error: lastErrorText || `AI request failed with status ${response.status}`,
        durationMs: Date.now() - startedAt
      });

      if (response.status === 404 || response.status === 405) {
        continue;
      }

      throw new HttpError(response.status, lastErrorText || `AI request failed with status ${response.status}`);
    }

    if (!response.body) {
      await persistAiExchangeLog({
        mode: "stream",
        url,
        attempt: 1,
        model: getBodyModel(body),
        requestBody: body,
        status: response.status,
        ok: false,
        error: "AI response did not include a stream body",
        durationMs: Date.now() - startedAt
      });
      throw new HttpError(502, "AI response did not include a stream body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";

    try {
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
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        await persistAiExchangeLog({
          mode: "stream",
          url,
          attempt: 1,
          model: getBodyModel(body),
          requestBody: body,
          status: response.status,
          ok: true,
          aborted: true,
          outputText: answer,
          responseText: answer,
          durationMs: Date.now() - startedAt
        });
        return answer;
      }

      await persistAiExchangeLog({
        mode: "stream",
        url,
        attempt: 1,
        model: getBodyModel(body),
        requestBody: body,
        status: response.status,
        ok: false,
        outputText: answer,
        responseText: answer,
        error: error instanceof Error ? error.message : "AI stream parsing failed",
        durationMs: Date.now() - startedAt
      });
      throw error;
    }

    await persistAiExchangeLog({
      mode: "stream",
      url,
      attempt: 1,
      model: getBodyModel(body),
      requestBody: body,
      status: response.status,
      ok: true,
      outputText: answer,
      responseText: answer,
      durationMs: Date.now() - startedAt
    });

    return answer;
  }

  throw new HttpError(502, lastErrorText || "AI request failed");
}
