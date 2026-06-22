import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../errors.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import type { GitChangedFile, GitCommitInfo, GitCommitResult, GitRemoteInfo, GitStatus } from "./types.js";

const execFileAsync = promisify(execFile);

type GitExecOptions = {
  allowFailure?: boolean;
};

function requireWorkspaceRoot() {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    throw new HttpError(400, "Workspace is not open");
  }

  return workspaceRoot;
}

async function runGit(args: string[], options: GitExecOptions = {}) {
  const cwd = requireWorkspaceRoot();

  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
      windowsHide: true
    });

    return {
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
      exitCode: 0
    };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const exitCode = typeof typed.code === "number" ? typed.code : 1;

    if (options.allowFailure) {
      return {
        stdout: String(typed.stdout || "").trimEnd(),
        stderr: String(typed.stderr || typed.message || "").trimEnd(),
        exitCode
      };
    }

    throw new HttpError(400, String(typed.stderr || typed.message || "Git command failed").trim());
  }
}

function parseFileStatus(indexStatus: string, workingTreeStatus: string): GitChangedFile["status"] {
  if (indexStatus === "U" || workingTreeStatus === "U" || (indexStatus === "A" && workingTreeStatus === "A") || (indexStatus === "D" && workingTreeStatus === "D")) return "conflicted";
  if (indexStatus === "?" && workingTreeStatus === "?") return "untracked";
  if (indexStatus === "R" || workingTreeStatus === "R") return "renamed";
  if (indexStatus === "A" || workingTreeStatus === "A") return "added";
  if (indexStatus === "D" || workingTreeStatus === "D") return "deleted";
  if (indexStatus === "M" || workingTreeStatus === "M") return "modified";
  return "unknown";
}

function parsePorcelainLine(line: string): GitChangedFile | null {
  if (!line.trim()) return null;

  const indexStatus = line[0] || " ";
  const workingTreeStatus = line[1] || " ";
  const rawPath = line.slice(3);
  const renameParts = rawPath.split(" -> ");
  const isRename = renameParts.length === 2;
  const filePath = isRename ? renameParts[1] : rawPath;

  return {
    path: filePath,
    originalPath: isRename ? renameParts[0] : undefined,
    status: parseFileStatus(indexStatus, workingTreeStatus),
    indexStatus,
    workingTreeStatus,
    staged: indexStatus !== " " && indexStatus !== "?"
  };
}

function parseRemoteLines(output: string): GitRemoteInfo[] {
  const remotes = new Map<string, GitRemoteInfo>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (!match) continue;
    remotes.set(match[1], { name: match[1], url: match[2] });
  }

  return [...remotes.values()];
}

function validateBranchName(branchName: string) {
  const value = branchName.trim();

  if (!value) {
    throw new HttpError(400, "branchName is required");
  }

  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\s~^:?*[\\]/.test(value)
  ) {
    throw new HttpError(400, "Invalid branch name");
  }

  return value;
}

function validateCommitMessage(message: string) {
  const value = message.trim();

  if (!value) {
    throw new HttpError(400, "message is required");
  }

  return value;
}

function normalizeWorkspaceFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/").trim();

  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new HttpError(400, `Invalid file path: ${filePath}`);
  }

  return normalized;
}

export async function getGitStatus(): Promise<GitStatus> {
  const rootResult = await runGit(["rev-parse", "--show-toplevel"], { allowFailure: true });

  if (rootResult.exitCode !== 0) {
    return {
      isRepo: false,
      branch: null,
      root: null,
      hasChanges: false,
      changedFiles: [],
      lastCommit: null,
      remotes: []
    };
  }

  const [branchResult, statusResult, logResult, remoteResult] = await Promise.all([
    runGit(["branch", "--show-current"], { allowFailure: true }),
    runGit(["status", "--porcelain=v1"], { allowFailure: true }),
    runGit(["log", "-1", "--pretty=format:%h%x00%s"], { allowFailure: true }),
    runGit(["remote", "-v"], { allowFailure: true })
  ]);

  const changedFiles = statusResult.stdout
    .split(/\r?\n/)
    .map(parsePorcelainLine)
    .filter((file): file is GitChangedFile => Boolean(file));
  const [hash, message] = logResult.exitCode === 0 && logResult.stdout ? logResult.stdout.split("\0") : ["", ""];

  return {
    isRepo: true,
    branch: branchResult.stdout || null,
    root: rootResult.stdout || null,
    hasChanges: changedFiles.length > 0,
    changedFiles,
    lastCommit: hash ? { hash, message: message || "" } : null,
    remotes: remoteResult.exitCode === 0 ? parseRemoteLines(remoteResult.stdout) : []
  };
}

export async function createGitBranch(branchName: string, options: { allowDirty?: boolean } = {}) {
  const nextBranch = validateBranchName(branchName);
  const status = await getGitStatus();

  if (!status.isRepo) {
    throw new HttpError(400, "Workspace is not a Git repository");
  }

  if (status.hasChanges && !options.allowDirty) {
    throw new HttpError(409, "Working tree has changes. Commit, stash, or allow dirty branch creation before creating a task branch.");
  }

  await runGit(["switch", "-c", nextBranch]);
  return getGitStatus();
}

export function createSuggestedCommitMessage(options: { userGoal?: string; files: string[] }) {
  const goal = options.userGoal?.trim() || "update workspace files";
  const normalizedGoal = goal.replace(/\s+/g, " ");
  const type = /(fix|bug|error|fail|失败|修复|错误|问题)/i.test(normalizedGoal) ? "fix" : /(refactor|重构)/i.test(normalizedGoal) ? "refactor" : "feat";
  const subject = normalizedGoal.length > 54 ? `${normalizedGoal.slice(0, 51).trim()}...` : normalizedGoal;
  const bodyFiles = options.files.slice(0, 8).map((file) => `- ${file}`).join("\n");

  return [`${type}: ${subject}`, "", bodyFiles ? `Changed files:\n${bodyFiles}` : "Changed files: none"].join("\n");
}

export async function commitGitChanges(files: string[], message: string): Promise<GitCommitResult> {
  const safeFiles = [...new Set(files.map(normalizeWorkspaceFile))];
  const safeMessage = validateCommitMessage(message);

  if (!safeFiles.length) {
    throw new HttpError(400, "At least one file is required");
  }

  const status = await getGitStatus();

  if (!status.isRepo) {
    throw new HttpError(400, "Workspace is not a Git repository");
  }

  await runGit(["add", "--", ...safeFiles]);

  const stagedResult = await runGit(["diff", "--cached", "--quiet"], { allowFailure: true });
  if (stagedResult.exitCode === 0) {
    throw new HttpError(409, "No staged changes found for the selected files");
  }

  await runGit(["commit", "-m", safeMessage]);
  const commitResult = await runGit(["rev-parse", "--short", "HEAD"]);
  const commit: GitCommitInfo = {
    hash: commitResult.stdout,
    message: safeMessage.split(/\r?\n/)[0] || safeMessage
  };

  return { commit, files: safeFiles };
}
