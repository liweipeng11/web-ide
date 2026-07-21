import { useState, type FormEvent } from "react";
import type { ProjectMemoryItem, UpdateMemoryCandidateInput } from "../../api";
import { kindLabels } from "./memoryViewModel";

type Props = {
  item: ProjectMemoryItem;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: UpdateMemoryCandidateInput) => Promise<void>;
};

export function MemoryItemEditor({ item, busy, onCancel, onSave }: Props) {
  const [kind, setKind] = useState(item.kind);
  const [content, setContent] = useState(item.content);
  const [scopeType, setScopeType] = useState(item.scope.type);
  const [paths, setPaths] = useState(item.scope.paths.join("\n"));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedPaths = [...new Set(paths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
    await onSave({ kind, content: content.trim(), scope: scopeType === "path" ? { type: "path", paths: normalizedPaths } : { type: "project", paths: [] } });
  }

  return (
    <form className="memory-item-editor" onSubmit={(event) => void submit(event)}>
      <label>类型<select value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as ProjectMemoryItem["kind"])}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>内容<textarea rows={3} maxLength={2000} required value={content} disabled={busy} onChange={(event) => setContent(event.target.value)} /></label>
      <label>作用域<select value={scopeType} disabled={busy} onChange={(event) => setScopeType(event.target.value as "project" | "path")}><option value="project">整个项目</option><option value="path">指定路径</option></select></label>
      {scopeType === "path" && <label>路径（每行一个）<textarea rows={2} required value={paths} disabled={busy} onChange={(event) => setPaths(event.target.value)} /></label>}
      <div className="memory-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy || !content.trim() || (scopeType === "path" && !paths.trim())}>保存修改</button></div>
      <small>创建来源、系统状态、置信度和审计时间不可手工修改。</small>
    </form>
  );
}
