import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { buildUserPrompt, AI_FILE_CHAT_SYSTEM_PROMPT, AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, AI_SYSTEM_PROMPT } from "./prompts.js";
import { discoverProjectCommands } from "./commandDiscovery.js";
import { formatCommandFailureForPrompt, getLastFailedCommandResultForChat } from "./commandResults.js";
import { searchWorkspaceCode } from "./codeSearch.js";
import { readWorkspaceFile } from "./fileTools.js";
import type { AiEditResult, ChatContextFile, FileChatMessage } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AgentContext = {
  userGoal: string;
  filesRead: string[];
  searchQueries: string[];
  relevantFiles: string[];
};

export type AgentStep = {
  id: string;
  type: "search" | "read";
  title: string;
  detail: string;
};

export type EditPathRetryContext = {
  invalidFilePaths: string[];
  validFilePaths: string[];
};

type FileChatToolName = "searchCode" | "readFile";

const MAX_AUTO_READ_FILES = 5;
const MAX_READ_FILE_LINES = 240;
const MAX_READ_FILE_CHARS = 20_000;
const AI_LOG_PREVIEW_CHARS = 500;
const AI_FETCH_ATTEMPTS_PER_URL = 2;

const fileChatTools = [
  {
    type: "function",
    function: {
      name: "searchCode",
      description: "Search the current workspace code with ripgrep and return up to 50 matching lines.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The literal text to search for in the workspace."
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "readFile",
      description: "Read a relevant file from the current workspace. The path must be relative to the workspace. At most 5 files can be read automatically.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Workspace-relative file path to read."
          }
        },
        required: ["filePath"],
        additionalProperties: false
      }
    }
  }
];
const MAX_FILE_CHAT_TOOL_STEPS = 8;

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

