import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function createTempRepository() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-agent-git-workflow-"));
  const repository = path.join(directory, "repo");
  process.env.STATE_FILE_PATH = path.join(directory, "state.json");

  await fs.mkdir(repository);
  await runGit(repository, ["init"]);
  await runGit(repository, ["config", "user.email", "test@example.com"]);
  await runGit(repository, ["config", "user.name", "Git Workflow Test"]);
  await fs.writeFile(path.join(repository, "README.md"), "before\n", "utf8");
  await runGit(repository, ["add", "README.md"]);
  await runGit(repository, ["commit", "-m", "initial commit"]);

  return repository;
}

test("creates a task branch and commits selected files in an isolated repository", async () => {
  const directory = await createTempRepository();
  const { setWorkspaceRoot } = await import("../workspaceStore.js");
  const { commitGitChanges, createGitBranch, createSuggestedCommitMessage, getGitStatus } = await import("./gitService.js");

  await setWorkspaceRoot(directory, { persist: false });

  const initialStatus = await getGitStatus();
  assert.equal(initialStatus.isRepo, true);
  assert.equal(initialStatus.hasChanges, false);

  const branchStatus = await createGitBranch("agent/test-git-workflow");
  assert.equal(branchStatus.branch, "agent/test-git-workflow");

  await fs.writeFile(path.join(directory, "README.md"), "after\n", "utf8");

  const dirtyStatus = await getGitStatus();
  assert.equal(dirtyStatus.hasChanges, true);
  assert.deepEqual(
    dirtyStatus.changedFiles.map((file) => ({ path: file.path, status: file.status })),
    [{ path: "README.md", status: "modified" }]
  );

  const message = createSuggestedCommitMessage({
    userGoal: "test git workflow commit",
    files: ["README.md"]
  });
  const result = await commitGitChanges(["README.md"], message);

  assert.match(result.commit.hash, /^[0-9a-f]+$/);
  assert.deepEqual(result.files, ["README.md"]);

  const cleanStatus = await getGitStatus();
  assert.equal(cleanStatus.hasChanges, false);
  assert.equal(cleanStatus.lastCommit?.message, "feat: test git workflow commit");
});
