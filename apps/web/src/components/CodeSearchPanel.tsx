import { useEffect, useRef, useState } from "react";
import { searchCode, type CodeSearchResult } from "../api";
import Icon from "./Icon";

type Props = {
  disabled: boolean;
  onOpenFile: (path: string) => void;
};

export default function CodeSearchPanel({ disabled, onOpenFile }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function runSearch(nextQuery = query) {
    const trimmed = nextQuery.trim();

    if (!trimmed || disabled) {
      setResults([]);
      return;
    }

    setSearching(true);
    setError(null);

    try {
      const data = await searchCode(trimmed);
      setResults(data.results);
    } catch (error) {
      setError(error instanceof Error ? error.message : "搜索失败");
      setResults([]);
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
      <form
        className="code-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <input ref={inputRef} value={query} disabled={disabled} placeholder="搜索代码" onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="icon-button" disabled={disabled || searching || !query.trim()} title="搜索" aria-label="搜索">
          <Icon name="search" />
        </button>
      </form>
      {error && <p className="code-search-message">{error}</p>}
      {!error && query.trim() && !searching && results.length === 0 && <p className="code-search-message">无结果</p>}
      {results.length > 0 && (
        <div className="code-search-results">
          {results.map((result) => (
            <button key={`${result.filePath}:${result.line}:${result.column}`} type="button" onClick={() => onOpenFile(result.filePath)}>
              <strong>{result.filePath}</strong>
              <span>
                {result.line}:{result.column}
              </span>
              <code>{result.content}</code>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