function createAiRunId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function previewForLog(value: unknown, maxLength = AI_LOG_PREVIEW_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength} chars>` : text;
}

function logAi(runId: string, event: string, detail?: unknown) {
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

function extractJsonContent(rawContent: string) {
  const trimmed = rawContent.trim();
  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  if (fencedJson?.[1]) {
    return fencedJson[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

async function getAvailableCommandsForPrompt() {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return [];
  }

  return discoverProjectCommands(workspaceRoot);
}

async function requestChatCompletion(body: unknown) {
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

async function requestJsonChatCompletion(body: Record<string, unknown>) {
  try {
    return await requestChatCompletion({
      ...body,
      response_format: { type: "json_object" }
    });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 400 || error.status === 422)) {
      return requestChatCompletion(body);
    }

    throw error;
  }
}

function parseToolArguments(rawArguments: string) {
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function uniquePush(target: string[], value: string) {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function createAgentStep(type: AgentStep["type"], title: string, detail: string): AgentStep {
  return {
    id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    type,
    title,
    detail
  };
}

function truncateFileForPrompt(content: string) {
  const lines = content.split(/\r?\n/);
  const byLines = lines.slice(0, MAX_READ_FILE_LINES).join("\n");
  const truncatedContent = byLines.length > MAX_READ_FILE_CHARS ? byLines.slice(0, MAX_READ_FILE_CHARS) : byLines;

  return {
    content: truncatedContent,
    truncated: lines.length > MAX_READ_FILE_LINES || byLines.length > MAX_READ_FILE_CHARS || content.length > truncatedContent.length,
    linesRead: Math.min(lines.length, MAX_READ_FILE_LINES),
    totalLines: lines.length
  };
}

async function executeFileChatToolCall(
  toolCall: ToolCall,
  searchCache: Map<string, unknown>,
  readCache: Map<string, string>,
  agentContext: AgentContext,
  runId: string,
  onAgentStep?: (step: AgentStep) => void
): Promise<ChatMessage> {
  const toolName = toolCall.function.name as FileChatToolName;
  logAi(runId, "tool.call", { name: toolCall.function.name, arguments: toolCall.function.arguments });

  if (toolName !== "searchCode" && toolName !== "readFile") {
    logAi(runId, "tool.unknown", toolCall.function.name);
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` })
    };
  }

  const args = parseToolArguments(toolCall.function.arguments);

  if (toolName === "readFile") {
    const filePath = typeof args.filePath === "string" ? args.filePath.trim() : "";

    if (!filePath) {
      logAi(runId, "tool.readFile.missingPath");
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ error: "filePath is required" })
      };
    }

    const readCacheKey = filePath.toLowerCase();

    if (readCache.has(readCacheKey)) {
      logAi(runId, "tool.readFile.cacheHit", { filePath });
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          note: `readFile("${filePath}") was already called. Use this cached file content instead of reading it again.`,
          ...JSON.parse(readCache.get(readCacheKey) || "{}")
        })
      };
    }

    if (!agentContext.filesRead.includes(filePath) && agentContext.filesRead.length >= MAX_AUTO_READ_FILES) {
      logAi(runId, "tool.readFile.limit", { filePath, filesRead: agentContext.filesRead });
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: `Automatic file read limit reached. You may read at most ${MAX_AUTO_READ_FILES} files.`,
          filesRead: agentContext.filesRead
        })
      };
    }

    let rawContent = "";

    try {
      rawContent = await readWorkspaceFile(filePath);
    } catch (error) {
      logAi(runId, "tool.readFile.error", { filePath, error: error instanceof Error ? error.message : "Failed to read file" });
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ error: error instanceof Error ? error.message : "Failed to read file", filePath })
      };
    }
    const truncated = truncateFileForPrompt(rawContent);
    logAi(runId, "tool.readFile.ok", { filePath, chars: rawContent.length, linesRead: truncated.linesRead, totalLines: truncated.totalLines, truncated: truncated.truncated });
    uniquePush(agentContext.filesRead, filePath);
    uniquePush(agentContext.relevantFiles, filePath);
    onAgentStep?.(
      createAgentStep(
        "read",
        `Read ${filePath}`,
        truncated.truncated ? `Read first ${truncated.linesRead} of ${truncated.totalLines} lines.` : `Read ${truncated.totalLines} lines.`
      )
    );

    const payload = JSON.stringify({
      filePath,
      ...truncated
    });
    readCache.set(readCacheKey, payload);

    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: payload
    };
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";

  if (!query) {
    logAi(runId, "tool.searchCode.emptyQuery");
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: "query is required. Do not call searchCode with an empty query." })
    };
  }

  const cacheKey = query.toLowerCase();
  uniquePush(agentContext.searchQueries, query);
  onAgentStep?.(createAgentStep("search", `Search ${query}`, "Scanned workspace code for matching lines."));

  if (searchCache.has(cacheKey)) {
    logAi(runId, "tool.searchCode.cacheHit", { query });
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        note: `searchCode("${query}") was already called. Use these cached results instead of searching again.`,
        results: searchCache.get(cacheKey)
      })
    };
  }

  const results = query
    ? (await searchWorkspaceCode(query)).map((result) => ({
        filePath: result.filePath,
        line: result.line,
        content: result.content
      }))
    : [];

  searchCache.set(cacheKey, results);
  logAi(runId, "tool.searchCode.ok", { query, resultCount: results.length, files: [...new Set(results.map((result) => result.filePath))].slice(0, 10) });

  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: JSON.stringify(results)
  };
}

async function generateFileChatAssistantContent(messages: ChatMessage[], agentContext: AgentContext, onAgentStep?: (step: AgentStep) => void) {
  const runId = createAiRunId("chat");
  const startedAt = Date.now();
  const toolMessages = [...messages];
  const searchCache = new Map<string, unknown>();
  const readCache = new Map<string, string>();
  logAi(runId, "start", { userGoal: agentContext.userGoal, contextFiles: agentContext.relevantFiles });

  for (let step = 0; step < MAX_FILE_CHAT_TOOL_STEPS; step += 1) {
    logAi(runId, "completion.request", { step, messageCount: toolMessages.length, tools: true });
    const data = await requestChatCompletion({
      model: config.aiModel,
      temperature: 0.3,
      messages: toolMessages,
      tools: fileChatTools,
      tool_choice: "auto"
    });

    const message = data.choices?.[0]?.message;

    if (!message) {
      logAi(runId, "completion.missingMessage");
      throw new HttpError(502, "AI response did not include content");
    }

    if (!message.tool_calls?.length) {
      logAi(runId, "done", { elapsedMs: Date.now() - startedAt, contentPreview: message.content || "" });
      return message.content || "";
    }

    toolMessages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls
    });

    logAi(runId, "completion.toolCalls", message.tool_calls.map((toolCall) => toolCall.function.name));
    const results = await Promise.all(message.tool_calls.map((toolCall) => executeFileChatToolCall(toolCall, searchCache, readCache, agentContext, runId, onAgentStep)));
    toolMessages.push(...results);
  }

  logAi(runId, "toolSteps.limitReached", { maxSteps: MAX_FILE_CHAT_TOOL_STEPS });
  toolMessages.push({
    role: "user",
    content: "You have already called tools enough times. Do not call any more tools. Answer the user's request using the search results and files already provided."
  });

  const data = await requestChatCompletion({
    model: config.aiModel,
    temperature: 0.3,
    messages: toolMessages
  });

  const content = data.choices?.[0]?.message?.content || "I searched the code, but could not produce a final answer.";
  logAi(runId, "done.afterLimit", { elapsedMs: Date.now() - startedAt, contentPreview: content });
  return content;
}

