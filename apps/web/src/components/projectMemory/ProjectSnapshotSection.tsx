import type { ProjectMemory, UpdateProjectMemoryInput } from "../../api";

type Props = {
  memory: ProjectMemory;
  draft: { projectSummary: string; currentGoals: string; confirmedRisks: string };
  busy: boolean;
  onDraftChange: (draft: Props["draft"]) => void;
  onSave: (input: UpdateProjectMemoryInput) => Promise<void>;
};

function parseLines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

export function ProjectSnapshotSection({ memory, draft, busy, onDraftChange, onSave }: Props) {
  const snapshot = memory.snapshot;
  const stack = [snapshot.techStack.packageManager, ...snapshot.techStack.languages, ...snapshot.techStack.frameworks, ...snapshot.techStack.buildTools].filter(Boolean) as string[];
  return (
    <section className="memory-section">
      <div className="memory-section-heading"><div><h3>Project Snapshot</h3><p>当前工作区画像与任务事实</p></div><span>{snapshot.projectSummarySource === "manual" ? "手工维护" : "扫描生成"}</span></div>
      <div className="project-memory-stack">{stack.length ? stack.map((item) => <span key={item}>{item}</span>) : <small>暂未识别技术栈</small>}</div>
      <label>项目简介<textarea rows={3} value={draft.projectSummary} disabled={busy} onChange={(event) => onDraftChange({ ...draft, projectSummary: event.target.value })} /><small>{snapshot.projectSummarySource === "manual" ? "重新扫描不会覆盖手工简介" : "修改后将切换为手工维护"}</small></label>
      <div className="memory-two-columns">
        <label>当前阶段目标<textarea rows={4} placeholder="每行一个目标" value={draft.currentGoals} disabled={busy} onChange={(event) => onDraftChange({ ...draft, currentGoals: event.target.value })} /></label>
        <label>已确认风险<textarea rows={4} placeholder="每行一条风险" value={draft.confirmedRisks} disabled={busy} onChange={(event) => onDraftChange({ ...draft, confirmedRisks: event.target.value })} /></label>
      </div>
      <button type="button" className="project-memory-save" disabled={busy} onClick={() => void onSave({ projectSummary: draft.projectSummary.trim(), currentGoals: parseLines(draft.currentGoals), confirmedRisks: parseLines(draft.confirmedRisks) })}>保存 Snapshot</button>
      <div className="memory-snapshot-facts">
        <div><strong>最近改动</strong>{snapshot.recentChanges.length ? snapshot.recentChanges.slice(0, 5).map((change) => <p key={change.taskSessionId}>{change.summary}<small>{change.files.join("、") || "未记录文件"}</small></p>) : <p>暂无已同步改动</p>}</div>
        <div><strong>未完成事项</strong>{snapshot.pendingItems.length ? snapshot.pendingItems.slice(0, 5).map((item) => <p key={item.taskSessionId}>{item.summary}<small>{item.status}</small></p>) : <p>暂无未完成事项</p>}</div>
      </div>
    </section>
  );
}
