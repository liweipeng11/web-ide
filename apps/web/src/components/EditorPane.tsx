import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import Icon from "./Icon";

type Props = {
  path: string | null;
  value: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onChange: (value: string) => void;
};

function getLanguage(path: string | null) {
  if (!path) return "plaintext";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

export default function EditorPane({ path, value, dirty, saving, onSave, onChange }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor || editor.getValue() === value) return;

    editor.setValue(value);
  }, [value]);

  return (
    <section className="editor-pane">
      <div className="panel-title">
        <div>
          <h2>代码编辑器</h2>
          <span>{path || "请选择文件"}</span>
        </div>
        <div className="editor-actions">
          <span className="save-state">{saving ? "保存中..." : dirty ? "未保存" : "已保存"}</span>
          <button type="button" className="icon-button" disabled={!path || !dirty || saving} title="保存文件 (Ctrl+S)" aria-label="保存文件" onClick={onSave}>
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