async function requestChatCompletionStream(body: unknown, onDelta: (delta: string) => void, signal?: AbortSignal) {
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

function parseAiEditResult(rawContent: string): AiEditResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJsonContent(rawContent));
  } catch {
    console.error("Failed to parse AI edit response JSON:", rawContent.slice(0, 1000));
    throw new HttpError(502, "Failed to parse AI response");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(502, "Failed to parse AI response");
  }

  const result = parsed as { summary?: unknown; files?: unknown; changes?: unknown; newContent?: unknown };

  if (typeof result.summary !== "string") {
    console.error("Failed to parse AI edit response summary:", JSON.stringify(parsed).slice(0, 1000));
    throw new HttpError(502, "Failed to parse AI response");
  }

  if (result.files === null || result.newContent === null) {
    return {
      summary: result.summary,
      files: null
    };
  }

  const fileChanges = Array.isArray(result.files) ? result.files : Array.isArray(result.changes) ? result.changes : null;

  if (fileChanges) {
    const files = fileChanges.map((file) => {
      if (!file || typeof file !== "object") {
        console.error("Failed to parse AI edit response file item:", JSON.stringify(file).slice(0, 1000));
        throw new HttpError(502, "Failed to parse AI response");
      }

      const change = file as { path?: unknown; filePath?: unknown; file?: unknown; newContent?: unknown; content?: unknown };
      const path = typeof change.path === "string" ? change.path : typeof change.filePath === "string" ? change.filePath : typeof change.file === "string" ? change.file : "";
      const newContent = typeof change.newContent === "string" ? change.newContent : typeof change.content === "string" ? change.content : "";

      if (!path || typeof newContent !== "string") {
        console.error("Failed to parse AI edit response file shape:", JSON.stringify(file).slice(0, 1000));
        throw new HttpError(502, "Failed to parse AI response");
      }

      return {
        path,
        newContent
      };
    });

    return {
      summary: result.summary,
      files
    };
  }

  if (typeof result.newContent === "string") {
    return {
      summary: result.summary,
      files: []
    };
  }

  throw new HttpError(502, "Failed to parse AI response");
}

function normalizeAiEditResult(rawContent: string, filePath?: string | null) {
  const result = parseAiEditResult(rawContent);

  if (result.files && result.files.length === 0) {
    if (!filePath) {
      throw new HttpError(502, "AI returned a single-file edit without a selected file path");
    }

    const parsed = JSON.parse(extractJsonContent(rawContent)) as { summary: string; newContent: string };

    return {
      summary: parsed.summary,
      files: [{ path: filePath, newContent: parsed.newContent }]
    };
  }

  return result;
}

async function normalizeAiEditResultWithRepair(rawContent: string, filePath?: string | null, runId = "edit") {
  try {
    return normalizeAiEditResult(rawContent, filePath);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 502) {
      throw error;
    }

    logAi(runId, "edit.parse.repair.start", { rawPreview: rawContent });
    const repairResponse = await requestJsonChatCompletion({
      model: config.aiModel,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You repair malformed AI edit responses for a local code editor.",
            "Return ONLY valid JSON.",
            "Do not change the intended code content except to make it valid JSON.",
            "The required schema is:",
            '{"summary":"short summary","files":[{"path":"existing/workspace/path","newContent":"full updated file content"}]}',
            "If the original response says the edit cannot be done, return {\"summary\":\"reason\",\"files\":null}."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              selectedFilePath: filePath || null,
              malformedResponse: rawContent
            },
            null,
            2
          )
        }
      ]
    });
    const repairedContent = repairResponse.choices?.[0]?.message?.content;

    if (!repairedContent) {
      logAi(runId, "edit.parse.repair.empty");
      throw error;
    }

    try {
      const result = normalizeAiEditResult(repairedContent, filePath);
      logAi(runId, "edit.parse.repair.ok", { files: result.files?.map((file) => file.path) || null });
      return result;
    } catch {
      console.error("Failed to parse repaired AI edit response:", repairedContent.slice(0, 1000));
      logAi(runId, "edit.parse.repair.failed", { repairedPreview: repairedContent });
      throw error;
    }
  }
}

