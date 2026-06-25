import { logAi } from "./aiHttp.js";
import { searchWorkspaceCode } from "./codeSearch.js";
import { readWorkspaceFile, readWorkspaceFileRange } from "./fileTools.js";
import { inspectCurrentProject } from "./projectInspector.js";
import { createAgentStep, createApprovalRequestStep } from "./routeAgentSteps.js";
import type { AgentStep } from "./types.js";

export type AgentContext = {
  userGoal: string;
  filesRead: string[];
  searchQueries: string[];
  searchResultFiles: string[];
  relevantFiles: string[];
};

export type AgentToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AgentToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

type JsonSchema = Record<string, unknown>;

type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: Record<string, unknown>, runtime: AgentToolRuntime) => Promise<unknown>;
  summarize: (result: unknown, cached: boolean, args: Record<string, unknown>) => unknown;
};

export type AgentToolRuntime = {
  agentContext: AgentContext;
  runId: string;
  cache: Map<string, unknown>;
  onAgentStep?: (step: AgentStep) => void;
};

const MAX_AUTO_READ_FILES = 5;
const MAX_READ_FILE_LINES = 240;
const MAX_READ_FILE_CHARS = 20_000;
const MAX_READ_RANGE_LINES = 240;

function uniquePush(values: string[], value: string) {
  if (value && !values.includes(value)) values.push(value);
}

function requiredString(args: Record<string, unknown>, name: string) {
  const value = typeof args[name] === "string" ? args[name].trim() : "";

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function requiredPositiveInteger(args: Record<string, unknown>, name: string) {
  const rawValue = args[name];
  const value = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" && rawValue.trim() ? Number(rawValue) : NaN;

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function truncateFileForPrompt(content: string) {
  const lines = content.split(/\r?\n/);
  const byLines = lines.slice(0, MAX_READ_FILE_LINES).join("\n");
  const truncatedContent = byLines.length > MAX_READ_FILE_CHARS ? byLines.slice(0, MAX_READ_FILE_CHARS) : byLines;

  return {
    content: truncatedContent,
    truncated: lines.length > MAX_READ_FILE_LINES || byLines.length > MAX_READ_FILE_CHARS || content.length > truncatedContent.length,
    linesRead: Math.min(lines.length, MAX_READ_FILE_LINES),
    totalLines: lines.length
  };
}

const definitions: AgentToolDefinition[] = [
  {
    name: "inspectProject",
    description: "Inspect package.json and project metadata, including scripts, dependencies, devDependencies, package manager, and framework hints.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    async execute() {
      return inspectCurrentProject();
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const dependencies = value.dependencies && typeof value.dependencies === "object" && !Array.isArray(value.dependencies) ? Object.keys(value.dependencies) : [];
      const devDependencies = value.devDependencies && typeof value.devDependencies === "object" && !Array.isArray(value.devDependencies) ? Object.keys(value.devDependencies) : [];

      return {
        cached,
        packageManager: value.packageManager,
        packageName: value.packageName,
        frameworkHints: value.frameworkHints,
        dependencies: dependencies.slice(0, 20),
        devDependencies: devDependencies.slice(0, 20)
      };
    }
  },
  {
    name: "searchCode",
    description: "Search the current workspace code with ripgrep and return up to 50 matching lines.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The literal text to search for in the workspace."
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const query = requiredString(args, "query");
      uniquePush(runtime.agentContext.searchQueries, query);
      const results = (await searchWorkspaceCode(query)).map((result) => ({
        filePath: result.filePath,
        line: result.line,
        content: result.content
      }));

      for (const result of results) {
        uniquePush(runtime.agentContext.searchResultFiles, result.filePath);
        uniquePush(runtime.agentContext.relevantFiles, result.filePath);
      }

      return results;
    },
    summarize(result, cached, args) {
      const results = Array.isArray(result) ? (result as Array<{ filePath?: unknown }>) : [];
      return {
        query: args.query,
        cached,
        resultCount: results.length,
        files: [...new Set(results.map((item) => (typeof item.filePath === "string" ? item.filePath : "")).filter(Boolean))].slice(0, 10)
      };
    }
  },
  {
    name: "readFile",
    description: "Read a relevant file from the current workspace. The path must be relative to the workspace. At most 5 files can be read automatically.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Workspace-relative file path to read."
        }
      },
      required: ["filePath"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const filePath = requiredString(args, "filePath");

      if (!runtime.agentContext.filesRead.includes(filePath) && runtime.agentContext.filesRead.length >= MAX_AUTO_READ_FILES) {
        throw new Error(`Automatic file read limit reached. You may read at most ${MAX_AUTO_READ_FILES} files.`);
      }

      const content = await readWorkspaceFile(filePath);
      const truncated = truncateFileForPrompt(content);
      uniquePush(runtime.agentContext.filesRead, filePath);
      uniquePush(runtime.agentContext.relevantFiles, filePath);

      return { filePath, ...truncated };
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      return {
        filePath: value.filePath,
        cached,
        linesRead: value.linesRead,
        totalLines: value.totalLines,
        truncated: value.truncated
      };
    }
  },
  {
    name: "readFileRange",
    description: "Read a specific 1-based inclusive line range from a workspace file. Use this when readFile is truncated or when you need a later section of a long file.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Workspace-relative file path to read."
        },
        startLine: {
          type: "integer",
          minimum: 1,
          description: "1-based first line to read."
        },
        endLine: {
          type: "integer",
          minimum: 1,
          description: "1-based last line to read, inclusive. The server caps very large ranges."
        }
      },
      required: ["filePath", "startLine", "endLine"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const filePath = requiredString(args, "filePath");
      const startLine = requiredPositiveInteger(args, "startLine");
      const requestedEndLine = requiredPositiveInteger(args, "endLine");
      const endLine = Math.min(requestedEndLine, startLine + MAX_READ_RANGE_LINES - 1);

      if (requestedEndLine < startLine) {
        throw new Error("endLine must be greater than or equal to startLine");
      }

      if (!runtime.agentContext.filesRead.includes(filePath) && runtime.agentContext.filesRead.length >= MAX_AUTO_READ_FILES) {
        throw new Error(`Automatic file read limit reached. You may read at most ${MAX_AUTO_READ_FILES} files.`);
      }

      const range = await readWorkspaceFileRange(filePath, startLine, endLine);
      const charTruncated = range.content.length > MAX_READ_FILE_CHARS;
      uniquePush(runtime.agentContext.filesRead, filePath);
      uniquePush(runtime.agentContext.relevantFiles, filePath);

      return {
        filePath,
        ...range,
        content: charTruncated ? range.content.slice(0, MAX_READ_FILE_CHARS) : range.content,
        requestedStartLine: startLine,
        requestedEndLine,
        truncated: charTruncated || requestedEndLine > endLine
      };
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      return {
        filePath: value.filePath,
        cached,
        startLine: value.startLine,
        endLine: value.endLine,
        linesRead: value.linesRead,
        totalLines: value.totalLines,
        hasMoreBefore: value.hasMoreBefore,
        hasMoreAfter: value.hasMoreAfter,
        truncated: value.truncated
      };
    }
  }
];

