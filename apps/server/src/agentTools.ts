import { logAi } from "./aiHttp.js";
import { createContextCache, listCodeDefinitionNames, listWorkspaceFiles, readWorkspaceFileChunk, readWorkspaceFileRange, searchTextRegex, searchWorkspaceCode, searchWorkspaceFilesByName } from "./codeDiscovery/index.js";
import { inspectCurrentProject } from "./projectInspector.js";
import { findSimilarPatterns } from "./patternFinder/index.js";
import { checkExistence, type ExistenceCheckTarget } from "./existenceChecker/index.js";
import { analyzeImpact, type ImpactChangeKind, type ImpactChangeTarget } from "./impactAnalyzer/index.js";
import { buildSymbolGraph, querySymbolGraph, type SymbolGraphQuery, type SymbolQueryKind } from "./symbolGraph/index.js";
import { createAgentToolRegistry, type AgentToolRegistry } from "./agentToolRegistry.js";
import { createAgentStep, createApprovalRequestStep } from "./routeAgentSteps.js";
import type { AgentStep } from "./types.js";
import type { AgentContext, AgentToolCall, AgentToolDefinition, AgentToolMessage, AgentToolRuntime } from "./agentToolTypes.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

export type { AgentContext, AgentToolCall, AgentToolMessage, AgentToolRuntime } from "./agentToolTypes.js";

// 中等复杂度任务经常需要同时比对多个入口、路由和组件文件，5 个文件的上限过于激进，
// 容易在真正进入修改/审批前就提前失败。
const MAX_AUTO_READ_FILES = 8;
const MAX_READ_FILE_CHARS = 20_000;
const DEFAULT_READ_CHUNK_LINES = 200;
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

function optionalNonNegativeInteger(args: Record<string, unknown>, name: string, fallback: number) {
  const rawValue = args[name];

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }

  const value = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" && rawValue.trim() ? Number(rawValue) : NaN;

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}

function getSearchOptions(args: Record<string, unknown>) {
  return {
    path: optionalString(args, "path"),
    filePattern: optionalString(args, "filePattern"),
    limit: optionalPositiveInteger(args, "limit", 50),
    caseSensitive: optionalBoolean(args, "caseSensitive"),
    contextLines: optionalNonNegativeInteger(args, "contextLines", 0)
  };
}

