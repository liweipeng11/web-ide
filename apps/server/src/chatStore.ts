import crypto from "node:crypto";
import { appStatePath, legacyAppStatePath } from "./statePaths.js";
import { readJsonStateFile, writeJsonStateFile } from "./stateFileStorage.js";
import type { FileChatMessage } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

type ChatStore = {
  conversations: Record<string, FileChatMessage[]>;
};

const chatStorePath = appStatePath("chat-store.json");
const legacyChatStorePath = legacyAppStatePath("chat-store.json");

function validateChatStore(value: unknown): ChatStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("chat store must be an object");
  const conversations = (value as Partial<ChatStore>).conversations;
  if (!conversations || typeof conversations !== "object" || Array.isArray(conversations)) throw new Error("chat store conversations are invalid");
  return { conversations };
}

/** 统一串行化聊天记录的读改写，避免并发请求基于同一旧快照互相覆盖。 */
export class ChatStoreRepository {
  private updateQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly stateFilePath: string,
    private readonly legacyStateFilePath?: string
  ) {}

  async read(): Promise<ChatStore> {
    const primary = await readJsonStateFile<ChatStore>(this.stateFilePath, {
      allowMissing: true,
      recover: true,
      validate: validateChatStore
    });
    if (primary) return primary;
    if (!this.legacyStateFilePath) return { conversations: {} };
    return await readJsonStateFile<ChatStore>(this.legacyStateFilePath, {
      allowMissing: true,
      recover: true,
      validate: validateChatStore
    }) ?? { conversations: {} };
  }

  async update<T>(mutate: (store: ChatStore) => T | Promise<T>): Promise<T> {
    let result!: T;
    const update = this.updateQueue.catch(() => undefined).then(async () => {
      const store = await this.read();
      result = await mutate(store);
      await writeJsonStateFile(this.stateFilePath, store);
    });
    this.updateQueue = update;
    await update;
    return result;
  }
}

const chatStoreRepository = new ChatStoreRepository(chatStorePath, legacyChatStorePath);

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
  return chatStoreRepository.read();
}

export async function getFileChatMessages(filePath: string) {
  const store = await readChatStore();
  return store.conversations[conversationKey(filePath)] || [];
}

// 为历史任务补齐聊天记录：如果已有对话则保留原内容，避免覆盖用户真实上下文。
export async function ensureFileChatMessages(filePath: string, fallbackMessages: FileChatMessage[]) {
  const key = conversationKey(filePath);
  return chatStoreRepository.update((store) => {
    const existingMessages = store.conversations[key] || [];
    if (existingMessages.length) return existingMessages;
    store.conversations[key] = fallbackMessages;
    return fallbackMessages;
  });
}

export async function listFileChatHistories() {
  const store = await readChatStore();

  return Object.entries(store.conversations)
    .flatMap(([key, messages]) => {
      const filePath = parseConversationKey(key);

      if (!filePath || !messages.length || !filePath.startsWith("chat:")) {
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
  const key = conversationKey(filePath);
  return chatStoreRepository.update((store) => {
    const messages = store.conversations[key] || [];
    const createdAt = new Date().toISOString();
    const nextMessages: FileChatMessage[] = [
      ...messages,
      { id: crypto.randomUUID(), role: "user" as const, content: userContent, createdAt },
      { id: crypto.randomUUID(), role: "assistant" as const, content: assistantContent, createdAt: new Date().toISOString() }
    ].slice(-40);
    store.conversations[key] = nextMessages;
    return nextMessages;
  });
}

export async function appendFileChatMessage(
  filePath: string,
  message: Omit<FileChatMessage, "id" | "createdAt"> & Partial<Pick<FileChatMessage, "id" | "createdAt">>
) {
  const key = conversationKey(filePath);
  return chatStoreRepository.update((store) => {
    const messages = store.conversations[key] || [];
    const nextMessage: FileChatMessage = {
      id: message.id || crypto.randomUUID(), role: message.role, content: message.content,
      createdAt: message.createdAt || new Date().toISOString()
    };
    const nextMessages = [...messages, nextMessage].slice(-40);
    store.conversations[key] = nextMessages;
    return nextMessages;
  });
}

export async function startFileChatTurn(filePath: string, userContent: string, replayFromMessageId = "") {
  const key = conversationKey(filePath);
  return chatStoreRepository.update((store) => {
    const messages = store.conversations[key] || [];
    const replayIndex = replayFromMessageId ? messages.findIndex((message) => message.id === replayFromMessageId && message.role === "user") : -1;
    const baseMessages = replayFromMessageId && replayIndex >= 0 ? messages.slice(0, replayIndex) : messages;
    const userMessage: FileChatMessage = {
      id: replayIndex >= 0 ? messages[replayIndex].id : crypto.randomUUID(), role: "user", content: userContent, createdAt: new Date().toISOString()
    };
    const assistantMessage: FileChatMessage = {
      id: crypto.randomUUID(), role: "assistant", content: "", createdAt: new Date().toISOString()
    };
    const nextMessages = [...baseMessages, userMessage, assistantMessage].slice(-40);
    store.conversations[key] = nextMessages;
    return { history: baseMessages, userMessage, assistantMessage, messages: nextMessages };
  });
}

export async function finishFileChatTurn(filePath: string, assistantMessageId: string, assistantContent: string) {
  const key = conversationKey(filePath);
  return chatStoreRepository.update((store) => {
    const messages = store.conversations[key] || [];
    const nextMessages = messages.map((message) => (message.id === assistantMessageId ? { ...message, content: assistantContent } : message));
    store.conversations[key] = nextMessages;
    return nextMessages;
  });
}

export async function deleteFileChatMessage(filePath: string, messageId: string) {
  const key = conversationKey(filePath);
  return chatStoreRepository.update((store) => {
    const messages = store.conversations[key] || [];
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return messages;
    const deleteCount = messages[index].role === "user" && messages[index + 1]?.role === "assistant" ? 2 : 1;
    const nextMessages = [...messages.slice(0, index), ...messages.slice(index + deleteCount)];
    store.conversations[key] = nextMessages;
    return nextMessages;
  });
}

export async function branchFileChatMessages(filePath: string, messageId: string) {
  const key = conversationKey(filePath);
  return chatStoreRepository.update((store) => {
    const messages = store.conversations[key] || [];
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return messages;
    const nextMessages = messages.slice(0, index + 1);
    store.conversations[key] = nextMessages;
    return nextMessages;
  });
}

export async function clearFileChatMessages(filePath: string) {
  await chatStoreRepository.update((store) => {
    delete store.conversations[conversationKey(filePath)];
  });
}

export async function deleteFileChatHistory(filePath: string) {
  await clearFileChatMessages(filePath);
  return listFileChatHistories();
}
