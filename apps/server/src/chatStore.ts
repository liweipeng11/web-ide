import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { FileChatMessage } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

type ChatStore = {
  conversations: Record<string, FileChatMessage[]>;
};

const chatStorePath = path.join(path.dirname(config.stateFilePath), "chat-store.json");

function conversationKey(filePath: string) {
  return `${getWorkspaceRoot() || "none"}::${filePath}`;
}

function parseConversationKey(key: string) {
  const workspaceRoot = getWorkspaceRoot() || "none";
  const prefix = `${workspaceRoot}::`;

  if (!key.startsWith(prefix)) {
    return null;
  }

  return key.slice(prefix.length);
}

async function readChatStore(): Promise<ChatStore> {
  const raw = await fs.readFile(chatStorePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (!raw) {
    return { conversations: {} };
  }

  try {
    const parsed = JSON.parse(raw) as ChatStore;
    return parsed && typeof parsed === "object" && parsed.conversations ? parsed : { conversations: {} };
  } catch {
    return { conversations: {} };
  }
}

async function writeChatStore(store: ChatStore) {
  await fs.mkdir(path.dirname(chatStorePath), { recursive: true });
  await fs.writeFile(chatStorePath, JSON.stringify(store, null, 2), "utf8");
}

export async function getFileChatMessages(filePath: string) {
  const store = await readChatStore();
  return store.conversations[conversationKey(filePath)] || [];
}

export async function listFileChatHistories() {
  const store = await readChatStore();

  return Object.entries(store.conversations)
    .flatMap(([key, messages]) => {
      const filePath = parseConversationKey(key);

      if (!filePath || !messages.length) {
        return [];
      }

      const lastMessage = messages[messages.length - 1];

      return [
        {
          path: filePath,
          messageCount: messages.length,
          updatedAt: lastMessage.createdAt,
          preview: lastMessage.content.slice(0, 120)
        }
      ];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function appendFileChatTurn(filePath: string, userContent: string, assistantContent: string) {
  const store = await readChatStore();
  const key = conversationKey(filePath);
  const messages = store.conversations[key] || [];
  const createdAt = new Date().toISOString();

  const nextMessages: FileChatMessage[] = [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: "user" as const,
      content: userContent,
      createdAt
    },
    {
      id: crypto.randomUUID(),
      role: "assistant" as const,
      content: assistantContent,
      createdAt: new Date().toISOString()
    }
  ].slice(-40);

  store.conversations[key] = nextMessages;
  await writeChatStore(store);

  return nextMessages;
}

export async function startFileChatTurn(filePath: string, userContent: string, replayFromMessageId = "") {
  const store = await readChatStore();
  const key = conversationKey(filePath);
  const messages = store.conversations[key] || [];
  const replayIndex = replayFromMessageId ? messages.findIndex((message) => message.id === replayFromMessageId && message.role === "user") : -1;
  const baseMessages = replayFromMessageId && replayIndex >= 0 ? messages.slice(0, replayIndex) : messages;
  const createdAt = new Date().toISOString();
  const userMessage: FileChatMessage = {
    id: replayIndex >= 0 ? messages[replayIndex].id : crypto.randomUUID(),
    role: "user",
    content: userContent,
    createdAt
  };
  const assistantMessage: FileChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString()
  };
  const nextMessages = [...baseMessages, userMessage, assistantMessage].slice(-40);

  store.conversations[key] = nextMessages;
  await writeChatStore(store);

  return {
    history: baseMessages,
    userMessage,
    assistantMessage,
    messages: nextMessages
  };
}

export async function finishFileChatTurn(filePath: string, assistantMessageId: string, assistantContent: string) {
  const store = await readChatStore();
  const key = conversationKey(filePath);
  const messages = store.conversations[key] || [];
  const nextMessages = messages.map((message) => (message.id === assistantMessageId ? { ...message, content: assistantContent } : message));

  store.conversations[key] = nextMessages;
  await writeChatStore(store);

  return nextMessages;
}

export async function deleteFileChatMessage(filePath: string, messageId: string) {
  const store = await readChatStore();
  const key = conversationKey(filePath);
  const messages = store.conversations[key] || [];
  const index = messages.findIndex((message) => message.id === messageId);

  if (index < 0) {
    return messages;
  }

  const deleteCount = messages[index].role === "user" && messages[index + 1]?.role === "assistant" ? 2 : 1;
  const nextMessages = [...messages.slice(0, index), ...messages.slice(index + deleteCount)];

  store.conversations[key] = nextMessages;
  await writeChatStore(store);

  return nextMessages;
}

export async function branchFileChatMessages(filePath: string, messageId: string) {
  const store = await readChatStore();
  const key = conversationKey(filePath);
  const messages = store.conversations[key] || [];
  const index = messages.findIndex((message) => message.id === messageId);

  if (index < 0) {
    return messages;
  }

  const nextMessages = messages.slice(0, index + 1);

  store.conversations[key] = nextMessages;
  await writeChatStore(store);

  return nextMessages;
}

export async function clearFileChatMessages(filePath: string) {
  const store = await readChatStore();
  delete store.conversations[conversationKey(filePath)];
  await writeChatStore(store);
}
