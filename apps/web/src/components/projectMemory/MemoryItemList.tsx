import { useMemo, useState } from "react";
import type { ProjectMemoryItem, PromoteMemoryInput, UpdateMemoryCandidateInput } from "../../api";
import { MemoryItemEditor } from "./MemoryItemEditor";
import { MemoryPromotionDialog } from "./MemoryPromotionDialog";
import { MemorySourceList } from "./MemorySourceList";
import { filterMemoryItems, formatMemoryTime, kindLabels, statusLabels, validationLabels, type MemoryFilters } from "./memoryViewModel";

type Props = {
  items: ProjectMemoryItem[];
  busy: boolean;
  onUpdate: (id: string, input: UpdateMemoryCandidateInput) => Promise<void>;
  onDelete: (ids: string[]) => Promise<void>;
  onPromote: (id: string, input: PromoteMemoryInput) => Promise<void>;
};

const initialFilters: MemoryFilters = { query: "", kind: "all", status: "all", validation: "all" };

export function MemoryItemList({ items, busy, onUpdate, onDelete, onPromote }: Props) {
  const [filters, setFilters] = useState(initialFilters);
  const [selected, setSelected] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const visible = useMemo(() => filterMemoryItems(items, filters), [items, filters]);
  const promotingItem = items.find((item) => item.id === promotingId);

  return (
    <section className="memory-section">
      <div className="memory-section-heading"><div><h3>Memory 管理</h3><p>搜索、筛选、修订与清理长期记忆</p></div><span>{visible.length} / {items.length}</span></div>
      <div className="memory-filters">
        <input type="search" placeholder="搜索内容、路径或来源" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
        <select value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value as MemoryFilters["kind"] })}><option value="all">全部类型</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as MemoryFilters["status"] })}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={filters.validation} onChange={(event) => setFilters({ ...filters, validation: event.target.value as MemoryFilters["validation"] })}><option value="all">全部验证状态</option>{Object.entries(validationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      {selected.length > 0 && <div className="memory-bulk-bar"><span>已选择 {selected.length} 条</span><button type="button" className="danger" disabled={busy} onClick={() => void onDelete(selected).then(() => setSelected([]))}>批量删除</button></div>}
      {!visible.length ? <div className="memory-empty">没有符合当前筛选条件的 Memory。</div> : <div className="memory-card-list">{visible.map((item) => (
        <article className={`memory-card validation-${item.validationStatus}`} key={item.id}>
          {editingId === item.id ? <MemoryItemEditor item={item} busy={busy} onCancel={() => setEditingId(null)} onSave={async (input) => { await onUpdate(item.id, input); setEditingId(null); }} /> : <>
            <div className="memory-card-heading"><label className="memory-check"><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />选择</label><span>{kindLabels[item.kind]} · {statusLabels[item.status]}</span><small>{validationLabels[item.validationStatus]}</small></div>
            <strong>{item.content}</strong>
            <p>作用域：{item.scope.type === "project" ? "整个项目" : item.scope.paths.join("、")}</p>
            <p>最近验证：{formatMemoryTime(item.lastValidatedAt)} · 最近使用：{formatMemoryTime(item.lastUsedAt)}</p>
            {item.promotedTo && <p className="memory-promoted">已提升至 {item.promotedTo.rulePath}，不再重复注入 Memory Prompt</p>}
            <MemorySourceList sources={item.sourceRefs} />
            <div className="memory-actions">{item.status === "active" && <button type="button" disabled={busy} onClick={() => setEditingId(item.id)}>编辑</button>}<button type="button" className="danger-text" disabled={busy} onClick={() => void onDelete([item.id])}>删除</button>{item.status === "active" && !item.promotedTo && <button type="button" className="primary" disabled={busy} onClick={() => setPromotingId(item.id)}>提升为 Rule</button>}</div>
          </>}
          {promotingItem?.id === item.id && <MemoryPromotionDialog item={item} busy={busy} onCancel={() => setPromotingId(null)} onConfirm={async (input) => { await onPromote(item.id, input); setPromotingId(null); }} />}
        </article>
      ))}</div>}
    </section>
  );
}
