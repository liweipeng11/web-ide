import { logAi } from "./aiHttp.js";
import { listWorkspaceFiles, readWorkspaceFile, readWorkspaceFileRange, searchWorkspaceCode, searchWorkspaceFilesByName } from "./codeDiscovery/index.js";
import { inspectCurrentProject } from "./projectInspector.js";
import { createAgentToolRegistry, type AgentToolRegistry } from "./agentToolRegistry.js";
import { createAgentStep, createApprovalRequestStep } from "./routeAgentSteps.js";
import type { AgentStep } from "./types.js";
import type { AgentContext, AgentToolCall, AgentToolDefinition, AgentToolMessage, AgentToolRuntime } from "./agentToolTypes.js";

export type { AgentContext, AgentToolCall, AgentToolMessage, AgentToolRuntime } from "./agentToolTypes.js";

// 中等复杂度任务经常需要同时比对多个入口、路由和组件文件，5 个文件的上限过于激进，
// 容易在真正进入修改/审批前就提前失败。
const MAX_AUTO_READ_FILES = 8;
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

function optionalString(args: Record<string, unknown>, name: string, fallback = "") {
  const value = typeof args[name] === "string" ? args[name].trim() : "";
  return value || fallback;
}

function optionalBoolean(args: Record<string, unknown>, name: string, fallback = false) {
  const value = args[name];
  return typeof value === "boolean" ? value : fallback;
}

function optionalPositiveInteger(args: Record<string, unknown>, name: string, fallback: number) {
  const rawValue = args[name];

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }

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

