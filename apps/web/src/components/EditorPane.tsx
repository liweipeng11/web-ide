import Editor from "@monaco-editor/react";

type Props = {
  path: string | null;
  value: string;
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

export default function EditorPane({ path, value, onChange }: Props) {
  return (
    <section className="editor-pane">
      <div className="panel-title">
        <h2>代码编辑器</h2>
        <span>{path || "请选择文件"}</span>
      </div>
      <Editor
        height="100%"
        language={getLanguage(path)}
        path={path || "empty.txt"}
        value={value}
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
