import { useState } from "react";
import type { ProjectMemoryItem, UpdateMemoryCandidateInput } from "../../api";
import { MemoryItemEditor } from "./MemoryItemEditor";
import { MemorySourceList } from "./MemorySourceList";
import { kindLabels } from "./memoryViewModel";

type Props = {
  items: ProjectMemoryItem[];
  busy: boolean;
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onUpdate: (id: string, input: UpdateMemoryCandidateInput) => Promise<void>;
};

export function MemoryCandidateList({ items, busy, onAccept, onReject, onUpdate }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <section className="memory-section">
      <div className="memory-section-heading"><div><h3>候选 Memory</h3><p>审核后才会成为长期有效记忆</p></div><span>{items.length} 条</span></div>
      {!items.length ? <div className="memory-empty">暂无待审核候选。</div> : <div className="memory-card-list">{items.map((item) => (
        <article className="memory-card" key={item.id}>
          {editingId === item.id ? <MemoryItemEditor item={item} busy={busy} onCancel={() => setEditingId(null)} onSave={async (input) => { await onUpdate(item.id, input); setEditingId(null); }} /> : <>
            <div className="memory-card-heading"><span>{kindLabels[item.kind]}</span><small>置信度 {Math.round(item.confidence * 100)}%</small></div>
            <strong>{item.content}</strong>
            <p>作用域：{item.scope.type === "project" ? "整个项目" : item.scope.paths.join("、")}</p>
            <MemorySourceList sources={item.sourceRefs} />
            <div className="memory-actions"><button type="button" disabled={busy} onClick={() => setEditingId(item.id)}>编辑</button><button type="button" disabled={busy} onClick={() => void onReject(item.id)}>拒绝</button><button type="button" className="primary" disabled={busy} onClick={() => void onAccept(item.id)}>接受</button></div>
          </>}
        </article>
      ))}</div>}
    </section>
  );
}
