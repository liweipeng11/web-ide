import type { ProjectMemoryItem } from "../../api";

export function MemorySourceList({ sources }: { sources: ProjectMemoryItem["sourceRefs"] }) {
  if (!sources.length) return <p className="memory-empty-inline">未记录来源</p>;
  return (
    <ul className="memory-source-list" aria-label="Memory 来源">
      {sources.map((source, index) => (
        <li key={`${source.type}-${source.value}-${index}`}>
          <span>{source.type}</span>
          <code>{source.filePath || source.value}</code>
          {source.contentHash && <small>hash {source.contentHash.slice(0, 12)}</small>}
        </li>
      ))}
    </ul>
  );
}
