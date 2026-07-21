import { useEffect, useState } from "react";
import {
  acceptMemoryCandidate,
  deleteMemoryItems,
  fetchMemoryUsage,
  fetchProjectMemory,
  promoteMemoryItem,
  refreshProjectMemory,
  rejectMemoryCandidate,
  updateMemoryCandidate,
  updateMemoryItem,
  updateProjectMemory,
  type MemoryUsageRecord,
  type ProjectMemory,
  type PromoteMemoryInput,
  type UpdateMemoryCandidateInput,
  type UpdateProjectMemoryInput
} from "../api";
import { MemoryCandidateList } from "./projectMemory/MemoryCandidateList";
import { MemoryItemList } from "./projectMemory/MemoryItemList";
import { MemoryUsagePanel } from "./projectMemory/MemoryUsagePanel";
import { ProjectSnapshotSection } from "./projectMemory/ProjectSnapshotSection";
import { formatMemoryTime } from "./projectMemory/memoryViewModel";

type Props = { disabled: boolean; workspaceRoot: string };
type MemoryDraft = { projectSummary: string; currentGoals: string; confirmedRisks: string };
const emptyDraft: MemoryDraft = { projectSummary: "", currentGoals: "", confirmedRisks: "" };

function createDraft(memory: ProjectMemory): MemoryDraft {
  return { projectSummary: memory.snapshot.projectSummary, currentGoals: memory.snapshot.currentGoals.join("\n"), confirmedRisks: memory.snapshot.confirmedRisks.join("\n") };
}

export default function ProjectMemoryPanel({ disabled, workspaceRoot }: Props) {
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [usage, setUsage] = useState<MemoryUsageRecord[]>([]);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load(refreshAnalysis = false) {
    if (disabled) return;
    setLoading(true);
    setError("");
    try {
      const [memoryResult, usageResult] = await Promise.all([refreshAnalysis ? refreshProjectMemory() : fetchProjectMemory(), fetchMemoryUsage(10)]);
      setMemory(memoryResult.memory);
      setDraft(createDraft(memoryResult.memory));
      setUsage(usageResult.records);
      if (refreshAnalysis) setMessage("项目画像已重新扫描；手工简介和 Memory 未被覆盖。");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载 Project Memory 失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setMemory(null); setUsage([]); setDraft(emptyDraft); setError(""); setMessage("");
    if (!disabled) void load();
    // 工作区切换时必须丢弃上一项目的管理状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, workspaceRoot]);

  async function runMutation(action: () => Promise<unknown>, successMessage: string) {
    if (loading) return;
    setLoading(true); setError(""); setMessage("");
    try {
      await action();
      const [memoryResult, usageResult] = await Promise.all([fetchProjectMemory(), fetchMemoryUsage(10)]);
      setMemory(memoryResult.memory); setDraft(createDraft(memoryResult.memory)); setUsage(usageResult.records); setMessage(successMessage);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "操作失败");
      throw mutationError;
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(ids: string[]) {
    if (!window.confirm(`确认永久删除选中的 ${ids.length} 条 Memory？此操作不会删除已生成的 Project Rule。`)) return;
    await runMutation(() => deleteMemoryItems(ids), `已删除 ${ids.length} 条 Memory。`);
  }

  const candidates = memory?.items.filter((item) => item.status === "candidate") || [];
  const managedItems = memory?.items.filter((item) => item.status !== "candidate") || [];

  return (
    <section className="project-memory-panel settings-memory-panel">
      <div className="project-memory-heading"><div><h2>Project Snapshot & Memory</h2><p>{disabled ? "请先打开工作区" : memory ? `Schema V${memory.schemaVersion} · 更新于 ${formatMemoryTime(memory.updatedAt)}` : "正在读取项目上下文"}</p></div><button type="button" disabled={disabled || loading} onClick={() => void load(true)}>重新扫描</button></div>
      {disabled ? <div className="memory-state">打开工作区后才能查看和管理 Project Memory。</div> : error && !memory ? <div className="memory-state error"><strong>Project Memory 无法加载</strong><p>{error}</p><button type="button" disabled={loading} onClick={() => void load()}>重试</button></div> : !memory ? <div className="memory-state">正在加载 Project Memory…</div> : <div className="project-memory-scroll">
        {(error || message) && <div className={`project-memory-message ${error ? "error" : "success"}`} role="status">{error || message}</div>}
        <ProjectSnapshotSection memory={memory} draft={draft} busy={loading} onDraftChange={setDraft} onSave={(input: UpdateProjectMemoryInput) => {
          // 只在简介确实变更时提交该字段，避免仅保存目标就把自动摘要冻结为手工内容。
          if (input.projectSummary === memory.snapshot.projectSummary) delete input.projectSummary;
          return runMutation(() => updateProjectMemory(input), "Project Snapshot 已保存。");
        }} />
        <MemoryCandidateList items={candidates} busy={loading} onAccept={(id) => runMutation(() => acceptMemoryCandidate(id), "候选 Memory 已接受并转为有效。") } onReject={async (id) => { if (window.confirm("确认拒绝这条候选 Memory？拒绝记录会保留用于审计。")) await runMutation(() => rejectMemoryCandidate(id), "候选 Memory 已拒绝。"); }} onUpdate={(id, input: UpdateMemoryCandidateInput) => runMutation(() => updateMemoryCandidate(id, input), "候选 Memory 已更新。") } />
        <MemoryItemList items={managedItems} busy={loading} onUpdate={(id, input) => runMutation(() => updateMemoryItem(id, input), "Memory 已更新并等待重新验证。") } onDelete={handleDelete} onPromote={(id, input: PromoteMemoryInput) => runMutation(() => promoteMemoryItem(id, input), "Memory 已提升为 Project Rule，后续不会重复注入。") } />
        <MemoryUsagePanel records={usage} />
      </div>}
    </section>
  );
}
