import { useEffect, useMemo, useRef, useState } from "react";
import type { FileTreeNode } from "../api";

type Props = {
  nodes: FileTreeNode[];
  selectedPath: string | null;
  showIgnored: boolean;
  onOpenFile: (path: string) => void;
  onToggleShowIgnored: (showIgnored: boolean) => void;
};

function FileIcon() {
  return (
    <span className="tree-icon file-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M6 3.5h8l4 4v13H6z" />
        <path d="M14 3.5v4h4" />
      </svg>
    </span>
  );
}

function FolderIcon() {
  return (
    <span className="tree-icon folder-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
      </svg>
    </span>
  );
}

function collectFiles(nodes: FileTreeNode[]) {
  const files: FileTreeNode[] = [];

  for (const node of nodes) {
    if (node.type === "file") {
      files.push(node);
      continue;
    }

    files.push(...collectFiles(node.children || []));
  }

  return files;
}

function matchesFileQuery(path: string, query: string) {
  const normalizedPath = path.toLowerCase();
  const parts = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return parts.every((part) => normalizedPath.includes(part));
}

function TreeNode({ node, selectedPath, onOpenFile }: { node: FileTreeNode; selectedPath: string | null; onOpenFile: (path: string) => void }) {
  if (node.type === "directory") {
    return (
      <li>
        <details>
          <summary>
            <FolderIcon />
            <span className="tree-label">{node.name}</span>
          </summary>
          <ul>
            {node.children?.map((child) => (
              <TreeNode key={child.path} node={child} selectedPath={selectedPath} onOpenFile={onOpenFile} />
            ))}
          </ul>
        </details>
      </li>
    );
  }

  return (
    <li>
      <button className={selectedPath === node.path ? "tree-file selected" : "tree-file"} type="button" onClick={() => onOpenFile(node.path)}>
        <FileIcon />
        <span className="tree-label">{node.name}</span>
      </button>
    </li>
  );
}

export default function FileTree({ nodes, selectedPath, showIgnored, onOpenFile, onToggleShowIgnored }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const allFiles = useMemo(() => collectFiles(nodes), [nodes]);
  const searchResults = useMemo(() => {
    const trimmed = query.trim();

    if (!trimmed) return [];

    return allFiles.filter((file) => matchesFileQuery(file.path, trimmed)).slice(0, 80);
  }, [allFiles, query]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isFileSearchShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "p";

      if (!isFileSearchShortcut) return;

      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);

  return (
    <section className="file-tree">
      <div className="file-tree-heading">
        <h2>Files</h2>
        <kbd>Ctrl+P</kbd>
      </div>
      <label className="file-tree-ignored-toggle">
        <input type="checkbox" checked={showIgnored} onChange={(event) => onToggleShowIgnored(event.target.checked)} />
        <span>Show dependencies/generated</span>
      </label>
      <input ref={inputRef} className="file-search-input" value={query} placeholder="Search files" onChange={(event) => setQuery(event.target.value)} />
      {query.trim() ? (
        <div className="file-search-results">
          {searchResults.length > 0 ? (
            searchResults.map((file) => (
              <button key={file.path} className={selectedPath === file.path ? "tree-file selected" : "tree-file"} type="button" onClick={() => onOpenFile(file.path)}>
                <FileIcon />
                <span className="tree-label">{file.path}</span>
              </button>
            ))
          ) : (
            <p>No matching files</p>
          )}
        </div>
      ) : (
        <ul>
          {nodes.map((node) => (
            <TreeNode key={node.path} node={node} selectedPath={selectedPath} onOpenFile={onOpenFile} />
          ))}
        </ul>
      )}
    </section>
  );
}
