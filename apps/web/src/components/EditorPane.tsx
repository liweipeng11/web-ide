import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { OpenFileTab } from "../appState";
import Icon from "./Icon";

type Props = {
  path: string | null;
  tabs: OpenFileTab[];
  value: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onChange: (value: string) => void;
};

function getLanguage(path: string | null) {
  if (!path) return "plaintext";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".vue") || path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function getFileBadge(path: string) {
  const extension = getFileName(path).split(".").pop();
  return extension ? extension.slice(0, 3).toUpperCase() : "TXT";
}

function getPathParts(path: string | null) {
  return path ? path.split(/[\\/]/).filter(Boolean) : [];
}

export default function EditorPane({ path, tabs, value, dirty, saving, onSave, onSelectTab, onCloseTab, onChange }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const pathParts = getPathParts(path);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor || editor.getValue() === value) return;

    editor.setValue(value);
  }, [value]);

  return (
    <section className="editor-pane">
      <div className="editor-tabbar" role="tablist" aria-label="Open files">
        {tabs.length ? (
          tabs.map((tab) => {
            const tabDirty = tab.content !== tab.savedContent;
            const active = tab.path === path;

            return (
              <button key={tab.path} type="button" role="tab" aria-selected={active} className={active ? "editor-tab active" : "editor-tab"} title={tab.path} onClick={() => onSelectTab(tab.path)}>
                <span className="editor-tab-badge">{getFileBadge(tab.path)}</span>
                <span className="editor-tab-name">{getFileName(tab.path)}</span>
                {tabDirty ? <span className="editor-tab-dirty" aria-label="Unsaved changes" /> : null}
                <span
                  className="editor-tab-close"
                  role="button"
                  tabIndex={0}
                  title="Close"
                  aria-label={`Close ${getFileName(tab.path)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.path);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseTab(tab.path);
                  }}
                >
                  <Icon name="close" />
                </span>
              </button>
            );
          })
        ) : (
          <span className="editor-empty-tab">No file open</span>
        )}
      </div>
      <div className="editor-pathbar">
        <div className="editor-breadcrumb" title={path || ""}>
          {pathParts.length ? (
            pathParts.map((part, index) => (
              <span className={index === pathParts.length - 1 ? "current" : ""} key={`${part}-${index}`}>
                {part}
              </span>
            ))
          ) : (
            <span>Select a file</span>
          )}
        </div>
        <div className="editor-actions">
          <span className="save-state">{saving ? "Saving..." : dirty ? "Unsaved" : "Saved"}</span>
          <button type="button" className="icon-button" disabled={!path || !dirty || saving} title="Save file (Ctrl+S)" aria-label="Save file" onClick={onSave}>
            <Icon name="save" />
          </button>
        </div>
      </div>
      <Editor
        height="100%"
        language={getLanguage(path)}
        path={path || "empty.txt"}
        value={value}
        onMount={(editor) => {
          editorRef.current = editor;
        }}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          wordWrap: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true
        }}
      />
    </section>
  );
}