const registry = new Map(definitions.map((definition) => [definition.name, definition]));

export const agentToolSchemas = definitions.map((definition) => ({
  type: "function" as const,
  function: {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters
  }
}));

function parseArguments(rawArguments: string) {
  try {
    const value = JSON.parse(rawArguments);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getCacheKey(toolName: string, args: Record<string, unknown>) {
  if (toolName === "inspectProject") return toolName;
  if (toolName === "searchCode") return `${toolName}:${String(args.query || "").trim().toLowerCase()}`;
  if (toolName === "readFile") return `${toolName}:${String(args.filePath || "").trim().toLowerCase()}`;
  if (toolName === "readFileRange") return `${toolName}:${String(args.filePath || "").trim().toLowerCase()}:${String(args.startLine || "")}:${String(args.endLine || "")}`;
  return `${toolName}:${JSON.stringify(args)}`;
}

function getToolPurpose(toolName: string, args: Record<string, unknown>) {
  if (toolName === "inspectProject") {
    return "Use inspectProject to verify package manager, framework, and dependency versions before choosing APIs.";
  }

  if (toolName === "searchCode") {
    return `Use searchCode to search workspace code with keyword "${String(args.query || "").trim()}".`;
  }

  if (toolName === "readFile") {
    return `Use readFile to load workspace file "${String(args.filePath || "").trim()}" as context.`;
  }

  if (toolName === "readFileRange") {
    return `Use readFileRange to load lines ${String(args.startLine || "?")} through ${String(args.endLine || "?")} from workspace file "${String(args.filePath || "").trim()}".`;
  }

  return `Use ${toolName}.`;
}

function createToolApprovalStep(toolName: string, args: Record<string, unknown>) {
  if (toolName === "inspectProject") {
    return createApprovalRequestStep({
      actionType: "inspect_project",
      title: "检查项目结构",
      summary: "读取 package 信息、依赖和框架线索，帮助智能体选择合适实现方式。",
      status: "auto_approved"
    });
  }

  if (toolName === "searchCode") {
    const query = String(args.query || "").trim();

    return createApprovalRequestStep({
      actionType: "search_code",
      title: "搜索代码库",
      summary: `准备用关键词“${query}”搜索当前工作区。`,
      status: "auto_approved",
      targets: query ? [query] : undefined,
      details: { query }
    });
  }

  if (toolName === "readFile") {
    const filePath = String(args.filePath || "").trim();

    return createApprovalRequestStep({
      actionType: "read_file",
      title: "读取文件",
      summary: `准备用作上下文读取 ${filePath || "目标文件"}。`,
      status: "auto_approved",
      targets: filePath ? [filePath] : undefined,
      details: { filePath }
    });
  }

  if (toolName === "readFileRange") {
    const filePath = String(args.filePath || "").trim();

    return createApprovalRequestStep({
      actionType: "read_file",
      title: "读取文件片段",
      summary: `准备用作上下文读取 ${filePath || "目标文件"} 的指定行范围。`,
      status: "auto_approved",
      targets: filePath ? [filePath] : undefined,
      details: {
        filePath,
        startLine: args.startLine,
        endLine: args.endLine
      }
    });
  }

  return createApprovalRequestStep({
    actionType: "inspect_project",
    title: "调用工具",
    summary: `准备用工具 ${toolName} 获取上下文。`,
    status: "auto_approved",
    details: args
  });
}

export function createAgentToolRuntime(options: Omit<AgentToolRuntime, "cache">): AgentToolRuntime {
  return { ...options, cache: new Map<string, unknown>() };
}

export async function executeAgentToolCall(toolCall: AgentToolCall, runtime: AgentToolRuntime): Promise<AgentToolMessage> {
  const toolName = toolCall.function.name;
  const args = parseArguments(toolCall.function.arguments);
  const definition = registry.get(toolName);
  logAi(runtime.runId, "tool.call", { name: toolName, arguments: args });
  runtime.onAgentStep?.(createToolApprovalStep(toolName, args));
  runtime.onAgentStep?.(
    createAgentStep({
      type: "tool_call",
      toolName,
      input: {
        ...args,
        purpose: getToolPurpose(toolName, args),
        toolDescription: definition?.description || `Unknown tool: ${toolName}`
      }
    })
  );

  if (!definition) {
    const error = `Unknown tool: ${toolName}`;
    logAi(runtime.runId, "tool.unknown", toolName);
    runtime.onAgentStep?.(createAgentStep({ type: "error", message: error }));
    return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error }) };
  }

  const cacheKey = getCacheKey(toolName, args);

  try {
    const cached = runtime.cache.has(cacheKey);
    const result = cached ? runtime.cache.get(cacheKey) : await definition.execute(args, runtime);

    if (!cached) runtime.cache.set(cacheKey, result);

    const summary = definition.summarize(result, cached, args);
    logAi(runtime.runId, `tool.${toolName}.${cached ? "cacheHit" : "ok"}`, summary);
    runtime.onAgentStep?.(
      createAgentStep({
        type: "tool_result",
        toolName,
        output: {
          ...(summary && typeof summary === "object" && !Array.isArray(summary) ? summary : { summary }),
          toolDescription: definition.description
        }
      })
    );

    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(
        cached && result && typeof result === "object" && !Array.isArray(result)
          ? { note: `${toolName} was already called with these arguments.`, ...result }
          : cached
            ? { note: `${toolName} was already called with these arguments.`, results: result }
            : result
      )
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${toolName} failed`;
    logAi(runtime.runId, `tool.${toolName}.error`, { args, error: message });
    runtime.onAgentStep?.(createAgentStep({ type: "error", message: `${toolName} failed: ${message}` }));
    return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: message, ...args }) };
  }
}