export const readonlyAgentToolDefinitions: AgentToolDefinition[] = [
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
    name: "listFiles",
    description: "List files and directories under a workspace-relative path without reading file contents. Use this for low-cost directory discovery.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative directory path to list. Defaults to the workspace root."
        },
        recursive: {
          type: "boolean",
          description: "Whether to include descendants. Defaults to false."
        },
        includeIgnored: {
          type: "boolean",
          description: "Whether to include ignored generated/runtime directories. Defaults to false."
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of entries to return. The server caps very large values."
        }
      },
      additionalProperties: false
    },
    async execute(args) {
      const dir = optionalString(args, "path");
      const recursive = optionalBoolean(args, "recursive");
      const includeIgnored = optionalBoolean(args, "includeIgnored");
      const limit = optionalPositiveInteger(args, "limit", 200);

      return listWorkspaceFiles(dir, { recursive, allowIgnored: includeIgnored, limit });
    },
    summarize(result, cached, args) {
      const results = Array.isArray(result) ? (result as Array<{ path?: unknown; type?: unknown }>) : [];
      return {
        path: args.path || "",
        recursive: args.recursive === true,
        cached,
        resultCount: results.length,
        directories: results.filter((item) => item.type === "directory").length,
        files: results.filter((item) => item.type === "file").length,
        samplePaths: results.map((item) => (typeof item.path === "string" ? item.path : "")).filter(Boolean).slice(0, 10)
      };
    }
  },
  {
    name: "searchFilesByName",
    description: "Search workspace paths by file name, extension, or directory fragment without reading file contents.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "File name, extension, or path fragment to search for."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative directory to search within."
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of matching paths to return."
        },
        includeIgnored: {
          type: "boolean",
          description: "Whether to include ignored generated/runtime directories. Defaults to false."
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const query = requiredString(args, "query");
      const dir = optionalString(args, "path");
      const limit = optionalPositiveInteger(args, "limit", 50);
      const includeIgnored = optionalBoolean(args, "includeIgnored");
      uniquePush(runtime.agentContext.searchQueries, `file:${query}`);

      const results = await searchWorkspaceFilesByName(query, dir, limit, { allowIgnored: includeIgnored });

      for (const result of results) {
        uniquePush(runtime.agentContext.searchResultFiles, result.path);
        uniquePush(runtime.agentContext.relevantFiles, result.path);
      }

      return results;
    },
    summarize(result, cached, args) {
      const results = Array.isArray(result) ? (result as Array<{ path?: unknown; matchedBy?: unknown }>) : [];
      return {
        query: args.query,
        path: args.path || "",
        cached,
        resultCount: results.length,
        matches: results
          .map((item) => ({
            path: typeof item.path === "string" ? item.path : "",
            matchedBy: item.matchedBy
          }))
          .filter((item) => item.path)
          .slice(0, 10)
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
    description: "Read a relevant file from the current workspace. The path must be relative to the workspace. At most 8 files can be read automatically.",
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

export const readonlyAgentToolRegistry = createAgentToolRegistry(readonlyAgentToolDefinitions);

export const agentToolSchemas = readonlyAgentToolRegistry.schemas;

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
  if (toolName === "listFiles") {
    return `${toolName}:${String(args.path || "").trim().toLowerCase()}:${args.recursive === true}:${args.includeIgnored === true}:${String(args.limit || "")}`;
  }
  if (toolName === "searchFilesByName") {
    return `${toolName}:${String(args.query || "").trim().toLowerCase()}:${String(args.path || "").trim().toLowerCase()}:${args.includeIgnored === true}:${String(args.limit || "")}`;
  }
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

  if (toolName === "listFiles") {
    return `Use listFiles to inspect workspace directory "${String(args.path || "").trim() || "."}" without reading file contents.`;
  }

  if (toolName === "searchFilesByName") {
    return `Use searchFilesByName to find workspace paths matching "${String(args.query || "").trim()}".`;
  }

  if (toolName === "readFile") {
    return `Use readFile to load workspace file "${String(args.filePath || "").trim()}" as context.`;
  }

  if (toolName === "readFileRange") {
    return `Use readFileRange to load lines ${String(args.startLine || "?")} through ${String(args.endLine || "?")} from workspace file "${String(args.filePath || "").trim()}".`;
  }

  if (toolName === "replaceInFile") {
    return `Use replaceInFile to edit workspace file "${String(args.filePath || "").trim()}" with an exact search/replace block.`;
  }

  if (toolName === "writeFile") {
    return `Use writeFile to write the full latest content of workspace file "${String(args.filePath || "").trim()}".`;
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

  if (toolName === "listFiles") {
    const dir = String(args.path || "").trim();

    return createApprovalRequestStep({
      actionType: "search_code",
      title: "列出文件",
      summary: `准备列出${dir || "工作区根目录"}下的文件和目录。`,
      status: "auto_approved",
      targets: dir ? [dir] : undefined,
      details: {
        path: dir,
        recursive: args.recursive === true
      }
    });
  }

  if (toolName === "searchFilesByName") {
    const query = String(args.query || "").trim();

    return createApprovalRequestStep({
      actionType: "search_code",
      title: "搜索文件名",
      summary: `准备按文件名或路径片段“${query || "未提供"}”搜索当前工作区。`,
      status: "auto_approved",
      targets: query ? [query] : undefined,
      details: { query, path: args.path }
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

  if (toolName === "replaceInFile") {
    const filePath = String(args.filePath || "").trim();

    return createApprovalRequestStep({
      actionType: "edit_files",
      title: "替换文件内容",
      summary: `准备用精确匹配方式修改 ${filePath || "目标文件"}。`,
      status: "auto_approved",
      targets: filePath ? [filePath] : undefined,
      details: {
        filePath,
        replaceAll: args.replaceAll === true
      }
    });
  }

  if (toolName === "writeFile") {
    const filePath = String(args.filePath || "").trim();

    return createApprovalRequestStep({
      actionType: "write_file",
      title: "写入文件",
      summary: `准备用完整内容写入 ${filePath || "目标文件"}。`,
      status: "auto_approved",
      targets: filePath ? [filePath] : undefined,
      details: {
        filePath,
        createIfMissing: args.createIfMissing === true
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

export function createAgentToolRuntime(options: Omit<AgentToolRuntime, "cache"> & { registry?: AgentToolRegistry }): AgentToolRuntime & { registry?: AgentToolRegistry } {
  return { ...options, cache: new Map<string, unknown>() };
}

export async function executeAgentToolCall(toolCall: AgentToolCall, runtime: AgentToolRuntime): Promise<AgentToolMessage> {
  const toolName = toolCall.function.name;
  const args = parseArguments(toolCall.function.arguments);
  const registry = (runtime as AgentToolRuntime & { registry?: AgentToolRegistry }).registry || readonlyAgentToolRegistry;
  const definition = registry.get(toolName);
  logAi(runtime.runId, "tool.call", { name: toolName, arguments: args });
  if (runtime.emitToolApprovalSteps === true) {
    runtime.onAgentStep?.(createToolApprovalStep(toolName, args));
  }
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
    const cacheable = definition.cacheable !== false;
    const cached = cacheable && runtime.cache.has(cacheKey);
    const perToolRuntime = {
      ...runtime,
      currentToolCall: {
        id: toolCall.id,
        name: toolName,
        arguments: args,
        actionId: runtime.pendingActionId || null
      }
    };
    const result = cached ? runtime.cache.get(cacheKey) : await definition.execute(args, perToolRuntime);

    if (cacheable && !cached) runtime.cache.set(cacheKey, result);

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
