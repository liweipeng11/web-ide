import type { AgentToolDefinition } from "./agentToolTypes.js";
import type { SourceLocation, UnifiedDiagnostic } from "./contracts/languageService.js";
import { languageServiceGateway } from "./languageService/index.js";
import { listWorkspaceFiles } from "./codeDiscovery/index.js";

function location(args: Record<string, unknown>): SourceLocation {
  const filePath = typeof args.filePath === "string" ? args.filePath.trim() : "";
  const line = Number(args.line);
  const column = Number(args.column);
  if (!filePath || !Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) throw new Error("filePath, line and column are required");
  return { filePath, line, column };
}

const locationProperties = {
  filePath: { type: "string", description: "Workspace-relative source file." },
  line: { type: "integer", minimum: 1, description: "One-based line." },
  column: { type: "integer", minimum: 1, description: "One-based column." }
};

/** 语言服务工具全部只读；重命名继续由 Patch/Checkpoint 写入链路负责。 */
export const languageServiceAgentToolDefinitions: AgentToolDefinition[] = [
  {
    name: "getDiagnostics",
    description: "Get current LSP diagnostics for one file or the workspace. Results include source and document version.",
    cacheable: false,
    parameters: { type: "object", properties: { filePath: { type: "string" } }, additionalProperties: false },
    async execute(args) {
      if (typeof args.filePath === "string" && args.filePath.trim()) return languageServiceGateway.getDiagnostics(args.filePath.trim());
      const entries = await listWorkspaceFiles("", { recursive: true, limit: 300 });
      const paths = entries.filter((entry) => entry.type === "file" && /\.(?:[cm]?[jt]sx?|vue|pyi?)$/i.test(entry.path)).slice(0, 40).map((entry) => entry.path);
      const diagnostics: UnifiedDiagnostic[] = [];
      // 有界并发避免大型工作区一次启动过多文档诊断。
      for (let index = 0; index < paths.length; index += 4) {
        const batch = await Promise.all(paths.slice(index, index + 4).map((filePath) => languageServiceGateway.getDiagnostics(filePath)));
        diagnostics.push(...batch.flat());
      }
      return diagnostics;
    },
    summarize(result) { return { diagnosticCount: Array.isArray(result) ? result.length : 0 }; }
  },
  ...(["findDefinition", "findReferences", "getHoverInfo"] as const).map((name): AgentToolDefinition => ({
    name,
    description: name === "findDefinition" ? "Find definitions at a source position using LSP with Symbol Graph fallback." : name === "findReferences" ? "Find references at a source position using LSP with Symbol Graph fallback." : "Get type and documentation hover information at a source position.",
    cacheable: false,
    parameters: { type: "object", properties: locationProperties, required: ["filePath", "line", "column"], additionalProperties: false },
    async execute(args) {
      const sourceLocation = location(args);
      return name === "findDefinition" ? languageServiceGateway.findDefinition(sourceLocation) : name === "findReferences" ? languageServiceGateway.findReferences(sourceLocation) : languageServiceGateway.getHover(sourceLocation);
    },
    summarize(result) { return Array.isArray(result) ? { resultCount: result.length } : { available: Boolean(result) }; }
  })),
  {
    name: "searchWorkspaceSymbols",
    description: "Search structured workspace symbols across supported languages.",
    cacheable: false,
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    async execute(args) { return languageServiceGateway.listWorkspaceSymbols(typeof args.query === "string" ? args.query : ""); },
    summarize(result) { return { symbolCount: Array.isArray(result) ? result.length : 0 }; }
  }
];
