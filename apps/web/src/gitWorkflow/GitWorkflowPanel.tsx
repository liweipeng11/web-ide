import { useEffect, useMemo, useState } from "react";
import type { TaskSession } from "../api";
import Icon from "../components/Icon";
import { commitGitChanges, createGitBranch, fetchGitStatus, generateCommitMessage } from "./api";
import type { GitChangedFile, GitStatus } from "./types";

type Props = {
  disabled: boolean;
  taskSessionId?: string | null;
  taskSessions: TaskSession[];
  onRefreshTaskSessions: () => Promise<void>;
};

const statusText: Record<GitChangedFile["status"], string> = {
  added: "新增",
  conflicted: "冲突",
  deleted: "删除",
  modified: "修改",
  renamed: "重命名",
  unknown: "未知",
  untracked: "未跟踪"
};

function makeBranchName(session?: TaskSession | null) {
  const raw = session?.userGoal || session?.id || "task";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);

  return `agent/${slug || "task"}`;
}

function getTaskFiles(session?: TaskSession | null) {
  return session?.filesChanged || [];
}

export default function GitWorkflowPanel({ disabled, taskSessionId, taskSessions, onRefreshTaskSessions }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branchName, setBranchName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const currentSession = useMemo(() => taskSessions.find((session) => session.id === taskSessionId) || null, [taskSessionId, taskSessions]);
  const taskFiles = useMemo(() => getTaskFiles(currentSession), [currentSession]);
  const commitFiles = taskFiles.length ? taskFiles : status?.changedFiles.map((file) => file.path) || [];

  async function refresh() {
    if (disabled) return;

    setBusy(true);
    setError(null);

    try {
      const data = await fetchGitStatus();
      setStatus(data.status);
      setBranchName((current) => current || makeBranchName(currentSession));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "加载 Git 状态失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [disabled]);

  useEffect(() => {
    setBranchName(makeBranchName(currentSession));
    setMessage("");
  }, [currentSession?.id]);

  async function handleCreateBranch() {
    if (!branchName.trim()) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const allowDirty = Boolean(status?.hasChanges && window.confirm("当前工作区有未提交变更。仍要基于当前状态创建任务分支吗？"));
      if (status?.hasChanges && !allowDirty) return;

      const data = await createGitBranch(branchName.trim(), allowDirty);
      setStatus(data.status);
      setNotice(`已切换到 ${data.status.branch || branchName.trim()}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "创建分支失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateMessage() {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const data = await generateCommitMessage(taskSessionId, commitFiles);
      setMessage(data.message);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "生成提交信息失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!message.trim()) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await commitGitChanges(message, taskSessionId, commitFiles);
      const data = await fetchGitStatus();
      setStatus(data.status);
      setNotice(`已提交 ${result.commit.hash}: ${result.commit.message}`);
      await onRefreshTaskSessions();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="git-workflow">
      <div className="git-workflow-heading">
        <div>
          <h2>Git 工作流</h2>
          <span>{status?.isRepo ? status.branch || "detached HEAD" : "未检测到仓库"}</span>
        </div>
        <button type="button" className="icon-button" disabled={disabled || busy} title="刷新 Git 状态" aria-label="刷新 Git 状态" onClick={() => void refresh()}>
          <Icon name="history" />
        </button>
      </div>

      {error && <p className="git-workflow-error">{error}</p>}
      {notice && <p className="git-workflow-notice">{notice}</p>}

      {!status?.isRepo ? (
        <p className="git-workflow-empty">{disabled ? "打开工作区后可使用 Git 工作流。" : "当前工作区不是 Git 仓库。"}</p>
      ) : (
        <>
          <section className="git-workflow-card">
            <h3>状态</h3>
            <dl>
              <div>
                <dt>当前分支</dt>
                <dd>{status.branch || "detached HEAD"}</dd>
              </div>
              <div>
                <dt>变更文件</dt>
                <dd>{status.changedFiles.length}</dd>
              </div>
              <div>
                <dt>最近提交</dt>
                <dd>{status.lastCommit ? `${status.lastCommit.hash} ${status.lastCommit.message}` : "无"}</dd>
              </div>
            </dl>
          </section>

          <section className="git-workflow-card">
            <h3>任务分支</h3>
            <div className="git-workflow-form">
              <input value={branchName} disabled={busy} onChange={(event) => setBranchName(event.target.value)} />
              <button type="button" disabled={busy || !branchName.trim()} onClick={() => void handleCreateBranch()}>
                创建
              </button>
            </div>
          </section>

          <section className="git-workflow-card">
            <h3>本次提交文件</h3>
            <ul className="git-workflow-files">
              {commitFiles.length ? (
                commitFiles.map((file) => {
                  const changedFile = status.changedFiles.find((item) => item.path === file);
                  return (
                    <li key={file}>
                      <span>{changedFile ? statusText[changedFile.status] : "任务"}</span>
                      <code>{file}</code>
                    </li>
                  );
                })
              ) : (
                <li className="git-workflow-muted">暂无可提交文件</li>
              )}
            </ul>
          </section>

          <section className="git-workflow-card">
            <h3>Commit</h3>
            <textarea value={message} disabled={busy} rows={6} placeholder="生成或输入提交信息" onChange={(event) => setMessage(event.target.value)} />
            <div className="git-workflow-actions">
              <button type="button" disabled={busy || !commitFiles.length} onClick={() => void handleGenerateMessage()}>
                生成信息
              </button>
              <button type="button" disabled={busy || !message.trim() || !commitFiles.length} onClick={() => void handleCommit()}>
                提交
              </button>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
