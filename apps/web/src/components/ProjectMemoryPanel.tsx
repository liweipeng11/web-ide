import { useEffect, useState } from "react";
import { fetchProjectMemory, refreshProjectMemory, updateProjectMemory, type ProjectMemory, type UpdateProjectMemoryInput } from "../api";

type Props = {
  disabled: boolean;
  workspaceRoot: string;
};

type MemoryDraft = {
  projectSummary: string;
  currentGoals: string;
  confirmedRisks: string;
};

const emptyDraft: MemoryDraft = { projectSummary: "", currentGoals: "", confirmedRisks: "" };

function toLines(values: string[]) {
  return values.join("\n");
}

function parseLines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function createDraft(memory: ProjectMemory): MemoryDraft {
  return {
    projectSummary: memory.snapshot.projectSummary,
    currentGoals: toLines(memory.snapshot.currentGoals),
    confirmedRisks: toLines(memory.snapshot.confirmedRisks)
  };
}

function formatTime(value: number) {
  return new Date(value).toLocaleString();
}

export default function ProjectMemoryPanel({ disabled, workspaceRoot }: Props) {
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadMemory(refreshAnalysis = false) {
    if (disabled || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const result = refreshAnalysis ? await refreshProjectMemory() : await fetchProjectMemory();
      setMemory(result.memory);
      setDraft(createDraft(result.memory));
      setMessage(refreshAnalysis ? "项目技术栈已重新扫描。" : "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载 Project Memory 失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setMemory(null);
    setDraft(emptyDraft);
    setMessage("");
    if (!disabled) void loadMemory();
    // 工作区切换时必须重新读取对应项目的数据。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, workspaceRoot]);

  async function handleSave() {
    if (disabled || loading) return;
    setLoading(true);
    setMessage("");
    try {
      const input: UpdateProjectMemoryInput = {
        currentGoals: parseLines(draft.currentGoals),
        confirmedRisks: parseLines(draft.confirmedRisks)
      };
      // 只有用户真正改动简介时才切换为 manual，保存其他字段不会冻结自动摘要。
      if (draft.projectSummary.trim() !== memory?.snapshot.projectSummary) input.projectSummary = draft.projectSummary.trim();
      const result = await updateProjectMemory(input);
      setMemory(result.memory);
      setDraft(createDraft(result.memory));
      setMessage("Project Snapshot 已保存。重启或新建聊天后仍会生效。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存 Project Snapshot 失败");
    } finally {
      setLoading(false);
    }
  }

  const snapshot = memory?.snapshot;
  const stackItems = snapshot
    ? [snapshot.techStack.packageManager, ...snapshot.techStack.languages, ...snapshot.techStack.frameworks, ...snapshot.techStack.buildTools].filter((item): item is string => Boolean(item))
    : [];
  const candidates = memory?.items.filter((item) => item.status === "candidate") || [];

  return (
    <section className="project-memory-panel settings-memory-panel">
      <div className="project-memory-heading">
        <div>
          <h2>Project Snapshot & Memory</h2>
          <p>{disabled ? "请先打开工作区" : memory ? `Schema V${memory.schemaVersion}，更新于 ${formatTime(memory.updatedAt)}` : "正在读取项目上下文"}</p>
        </div>
        <button type="button" disabled={disabled || loading} onClick={() => void loadMemory(true)}>重新扫描</button>
      </div>

      {!disabled && (
        <div className="project-memory-scroll">
          <div className="project-memory-stack" aria-label="技术栈">
            {stackItems.map((item) => <span key={item}>{item}</span>)}
          </div>

          <label>
            <span>项目简介</span>
            <textarea rows={4} value={draft.projectSummary} disabled={loading} onChange={(event) => setDraft((current) => ({ ...current, projectSummary: event.target.value }))} />
            <small>{snapshot?.projectSummarySource === "manual" ? "手工维护，重新扫描不会覆盖" : "由项目扫描器生成"}</small>
          </label>

          <label>
            <span>当前阶段目标</span>
            <textarea rows={4} value={draft.currentGoals} disabled={loading} placeholder="每行一个目标" onChange={(event) => setDraft((current) => ({ ...current, currentGoals: event.target.value }))} />
          </label>

          <label>
            <span>已确认风险</span>
            <textarea rows={4} value={draft.confirmedRisks} disabled={loading} placeholder="每行一条风险" onChange={(event) => setDraft((current) => ({ ...current, confirmedRisks: event.target.value }))} />
          </label>

          <button type="button" className="project-memory-save" disabled={loading} onClick={() => void handleSave()}>保存 Project Snapshot</button>
          {message && <p className="project-memory-message">{message}</p>}

          <div className="project-memory-facts">
            <h3>候选 Memory</h3>
            {candidates.length ? (
              <>
                <p>以下历史约定尚未成为可信规则。请在 Agent Rules 中核对后手工提升，未确认前仅作为背景。</p>
                {candidates.map((item) => (
                  <article key={item.id}>
                    <strong>{item.content}</strong>
                    <span>{item.kind} · {item.createdBy === "migration" ? "由旧版约定迁移" : "待确认"}</span>
                  </article>
                ))}
              </>
            ) : <p>暂无待确认的候选 Memory。</p>}

            <h3>最近改动</h3>
            {snapshot?.recentChanges.length ? snapshot.recentChanges.map((change) => (
              <article key={change.taskSessionId}>
                <strong>{change.summary}</strong>
                <span>{change.files.join("、") || "未记录文件"}</span>
              </article>
            )) : <p>暂无已同步改动。</p>}

            <h3>未完成事项</h3>
            {snapshot?.pendingItems.length ? snapshot.pendingItems.map((item) => (
              <article key={item.taskSessionId}>
                <strong>{item.summary}</strong>
                <span>{item.status} · {formatTime(item.updatedAt)}</span>
              </article>
            )) : <p>暂无未完成事项。</p>}
          </div>
        </div>
      )}
    </section>
  );
}