async function generateAiEditWithTools(filePath: string | null, content: string, userRequest: string, onAgentStep?: (step: AgentStep) => void, pathRetryContext?: EditPathRetryContext): Promise<AiEditResult> {
  const runId = createAiRunId("edit");
  const startedAt = Date.now();
  const [availableCommands, recentFailedCommand] = await Promise.all([getAvailableCommandsForPrompt(), Promise.resolve(null).then(formatCommandFailureForPrompt)]);
  const agentContext: AgentContext = {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    relevantFiles: filePath ? [filePath] : []
  };
  const toolMessages: ChatMessage[] = [
    { role: "system", content: AI_MULTI_FILE_EDIT_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify(
        {
          selectedFile: filePath ? { path: filePath, content } : null,
          availableCommands,
          recentFailedCommand,
          pathRetryContext: pathRetryContext
            ? {
                ...pathRetryContext,
                instruction: "Your previous edit response used file paths that do not exist in the workspace. Regenerate the full edit response using only paths from validFilePaths."
              }
            : null,
          userRequest
        },
        null,
        2
      )
    }
  ];
  const searchCache = new Map<string, unknown>();
  const readCache = new Map<string, string>();
  logAi(runId, "start", { userGoal: userRequest, selectedFile: filePath, selectedFileChars: content.length, pathRetryContext });

  for (let step = 0; step < MAX_FILE_CHAT_TOOL_STEPS; step += 1) {
    logAi(runId, "completion.request", { step, messageCount: toolMessages.length, tools: true });
    const data = await requestJsonChatCompletion({
      model: config.aiModel,
      temperature: 0,
      messages: toolMessages,
      tools: fileChatTools,
      tool_choice: "auto"
    });

    const message = data.choices?.[0]?.message;

    if (!message) {
      logAi(runId, "completion.missingMessage");
      throw new HttpError(502, "AI response did not include content");
    }

    if (!message.tool_calls?.length) {
      if (!message.content) {
        logAi(runId, "completion.emptyContent");
        throw new HttpError(502, "AI response did not include content");
      }

      const result = await normalizeAiEditResultWithRepair(message.content, filePath, runId);
      logAi(runId, "done", { elapsedMs: Date.now() - startedAt, files: result.files?.map((file) => file.path) || null, summary: result.summary });
      return result;
    }

    toolMessages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls
    });

    logAi(runId, "completion.toolCalls", message.tool_calls.map((toolCall) => toolCall.function.name));
    const results = await Promise.all(message.tool_calls.map((toolCall) => executeFileChatToolCall(toolCall, searchCache, readCache, agentContext, runId, onAgentStep)));
    toolMessages.push(...results);
  }

  logAi(runId, "toolSteps.limitReached", { maxSteps: MAX_FILE_CHAT_TOOL_STEPS });
  toolMessages.push({
    role: "user",
    content: "You have already called tools enough times. Do not call any more tools. Return the final JSON edit response using the selected file and tool results already provided."
  });

  const data = await requestJsonChatCompletion({
    model: config.aiModel,
    temperature: 0,
    messages: toolMessages
  });

  const rawContent = data.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw new HttpError(502, "AI response did not include content");
  }

  const result = await normalizeAiEditResultWithRepair(rawContent, filePath, runId);
  logAi(runId, "done.afterLimit", { elapsedMs: Date.now() - startedAt, files: result.files?.map((file) => file.path) || null, summary: result.summary });
  return result;
}

