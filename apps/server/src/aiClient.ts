import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { buildUserPrompt, AI_FILE_CHAT_SYSTEM_PROMPT, AI_SYSTEM_PROMPT } from "./prompts.js";
import { discoverProjectCommands } from "./commandDiscovery.js";
import { formatCommandFailureForPrompt, getLastFailedCommandResultForChat } from "./commandResults.js";
import type { AiEditResult, ChatContextFile, FileChatMessage } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

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
    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.aiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI request failed";
      throw new HttpError(502, `AI request failed: ${message}`);
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

export async function generateAiEdit(filePath: string, content: string, userRequest: string): Promise<AiEditResult> {
  if (!config.aiApiKey) {
    throw new HttpError(400, "AI_API_KEY is required to generate edits");
  }

  const [availableCommands, recentFailedCommand] = await Promise.all([getAvailableCommandsForPrompt(), Promise.resolve(null).then(formatCommandFailureForPrompt)]);

  const data = await requestChatCompletion({
    model: config.aiModel,
    temperature: 0,
    messages: [
      { role: "system", content: AI_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(filePath, content, userRequest, availableCommands, recentFailedCommand) }
    ]
  });

  const rawContent = data.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw new HttpError(502, "AI response did not include content");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJsonContent(rawContent));
  } catch {
    throw new HttpError(502, "Failed to parse AI response");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(502, "Failed to parse AI response");
  }

  const result = parsed as Partial<AiEditResult>;

  if (typeof result.summary !== "string") {
    throw new HttpError(502, "Failed to parse AI response");
  }

  if (result.newContent !== null && typeof result.newContent !== "string") {
    throw new HttpError(502, "Failed to parse AI response");
  }

  return {
    summary: result.summary,
    newContent: result.newContent
  };
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

  const data = await requestChatCompletion({
    model: config.aiModel,
    temperature: 0.3,
    messages: [
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
    ]
  });

  const rawContent = data.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw new HttpError(502, "AI response did not include content");
  }

  return rawContent;
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

export async function streamFileChatReply(contextFiles: ChatContextFile[], history: FileChatMessage[], userRequest: string, onDelta: (delta: string) => void, signal?: AbortSignal, chatId?: string) {
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

  return requestChatCompletionStream(
    {
      model: config.aiModel,
      temperature: 0.3,
      stream: true,
      messages: await buildFileChatMessages(contextFiles, history, userRequest, chatId)
    },
    onDelta,
    signal
  );
}