export const readonlyAgentToolDefinitions: AgentToolDefinition[] = [
  // 影响分析只读取静态索引，规划阶段即可用于约束后续修改范围。
  {
    name: "analyzeImpact",
    description: "Analyze direct and indirect consumers of planned file or symbol changes. Returns affected files, related tests, boundary files, risk, and completeness diagnostics. Use before changing shared symbols, contracts, routes, or multi-file behavior.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Workspace-relative source file to be changed." },
              symbolName: { type: "string", description: "Optional symbol that narrows analysis within the file." },
              changeKind: { type: "string", enum: ["add", "modify", "delete", "rename", "signature"] }
            },
            required: ["filePath"],
            additionalProperties: false
          }
        },
        maxDepth: { type: "integer", minimum: 1, maximum: 10 },
        maxFiles: { type: "integer", minimum: 1, maximum: 1000 }
      },
      required: ["changes"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      if (!Array.isArray(args.changes) || !args.changes.length) throw new Error("changes must be a non-empty array");
      const validKinds = new Set<ImpactChangeKind>(["add", "modify", "delete", "rename", "signature"]);
      const changes: ImpactChangeTarget[] = args.changes.map((rawChange, index) => {
        if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) throw new Error(`changes[${index}] must be an object`);
        const change = rawChange as Record<string, unknown>;
        const filePath = requiredString(change, "filePath");
        const symbolName = optionalString(change, "symbolName");
        const changeKind = optionalString(change, "changeKind", "modify") as ImpactChangeKind;
        if (!validKinds.has(changeKind)) throw new Error(`changes[${index}].changeKind is invalid`);
        return { filePath, symbolName: symbolName || undefined, changeKind };
      });
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");

      uniquePush(runtime.agentContext.searchQueries, `impact:${changes.map((change) => `${change.filePath}${change.symbolName ? `#${change.symbolName}` : ""}`).join(",")}`);
      const result = await analyzeImpact(workspaceRoot, changes, {
        maxDepth: optionalPositiveInteger(args, "maxDepth", 4),
        maxFiles: optionalPositiveInteger(args, "maxFiles", 300)
      });
      runtime.agentContext.impactAnalyses ||= [];
      runtime.agentContext.impactAnalyses.push(result);
      for (const change of result.changes) uniquePush(runtime.agentContext.relevantFiles, change.filePath);
      for (const impacted of result.impactedFiles) {
        uniquePush(runtime.agentContext.searchResultFiles, impacted.filePath);
        uniquePush(runtime.agentContext.relevantFiles, impacted.filePath);
      }
      return result;
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const risk = value.risk && typeof value.risk === "object" ? value.risk as Record<string, unknown> : {};
      return {
        cached,
        complete: value.complete,
        truncated: value.truncated,
        riskLevel: risk.level,
        impactedFileCount: Array.isArray(value.impactedFiles) ? value.impactedFiles.length : 0,
        relatedTestCount: Array.isArray(value.relatedTests) ? value.relatedTests.length : 0,
        diagnosticCount: Array.isArray(value.diagnostics) ? value.diagnostics.length : 0,
        unresolvedReferenceCount: value.unresolvedReferenceCount,
        indexedUnresolvedReferenceCount: value.indexedUnresolvedReferenceCount
      };
    }
  },
  // 符号图属于只读分析能力，规划模式和执行模式都可安全调用。
  {
    name: "analyzeSymbolGraph",
    description: "Build a symbol-level workspace index and query definitions, references, reverse dependencies, call chains, or type propagation. Use filePath to disambiguate duplicate symbol names.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["definition", "references", "reverseDependencies", "callChain", "typePropagation"] },
        symbolName: { type: "string", description: "Symbol name for definition, reference, call-chain, and type-propagation queries." },
        filePath: { type: "string", description: "Optional defining file, or dependency target when symbolName is omitted." },
        path: { type: "string", description: "Optional workspace-relative directory used to limit indexing scope." },
        direction: { type: "string", enum: ["incoming", "outgoing", "both"] },
        maxDepth: { type: "integer", minimum: 1, maximum: 10 }
      },
      required: ["kind"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const kind = requiredString(args, "kind") as SymbolQueryKind;
      const validKinds = new Set<SymbolQueryKind>(["definition", "references", "reverseDependencies", "callChain", "typePropagation"]);
      if (!validKinds.has(kind)) throw new Error("kind is invalid");
      const symbolName = optionalString(args, "symbolName");
      const filePath = optionalString(args, "filePath");
      const direction = optionalString(args, "direction") as SymbolGraphQuery["direction"];
      if (direction && !new Set(["incoming", "outgoing", "both"]).has(direction)) throw new Error("direction is invalid");
      const maxDepth = optionalPositiveInteger(args, "maxDepth", 4);
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");

      uniquePush(runtime.agentContext.searchQueries, `symbol:${kind}:${symbolName || filePath}`);
      const graph = await buildSymbolGraph(workspaceRoot, { path: optionalString(args, "path") || undefined });
      const result = querySymbolGraph(graph, { kind, symbolName: symbolName || undefined, filePath: filePath || undefined, direction: direction || undefined, maxDepth });
      const relevantFiles = new Set<string>();
      // 将图查询命中的定义、引用和依赖文件统一纳入后续上下文选择。
      for (const definition of result.definitions) relevantFiles.add(definition.filePath);
      for (const reference of result.references) relevantFiles.add(reference.filePath);
      for (const dependency of result.dependencies) {
        relevantFiles.add(dependency.fromFile);
        if (dependency.toFile) relevantFiles.add(dependency.toFile);
      }
      for (const relation of result.relations) {
        relevantFiles.add(relation.reference.filePath);
        if (relation.from) relevantFiles.add(relation.from.filePath);
        if (relation.to) relevantFiles.add(relation.to.filePath);
      }
      for (const relevantFile of relevantFiles) {
        uniquePush(runtime.agentContext.searchResultFiles, relevantFile);
        uniquePush(runtime.agentContext.relevantFiles, relevantFile);
      }
      return result;
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      return {
        cached,
        indexedFileCount: value.indexedFileCount,
        indexedSymbolCount: value.indexedSymbolCount,
        unresolvedReferenceCount: value.unresolvedReferenceCount,
        indexTruncated: value.indexTruncated,
        ambiguous: value.ambiguous,
        definitionCount: Array.isArray(value.definitions) ? value.definitions.length : 0,
        referenceCount: Array.isArray(value.references) ? value.references.length : 0,
        dependencyCount: Array.isArray(value.dependencies) ? value.dependencies.length : 0,
        relationCount: Array.isArray(value.relations) ? value.relations.length : 0
      };
    }
  },
  {
    name: "checkExistence",
    description: "Verify that imports, symbols, package scripts, environment-variable sources, and directories actually exist. Returns exists, missing, or ambiguous; resolve missing and ambiguous results before editing or claiming a command ran.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["import", "symbol", "script", "environment", "directory"] },
              value: { type: "string" },
              fromPath: { type: "string", description: "Optional workspace-relative source file for import/symbol lookup or package.json path for script lookup." },
              environmentMode: { type: "string", description: "Optional environment mode used to explain environment-variable lookup." }
            },
            required: ["kind", "value"],
            additionalProperties: false
          }
        }
      },
      required: ["targets"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const rawTargets = Array.isArray(args.targets) ? args.targets : [];
      if (!rawTargets.length) throw new Error("targets is required");
      const targets = rawTargets.map((value): ExistenceCheckTarget => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each target must be an object");
        const target = value as Record<string, unknown>;
        const kind = optionalString(target, "kind");
        const validKinds = new Set(["import", "symbol", "script", "environment", "directory"]);
        if (!validKinds.has(kind)) throw new Error("target.kind is invalid");
        return { kind: kind as ExistenceCheckTarget["kind"], value: requiredString(target, "value"), ...(optionalString(target, "fromPath") ? { fromPath: optionalString(target, "fromPath") } : {}), ...(optionalString(target, "environmentMode") ? { environmentMode: optionalString(target, "environmentMode") } : {}) };
      });
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");
      const result = await checkExistence(workspaceRoot, targets);
      runtime.agentContext.existenceCheckPerformed = true;
      runtime.agentContext.unresolvedExistenceChecks = result.checks.filter((check) => check.status !== "exists").map((check) => `${check.target.kind}:${check.target.value}`);
      for (const check of result.checks) for (const candidate of check.candidates) uniquePush(runtime.agentContext.relevantFiles, candidate.path);
      return result;
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      return { cached, summary: value.summary, checks: Array.isArray(value.checks) ? value.checks : [] };
    }
  },
  {
    name: "findSimilarPatterns",
    description: "Find one to three relevant existing implementation patterns before editing. Ranks candidates by directory, responsibility, naming, imports, structure, error handling, test pairing, recency, and reuse signals.",
    parameters: {
      type: "object",
      properties: {
        taskDescription: { type: "string", description: "Concise description of the implementation task." },
        targetPath: { type: "string", description: "Optional workspace-relative target file path, including a planned new file path." },
        targetResponsibility: { type: "string", description: "Optional responsibility label, such as service, route, component, repository, utility, or test." },
        limit: { type: "integer", minimum: 1, maximum: 3, description: "Maximum candidates to return. Defaults to 3." }
      },
      required: ["taskDescription"],
      additionalProperties: false
    },
    // 相似度结果依赖整个工作区，候选文件的变更不能复用旧排序结果。
    cacheable: false,
    async execute(args, runtime) {
      const taskDescription = requiredString(args, "taskDescription");
      const targetPath = optionalString(args, "targetPath");
      const targetResponsibility = optionalString(args, "targetResponsibility");
      const limit = optionalPositiveInteger(args, "limit", 3);
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");

      uniquePush(runtime.agentContext.searchQueries, `pattern:${targetResponsibility || taskDescription}`);
      const result = await findSimilarPatterns(workspaceRoot, { taskDescription, targetPath, targetResponsibility, limit });
      runtime.agentContext.patternSearchPerformed = true;
      runtime.agentContext.patternCandidateFiles = result.candidates.map((candidate) => candidate.filePath);
      for (const candidate of result.candidates) {
        uniquePush(runtime.agentContext.searchResultFiles, candidate.filePath);
        uniquePush(runtime.agentContext.relevantFiles, candidate.filePath);
      }
      return result;
    },
    summarize(result, cached) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const candidates = Array.isArray(value.candidates) ? (value.candidates as Array<Record<string, unknown>>) : [];
      return {
        cached,
        indexedFileCount: value.indexedFileCount,
        candidateCount: candidates.length,
        candidates: candidates.map((candidate) => ({ filePath: candidate.filePath, score: candidate.score, reasons: candidate.reasons })).slice(0, 3)
      };
    }
  },
  {
    name: "inspectProject",
    description: "Inspect project metadata with Project Analyzer, including package manager, tech stack, structure summary, test system, validation commands, and high-risk directories.",
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
      const analysis = value.analysis && typeof value.analysis === "object" && !Array.isArray(value.analysis) ? (value.analysis as Record<string, unknown>) : {};

      return {
        cached,
        packageManager: value.packageManager,
        packageName: value.packageName,
        frameworkHints: value.frameworkHints,
        dependencies: dependencies.slice(0, 20),
        devDependencies: devDependencies.slice(0, 20),
        techStack: analysis.techStack,
        testSystem: analysis.testSystem,
        validationCommands: analysis.validationCommands,
        highRiskDirectories: analysis.highRiskDirectories
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
    name: "listCodeDefinitionNames",
    description: "List top-level code definitions such as functions, classes, types, and components under a workspace-relative file or directory without returning full file contents.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file or directory path to inspect. Defaults to the workspace root."
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of files with definitions to return."
        },
        includeIgnored: {
          type: "boolean",
          description: "Whether to include ignored generated/runtime directories. Defaults to false."
        }
      },
      additionalProperties: false
    },
    async execute(args, runtime) {
      const targetPath = optionalString(args, "path");
      const limit = optionalPositiveInteger(args, "limit", 80);
      const includeIgnored = optionalBoolean(args, "includeIgnored");
      uniquePush(runtime.agentContext.searchQueries, `definitions:${targetPath || "."}`);

      const results = await listCodeDefinitionNames(targetPath, limit, { allowIgnored: includeIgnored });

      for (const result of results) {
        uniquePush(runtime.agentContext.searchResultFiles, result.filePath);
        uniquePush(runtime.agentContext.relevantFiles, result.filePath);
      }

      return results;
    },
    summarize(result, cached, args) {
      const results = Array.isArray(result) ? (result as Array<{ filePath?: unknown; definitions?: unknown }>) : [];
      const definitionCount = results.reduce((count, item) => count + (Array.isArray(item.definitions) ? item.definitions.length : 0), 0);

      return {
        path: args.path || "",
        cached,
        fileCount: results.length,
        definitionCount,
        files: results
          .map((item) => ({
            filePath: typeof item.filePath === "string" ? item.filePath : "",
            definitions: Array.isArray(item.definitions)
              ? item.definitions
                  .map((definition) => {
                    const value = definition && typeof definition === "object" ? (definition as Record<string, unknown>) : {};
                    return typeof value.name === "string" ? `${value.kind || "definition"}:${value.name}` : "";
                  })
                  .filter(Boolean)
                  .slice(0, 8)
              : []
          }))
          .filter((item) => item.filePath)
          .slice(0, 10)
      };
    }
  },
  {
    name: "searchCode",
    description: "Search the current workspace code by literal text and return matching lines. Supports optional path, filePattern, limit, caseSensitive, and contextLines filters.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The literal text to search for in the workspace."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative file or directory path to search within."
        },
        filePattern: {
          type: "string",
          description: "Optional ripgrep glob such as *.ts or src/**/*.tsx."
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of matching lines to return."
        },
        caseSensitive: {
          type: "boolean",
          description: "Whether literal matching should be case-sensitive. Defaults to false."
        },
        contextLines: {
          type: "integer",
          minimum: 0,
          description: "Optional context lines requested from ripgrep. Matching lines remain the primary returned records."
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const query = requiredString(args, "query");
      const options = getSearchOptions(args);
      uniquePush(runtime.agentContext.searchQueries, query);
      const results = (await searchWorkspaceCode(query, options)).map((result) => ({
        filePath: result.filePath,
        line: result.line,
        column: result.column,
        content: result.content,
        match: result.match,
        contextBefore: result.contextBefore,
        contextAfter: result.contextAfter
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
        path: args.path || "",
        filePattern: args.filePattern || "",
        caseSensitive: args.caseSensitive === true,
        cached,
        resultCount: results.length,
        files: [...new Set(results.map((item) => (typeof item.filePath === "string" ? item.filePath : "")).filter(Boolean))].slice(0, 10)
      };
    }
  },
  {
    name: "searchCodeRegex",
    description: "Search the current workspace code with a regular expression. Use this for structural or multi-form code patterns, with optional path, filePattern, limit, caseSensitive, and contextLines filters.",
    parameters: {
      type: "object",
      properties: {
        regex: {
          type: "string",
          description: "Regular expression pattern to search for."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative file or directory path to search within."
        },
        filePattern: {
          type: "string",
          description: "Optional ripgrep glob such as *.ts or src/**/*.tsx."
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of matching lines to return."
        },
        caseSensitive: {
          type: "boolean",
          description: "Whether regex matching should be case-sensitive. Defaults to false."
        },
        contextLines: {
          type: "integer",
          minimum: 0,
          description: "Optional context lines requested from ripgrep. Matching lines remain the primary returned records."
        }
      },
      required: ["regex"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const regex = requiredString(args, "regex");
      const options = getSearchOptions(args);
      uniquePush(runtime.agentContext.searchQueries, `regex:${regex}`);

      const results = (await searchTextRegex(regex, options)).map((result) => ({
        filePath: result.filePath,
        line: result.line,
        column: result.column,
        content: result.content,
        match: result.match,
        contextBefore: result.contextBefore,
        contextAfter: result.contextAfter
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
        regex: args.regex,
        path: args.path || "",
        filePattern: args.filePattern || "",
        caseSensitive: args.caseSensitive === true,
        cached,
        resultCount: results.length,
        files: [...new Set(results.map((item) => (typeof item.filePath === "string" ? item.filePath : "")).filter(Boolean))].slice(0, 10)
      };
    }
  },
  {
    name: "readFile",
    description: "Read the first standard chunk of a relevant workspace file. Use readFileChunk to continue with later chunks when hasMoreAfter is true.",
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

      const chunk = await readWorkspaceFileChunk(filePath, 1, DEFAULT_READ_CHUNK_LINES);
      const charTruncated = chunk.content.length > MAX_READ_FILE_CHARS;
      uniquePush(runtime.agentContext.filesRead, filePath);
      uniquePush(runtime.agentContext.relevantFiles, filePath);

      return {
        filePath,
        ...chunk,
        content: charTruncated ? chunk.content.slice(0, MAX_READ_FILE_CHARS) : chunk.content,
        truncated: charTruncated
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
        hasMoreAfter: value.hasMoreAfter,
        nextStartLine: value.nextStartLine,
        truncated: value.truncated
      };
    }
  },
  {
    name: "readFileChunk",
    description: "Read a specific 1-based line chunk from a workspace file and return continuation metadata. Prefer this for long files or follow-up context.",
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
          description: "1-based first line to read. Defaults to 1."
        },
        endLine: {
          type: "integer",
          minimum: 1,
          description: "1-based last line to read, inclusive. Defaults to a 200-line chunk from startLine."
        }
      },
      required: ["filePath"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const filePath = requiredString(args, "filePath");
      const startLine = optionalPositiveInteger(args, "startLine", 1);
      const requestedEndLine = args.endLine === undefined || args.endLine === null || args.endLine === "" ? startLine + DEFAULT_READ_CHUNK_LINES - 1 : requiredPositiveInteger(args, "endLine");
      const endLine = Math.min(requestedEndLine, startLine + MAX_READ_RANGE_LINES - 1);

      if (requestedEndLine < startLine) {
        throw new Error("endLine must be greater than or equal to startLine");
      }

      if (!runtime.agentContext.filesRead.includes(filePath) && runtime.agentContext.filesRead.length >= MAX_AUTO_READ_FILES) {
        throw new Error(`Automatic file read limit reached. You may read at most ${MAX_AUTO_READ_FILES} files.`);
      }

      const chunk = await readWorkspaceFileChunk(filePath, startLine, endLine);
      const charTruncated = chunk.content.length > MAX_READ_FILE_CHARS;
      uniquePush(runtime.agentContext.filesRead, filePath);
      uniquePush(runtime.agentContext.relevantFiles, filePath);

      return {
        filePath,
        ...chunk,
        content: charTruncated ? chunk.content.slice(0, MAX_READ_FILE_CHARS) : chunk.content,
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
        nextStartLine: value.nextStartLine,
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

function getToolPurpose(toolName: string, args: Record<string, unknown>) {
  if (toolName === "analyzeImpact") {
    const count = Array.isArray(args.changes) ? args.changes.length : 0;
    return `Use analyzeImpact to inspect direct and indirect consumers for ${count || "the planned"} change target(s).`;
  }

  if (toolName === "analyzeSymbolGraph") {
    return `Use analyzeSymbolGraph to inspect ${String(args.kind || "symbol relationships")} for "${String(args.symbolName || args.filePath || "the selected scope")}".`;
  }

  if (toolName === "inspectProject") {
    return "Use inspectProject to verify package manager, framework, and dependency versions before choosing APIs.";
  }

  if (toolName === "searchCode") {
    return `Use searchCode to search workspace code with keyword "${String(args.query || "").trim()}".`;
  }

  if (toolName === "searchCodeRegex") {
    return `Use searchCodeRegex to search workspace code with regex "${String(args.regex || "").trim()}".`;
  }

  if (toolName === "listFiles") {
    return `Use listFiles to inspect workspace directory "${String(args.path || "").trim() || "."}" without reading file contents.`;
  }

  if (toolName === "searchFilesByName") {
    return `Use searchFilesByName to find workspace paths matching "${String(args.query || "").trim()}".`;
  }

  if (toolName === "listCodeDefinitionNames") {
    return `Use listCodeDefinitionNames to inspect top-level definitions under "${String(args.path || "").trim() || "."}" before reading full files.`;
  }

  if (toolName === "readFile") {
    return `Use readFile to load the first chunk of workspace file "${String(args.filePath || "").trim()}" as context.`;
  }

  if (toolName === "readFileChunk") {
    return `Use readFileChunk to load lines ${String(args.startLine || "1")} through ${String(args.endLine || "the default chunk end")} from workspace file "${String(args.filePath || "").trim()}".`;
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
  if (toolName === "analyzeImpact") {
    const targets = Array.isArray(args.changes)
      ? args.changes.map((change) => change && typeof change === "object" ? String((change as Record<string, unknown>).filePath || "") : "").filter(Boolean)
      : [];
    return createApprovalRequestStep({
      actionType: "search_code",
      title: "分析变更影响范围",
      summary: `准备分析 ${targets.length || 1} 个拟变更目标的直接与间接影响。`,
      status: "auto_approved",
      targets: targets.length ? targets : undefined,
      details: { changes: args.changes, maxDepth: args.maxDepth, maxFiles: args.maxFiles }
    });
  }

  if (toolName === "analyzeSymbolGraph") {
    const target = String(args.symbolName || args.filePath || args.path || "工作区").trim();
    return createApprovalRequestStep({
      actionType: "search_code",
      title: "分析符号关系",
      summary: `准备分析“${target}”的定义、引用或依赖关系。`,
      status: "auto_approved",
      targets: target ? [target] : undefined,
      details: { kind: args.kind, symbolName: args.symbolName, filePath: args.filePath, direction: args.direction }
    });
  }

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

  if (toolName === "searchCodeRegex") {
    const regex = String(args.regex || "").trim();

    return createApprovalRequestStep({
      actionType: "search_code",
      title: "正则搜索代码库",
      summary: `准备使用正则模式“${regex || "未提供"}”搜索当前工作区。`,
      status: "auto_approved",
      targets: regex ? [regex] : undefined,
      details: { regex, path: args.path, filePattern: args.filePattern }
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

  if (toolName === "listCodeDefinitionNames") {
    const targetPath = String(args.path || "").trim();

    return createApprovalRequestStep({
      actionType: "search_code",
      title: "提取代码定义",
      summary: `准备提取${targetPath || "工作区"}中的顶级代码定义摘要。`,
      status: "auto_approved",
      targets: targetPath ? [targetPath] : undefined,
      details: { path: targetPath }
    });
  }

  if (toolName === "readFile") {
    const filePath = String(args.filePath || "").trim();

    return createApprovalRequestStep({
      actionType: "read_file",
      title: "读取文件",
      summary: `准备读取 ${filePath || "目标文件"} 的首个上下文分块。`,
      status: "auto_approved",
      targets: filePath ? [filePath] : undefined,
      details: { filePath }
    });
  }

  if (toolName === "readFileChunk") {
    const filePath = String(args.filePath || "").trim();

    return createApprovalRequestStep({
      actionType: "read_file",
      title: "读取文件分块",
      summary: `准备读取 ${filePath || "目标文件"} 的指定行分块。`,
      status: "auto_approved",
      targets: filePath ? [filePath] : undefined,
      details: {
        filePath,
        startLine: args.startLine,
        endLine: args.endLine
      }
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
  return { ...options, cache: createContextCache() };
}

function collectCacheResourcePaths(toolName: string, args: Record<string, unknown>, result: unknown) {
  const resourcePaths = new Set<string>();

  if (typeof args.filePath === "string") {
    resourcePaths.add(args.filePath);
  }

  if (typeof args.path === "string") {
    resourcePaths.add(args.path);
  }

  if (["listFiles", "searchFilesByName", "listCodeDefinitionNames", "searchCode", "searchCodeRegex"].includes(toolName) && typeof args.path !== "string") {
    resourcePaths.add("");
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === "object") {
        const value = item as Record<string, unknown>;
        if (typeof value.filePath === "string") resourcePaths.add(value.filePath);
        if (typeof value.path === "string") resourcePaths.add(value.path);
      }
    }
  }

  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    if (typeof value.filePath === "string") resourcePaths.add(value.filePath);
  }

  return [...resourcePaths];
}

function withCacheMarker(result: unknown, toolName: string) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      note: `${toolName} was already called with these arguments.`,
      cached: true,
      ...result
    };
  }

  return {
    note: `${toolName} was already called with these arguments.`,
    cached: true,
    results: result
  };
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

  const cacheKey = { toolName, args };

  try {
    const cacheable = definition.cacheable !== false;
    const cachedEntry = cacheable ? await runtime.cache.get(cacheKey) : { hit: false, stale: false };
    const cached = cachedEntry.hit;
    const perToolRuntime = {
      ...runtime,
      currentToolCall: {
        id: toolCall.id,
        name: toolName,
        arguments: args,
        actionId: runtime.pendingActionId || null
      }
    };

    const result = cached ? cachedEntry.result : await definition.execute(args, perToolRuntime);
    const summary = definition.summarize(result, cached, args);

    if (cacheable && !cached) {
      await runtime.cache.set(cacheKey, result, {
        summary,
        resourcePaths: collectCacheResourcePaths(toolName, args, result)
      });
    }

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
      content: JSON.stringify(cached ? withCacheMarker(result, toolName) : result)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${toolName} failed`;
    logAi(runtime.runId, `tool.${toolName}.error`, { args, error: message });
    runtime.onAgentStep?.(createAgentStep({ type: "error", message: `${toolName} failed: ${message}` }));
    return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: message, ...args }) };
  }
}