export async function generateAiEdit(filePath: string | null, content: string, userRequest: string, onAgentStep?: (step: AgentStep) => void, pathRetryContext?: EditPathRetryContext): Promise<AiEditResult> {
  const runId = createAiRunId("edit-simple");
  const startedAt = Date.now();
  if (!config.aiApiKey) {
    throw new HttpError(400, "AI_API_KEY is required to generate edits");
  }

  if (onAgentStep) {
    return generateAiEditWithTools(filePath, content, userRequest, onAgentStep, pathRetryContext);
  }

  if (!filePath) {
    return generateAiEditWithTools(null, content, userRequest, undefined, pathRetryContext);
  }

  const [availableCommands, recentFailedCommand] = await Promise.all([getAvailableCommandsForPrompt(), Promise.resolve(null).then(formatCommandFailureForPrompt)]);
  logAi(runId, "start", { userGoal: userRequest, selectedFile: filePath, selectedFileChars: content.length });

  logAi(runId, "completion.request", { messageCount: 2, tools: false });
  const data = await requestJsonChatCompletion({
    model: config.aiModel,
    temperature: 0,
    messages: [
      { role: "system", content: AI_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(filePath, content, userRequest, availableCommands, recentFailedCommand) }
    ]
  });

  const rawContent = data.choices?.[0]?.message?.content;

  if (!rawContent) {
    logAi(runId, "completion.emptyContent");
    throw new HttpError(502, "AI response did not include content");
  }

  const result = await normalizeAiEditResultWithRepair(rawContent, filePath, runId);
  logAi(runId, "done", { elapsedMs: Date.now() - startedAt, files: result.files?.map((file) => file.path) || null, summary: result.summary });
  return result;
}

export async function generateFileChatReply(contextFiles: ChatContextFile[], history: FileChatMessage[], userRequest: string, chatId?: string) {
  if (!config.aiApiKey) {
    return [
      `Received: ${userRequest}`,
      "",
      "AI_API_KEY is not configured, so this is a local mock response. Configure an OpenAI-compatible provider to get real AI replies."
    ].join("\n");
  }

  const recentHistory = history.slice(-16).map((message) => ({
    role: message.role,
    content: message.content
  }));
  const [availableCommands, recentFailedCommand] = await Promise.all([getAvailableCommandsForPrompt(), getLastFailedCommandResultForChat(chatId).then(formatCommandFailureForPrompt)]);

  const agentContext: AgentContext = {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    relevantFiles: contextFiles.map((file) => file.path)
  };

  return generateFileChatAssistantContent([
    { role: "system", content: AI_FILE_CHAT_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify(
        {
          contextFiles,
          availableCommands,
          recentFailedCommand
        },
        null,
        2
      )
    },
    ...recentHistory,
    { role: "user", content: userRequest }
  ], agentContext);
}

async function buildFileChatMessages(contextFiles: ChatContextFile[], history: FileChatMessage[], userRequest: string, chatId?: string): Promise<ChatMessage[]> {
  const recentHistory = history.slice(-16).map((message) => ({
    role: message.role,
    content: message.content
  }));
  const [availableCommands, recentFailedCommand] = await Promise.all([getAvailableCommandsForPrompt(), getLastFailedCommandResultForChat(chatId).then(formatCommandFailureForPrompt)]);

  return [
    { role: "system", content: AI_FILE_CHAT_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify(
        {
          contextFiles,
          availableCommands,
          recentFailedCommand
        },
        null,
        2
      )
    },
    ...recentHistory,
    { role: "user", content: userRequest }
  ];
}

export async function streamFileChatReply(
  contextFiles: ChatContextFile[],
  history: FileChatMessage[],
  userRequest: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  chatId?: string,
  onAgentStep?: (step: AgentStep) => void
) {
  if (!config.aiApiKey) {
    const text = [
      `Received: ${userRequest}`,
      "",
      "AI_API_KEY is not configured, so this is a local mock streaming response. Configure an OpenAI-compatible provider to get real AI replies."
    ].join("\n");

    for (const chunk of text.match(/.{1,5}/gs) || []) {
      if (signal?.aborted) break;
      onDelta(chunk);
      await new Promise((resolve) => setTimeout(resolve, 35));
    }

    return signal?.aborted ? "" : text;
  }

  const agentContext: AgentContext = {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    relevantFiles: contextFiles.map((file) => file.path)
  };
  const text = await generateFileChatAssistantContent(await buildFileChatMessages(contextFiles, history, userRequest, chatId), agentContext, onAgentStep);

  for (const chunk of text.match(/.{1,16}/gs) || []) {
    if (signal?.aborted) break;
    onDelta(chunk);
  }

  return signal?.aborted ? "" : text;
}
