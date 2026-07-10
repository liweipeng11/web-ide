import { useEffect, useMemo, useRef, useState } from "react";
import { searchCode, searchFilesByName, type CodeSearchMode, type CodeSearchResult, type FileNameSearchResult } from "../api";
import Icon from "./Icon";

type Props = {
  disabled: boolean;
  onOpenFile: (path: string) => void;
};

type SearchPanelMode = "fileName" | CodeSearchMode;

const searchModes: Array<{ value: SearchPanelMode; label: string }> = [
  { value: "fileName", label: "文件名" },
  { value: "literal", label: "文本" },
  { value: "regex", label: "正则" }
];

function getMatchedByText(matchedBy: FileNameSearchResult["matchedBy"]) {
  if (matchedBy === "extension") return "扩展名";
  if (matchedBy === "path") return "路径";
  return "名称";
}

export default function CodeSearchPanel({ disabled, onOpenFile }: Props) {
  const [mode, setMode] = useState<SearchPanelMode>("literal");
  const [query, setQuery] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [filePattern, setFilePattern] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [codeResults, setCodeResults] = useState<CodeSearchResult[]>([]);
  const [fileResults, setFileResults] = useState<FileNameSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmedQuery = query.trim();

  const resultCount = useMemo(() => (mode === "fileName" ? fileResults.length : codeResults.length), [codeResults.length, fileResults.length, mode]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function runSearch(nextQuery = query) {
    const nextTrimmedQuery = nextQuery.trim();

    if (!nextTrimmedQuery || disabled) {
      setCodeResults([]);
      setFileResults([]);
      return;
    }

    setSearching(true);
    setError(null);

    try {
      if (mode === "fileName") {
        // 文件名模式只查询路径索引，避免为了定位文件而触发正文搜索。
        const data = await searchFilesByName(nextTrimmedQuery, {
          path: pathFilter,
          limit: 80
        });
        setFileResults(data.results);
        setCodeResults([]);
      } else {
        const data = await searchCode(nextTrimmedQuery, {
          mode,
          path: pathFilter,
          filePattern,
          caseSensitive,
          limit: 80,
          contextLines: 1
        });
        setCodeResults(data.results);
        setFileResults([]);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "搜索失败");
      setCodeResults([]);
      setFileResults([]);
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isSearchShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f";

      if (!isSearchShortcut) return;

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
    <section className="code-search">
      <div className="code-search-heading">
        <h2>代码搜索</h2>
        <kbd>Ctrl+Shift+F</kbd>
      </div>
      <div className="code-search-mode-group" role="radiogroup" aria-label="搜索模式">
        {searchModes.map((item) => (
          <button key={item.value} type="button" className={mode === item.value ? "active" : ""} disabled={disabled || searching} onClick={() => setMode(item.value)} aria-pressed={mode === item.value}>
            {item.label}
          </button>
        ))}
      </div>
      <form
        className="code-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <input ref={inputRef} value={query} disabled={disabled} placeholder={mode === "regex" ? "输入正则表达式" : mode === "fileName" ? "搜索文件名、扩展名或路径" : "搜索代码文本"} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="icon-button" disabled={disabled || searching || !trimmedQuery} title="搜索" aria-label="搜索">
          <Icon name="search" />
        </button>
      </form>
      <div className="code-search-filters">
        <input value={pathFilter} disabled={disabled || searching} placeholder="路径范围，例如 apps/web/src" onChange={(event) => setPathFilter(event.target.value)} />
        {mode !== "fileName" && <input value={filePattern} disabled={disabled || searching} placeholder="file pattern，例如 *.tsx" onChange={(event) => setFilePattern(event.target.value)} />}
        {mode !== "fileName" && (
          <label>
            <input type="checkbox" checked={caseSensitive} disabled={disabled || searching} onChange={(event) => setCaseSensitive(event.target.checked)} />
            区分大小写
          </label>
        )}
      </div>
      {searching && <p className="code-search-message">搜索中...</p>}
      {error && <p className="code-search-message">{error}</p>}
      {!error && trimmedQuery && !searching && resultCount === 0 && <p className="code-search-message">无结果</p>}
      {mode === "fileName" && fileResults.length > 0 && (
        <div className="code-search-results">
          {fileResults.map((result) => (
            <button key={result.path} type="button" onClick={() => result.type === "file" && onOpenFile(result.path)} disabled={result.type !== "file"}>
              <strong>{result.path}</strong>
              <span>
                {result.type === "directory" ? "目录" : "文件"} / {getMatchedByText(result.matchedBy)} / score {result.score}
              </span>
            </button>
          ))}
        </div>
      )}
      {mode !== "fileName" && codeResults.length > 0 && (
        <div className="code-search-results">
          {codeResults.map((result) => (
            <button key={`${result.filePath}:${result.line}:${result.column}`} type="button" onClick={() => onOpenFile(result.filePath)}>
              <strong>{result.filePath}</strong>
              <span>
                {result.line}:{result.column}
              </span>
              {result.contextBefore?.map((line) => (
                <code key={`${result.filePath}:${line.line}:before`} className="context-line">
                  {line.line}: {line.content}
                </code>
              ))}
              <code>
                {result.line}: {result.content}
              </code>
              {result.contextAfter?.map((line) => (
                <code key={`${result.filePath}:${line.line}:after`} className="context-line">
                  {line.line}: {line.content}
                </code>
              ))}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
