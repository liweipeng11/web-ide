import { useState } from "react";
import type { MemoryUsageRecord } from "../../api";
import { explainRetrievalReason, formatMemoryTime, validationLabels } from "./memoryViewModel";

export function MemoryUsagePanel({ records }: { records: MemoryUsageRecord[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(records[0]?.id || null);
  const selected = records.find((record) => record.id === selectedId) || records[0];
  return (
    <section className="memory-section">
      <div className="memory-section-heading"><div><h3>本轮召回解释</h3><p>展示模型调用实际考虑了哪些 Memory，以及最终是否进入 Prompt</p></div><span>{records.length} 轮</span></div>
      {!records.length ? <div className="memory-empty">暂无召回记录。完成一次包含相关 Memory 的 AI 请求后会显示在这里。</div> : <>
        <div className="memory-usage-tabs">{records.map((record, index) => <button type="button" className={(selected?.id === record.id) ? "active" : ""} key={record.id} onClick={() => setSelectedId(record.id)}>{index === 0 ? "最近一轮" : formatMemoryTime(record.createdAt)}</button>)}</div>
        {selected && <div className="memory-usage-summary"><strong>{selected.requestSummary || "未记录请求摘要"}</strong><p>{selected.contextPaths.join("、") || "无路径上下文"}</p><small>估算 {selected.estimatedTokens} / {selected.tokenBudget} tokens</small></div>}
        <div className="memory-card-list">{selected?.entries.length ? selected.entries.map((entry) => (
          <article className="memory-card" key={entry.itemId}>
            <div className="memory-card-heading"><span className={entry.includedInPrompt ? "included" : "excluded"}>{entry.includedInPrompt ? "已进入最终 Prompt" : "未进入最终 Prompt"}</span><small>相关性 {entry.score ?? "-"} · {validationLabels[entry.validationStatus]}</small></div>
            <strong>{entry.contentPreview}</strong>
            <div className="memory-reasons">{entry.reasons.map((reason) => <span key={reason}>{explainRetrievalReason(reason)}</span>)}</div>
            {!entry.includedInPrompt && <p>未进入原因：{entry.exclusionReason === "item_limit" ? "超过条目上限" : "超出 Token 预算"}</p>}
            <small>来源类型：{entry.sourceTypes.join("、") || "未记录"}</small>
          </article>
        )) : <div className="memory-empty">本轮没有相关 Memory 进入排序。</div>}</div>
      </>}
    </section>
  );
}
