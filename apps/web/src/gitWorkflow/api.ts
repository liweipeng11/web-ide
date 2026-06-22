import type { GitCommitResult, GitStatus } from "./types";

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

export function fetchGitStatus() {
  return request<{ status: GitStatus }>("/api/git-workflow/status");
}

export function createGitBranch(branchName: string, allowDirty = false) {
  return request<{ status: GitStatus }>("/api/git-workflow/branches", {
    method: "POST",
    body: JSON.stringify({ branchName, allowDirty })
  });
}

export function generateCommitMessage(taskSessionId?: string | null, files: string[] = []) {
  return request<{ message: string }>("/api/git-workflow/commit-message", {
    method: "POST",
    body: JSON.stringify({ taskSessionId, files })
  });
}

export function commitGitChanges(message: string, taskSessionId?: string | null, files: string[] = []) {
  return request<GitCommitResult>("/api/git-workflow/commits", {
    method: "POST",
    body: JSON.stringify({ taskSessionId, files, message })
  });
}
