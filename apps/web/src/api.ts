export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type ReadFileResponse = {
  path: string;
  content: string;
};

export type GenerateEditResponse = {
  patchId: string;
  summary: string;
  oldContent: string;
  newContent: string;
  diffHtml: string;
};

export type FileChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type FileChatHistoryItem = {
  path: string;
  messageCount: number;
  updatedAt: string;
  preview: string;
};

export type FileChatResponse = {
  messages: FileChatMessage[];
};

export type FileChatHistoriesResponse = {
  histories: FileChatHistoryItem[];
};

export type CodeSearchResult = {
  path: string;
  line: number;
  column: number;
  text: string;
  match: string;
};

export type CodeSearchResponse = {
  results: CodeSearchResult[];
};

export type FileChatStreamEvent =
  | { event: "user"; data: { message: FileChatMessage } }
  | { event: "assistant_start"; data: { message: FileChatMessage } }
  | { event: "delta"; data: { id: string; delta: string } }
  | { event: "done"; data: { messages: FileChatMessage[] } }
  | { event: "error"; data: { error: string } };

export type WorkspaceResponse = {
  workspaceRoot: string | null;
};

export type PickWorkspaceResponse = WorkspaceResponse & {
  cancelled: boolean;
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    },
    ...options
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || data?.summary || "请求失败");
  }

  return data as T;
}

export function fetchFiles(dir = "") {
  return request<FileTreeNode[]>(`/api/files?dir=${encodeURIComponent(dir)}`);
}

export function fetchWorkspace() {
  return request<WorkspaceResponse>("/api/workspace");
}

export function openWorkspace(workspaceRoot: string) {
  return request<WorkspaceResponse>("/api/workspace/open", {
    method: "POST",
    body: JSON.stringify({ workspaceRoot })
  });
}

export function pickWorkspace() {
  return request<PickWorkspaceResponse>("/api/workspace/pick", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function fetchFile(path: string) {
  return request<ReadFileResponse>(`/api/file?path=${encodeURIComponent(path)}`);
}

export function searchCode(query: string) {
  return request<CodeSearchResponse>(`/api/search?q=${encodeURIComponent(query)}`);
}

export function saveFile(path: string, content: string) {
  return request<{ success: boolean; path: string }>("/api/file", {
    method: "POST",
    body: JSON.stringify({ path, content })
  });
}

export function generateEdit(path: string, userRequest: string) {
  return request<GenerateEditResponse>("/api/ai/generate-edit", {
    method: "POST",
    body: JSON.stringify({ path, userRequest })
  });
}

export function fetchFileChat(path: string) {
  return request<FileChatResponse>(`/api/ai/file-chat?path=${encodeURIComponent(path)}`);
}

export function fetchFileChatHistories() {
  return request<FileChatHistoriesResponse>("/api/ai/file-chat/histories");
}

export function sendFileChatMessage(path: string, userRequest: string) {
  return request<FileChatResponse>("/api/ai/file-chat", {
    method: "POST",
    body: JSON.stringify({ path, userRequest })
  });
}

export async function streamFileChatMessage(path: string, userRequest: string, onEvent: (event: FileChatStreamEvent) => void, signal?: AbortSignal, replayFromMessageId?: string) {
  const response = await fetch("/api/ai/file-chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({ path, userRequest, replayFromMessageId })
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `请求失败，状态码 ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split("\n\n");
    buffer = packets.pop() || "";

    for (const packet of packets) {
      const event = packet.match(/^event:\s*(.+)$/m)?.[1]?.trim() as FileChatStreamEvent["event"] | undefined;
      const dataLine = packet.match(/^data:\s*(.+)$/m)?.[1];

      if (!event || !dataLine) continue;

      onEvent({ event, data: JSON.parse(dataLine) } as FileChatStreamEvent);
    }
  }
}

export function clearFileChat(path: string) {
  return request<FileChatResponse>(`/api/ai/file-chat?path=${encodeURIComponent(path)}`, {
    method: "DELETE"
  });
}

export function deleteFileChatMessage(path: string, messageId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat/messages/${encodeURIComponent(messageId)}?path=${encodeURIComponent(path)}`, {
    method: "DELETE"
  });
}

export function branchFileChatMessage(path: string, messageId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat/messages/${encodeURIComponent(messageId)}/branch`, {
    method: "POST",
    body: JSON.stringify({ path })
  });
}

export function applyPatch(patchId: string) {
  return request<{ success: boolean }>("/api/patch/apply", {
    method: "POST",
    body: JSON.stringify({ patchId })
  });
}

export function rejectPatch(patchId: string) {
  return request<{ success: boolean }>("/api/patch/reject", {
    method: "POST",
    body: JSON.stringify({ patchId })
  });
}
