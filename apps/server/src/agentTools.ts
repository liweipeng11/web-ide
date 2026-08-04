import { logAi } from "./aiHttp.js";
import { createContextCache, listCodeDefinitionNames, listWorkspaceFiles, readWorkspaceFileChunk, readWorkspaceFileRange, searchTextRegex, searchWorkspaceCode, searchWorkspaceFilesByName } from "./codeDiscovery/index.js";
import { inspectCurrentProject } from "./projectInspector.js";
import { findSimilarPatterns } from "./patternFinder/index.js";
import { checkExistence, type ExistenceCheckTarget } from "./existenceChecker/index.js";
import { analyzeImpact, type ImpactAnalysisOptions, type ImpactAnalysisResult, type ImpactChangeKind, type ImpactChangeTarget } from "./impactAnalyzer/index.js";
import { buildSymbolGraph, querySymbolGraph, type SymbolGraphQuery, type SymbolQueryKind } from "./symbolGraph/index.js";
import { createAgentToolRegistry, type AgentToolRegistry } from "./agentToolRegistry.js";
import { modificationPlanAgentToolDefinitions } from "./agentModificationPlanTools.js";
import { createAgentStep, createApprovalRequestStep } from "./routeAgentSteps.js";
import type { AgentStep } from "./types.js";
import type { AgentContext, AgentToolCall, AgentToolDefinition, AgentToolMessage, AgentToolRuntime, NegativeEvidence, SearchToolResult } from "./agentToolTypes.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { externalContextReadonlyToolDefinitions } from "./externalContext/index.js";
import { recoverStoredContextArtifact, storeContextArtifact } from "./contextBudget/index.js";
import { createReferenceCheckKey, parseReferenceCheckKey } from "./taskWorkflow/referenceChecks.js";

export type { AgentContext, AgentToolCall, AgentToolMessage, AgentToolRuntime } from "./agentToolTypes.js";

type ToolFailurePayload = {
  error: string;
  errorCode: string;
  retryable: boolean;
  suggestedAction: string;
  toolName: string;
  status?: number;
};

// 中等复杂度任务经常需要同时比对多个入口、路由和组件文件，5 个文件的上限过于激进，
// 容易在真正进入修改/审批前就提前失败。
const MAX_AUTO_READ_FILES = 8;
const MAX_READ_FILE_CHARS = 20_000;
const DEFAULT_READ_CHUNK_LINES = 200;
const MAX_READ_RANGE_LINES = 240;
const MAX_TEXT_SEARCH_RESULTS = 200;
const MAX_FILE_SEARCH_RESULTS = 2000;

function uniquePush(values: string[], value: string) {
  if (value && !values.includes(value)) values.push(value);
}

/**
 * 统一执行并记录影响分析，供 Agent 工具与动态预检复用，避免两条链路产生不同的证据状态。
 */
export async function executeImpactAnalysis(
  workspaceRoot: string,
  changes: ImpactChangeTarget[],
  agentContext?: AgentContext,
  options: ImpactAnalysisOptions = {}
): Promise<ImpactAnalysisResult> {
  const result = await analyzeImpact(workspaceRoot, changes, options);
  if (!agentContext) return result;

  uniquePush(agentContext.searchQueries, `impact:${changes.map((change) => `${change.filePath}${change.symbolName ? `#${change.symbolName}` : ""}`).join(",")}`);
  agentContext.impactAnalyses ||= [];
  agentContext.impactAnalyses.push(result);
  for (const change of result.changes) uniquePush(agentContext.relevantFiles, change.filePath);
  for (const impacted of result.impactedFiles) {
    uniquePush(agentContext.searchResultFiles, impacted.filePath);
    uniquePush(agentContext.relevantFiles, impacted.filePath);
  }
  return result;
}

function normalizeSearchScope(pathValue: string, filePattern = "") {
  const searchedPath = pathValue || ".";
  return filePattern ? `${searchedPath} (glob: ${filePattern})` : searchedPath;
}

function recordNegativeEvidence(agentContext: AgentContext, evidence: Omit<NegativeEvidence, "createdAt">) {
  agentContext.negativeEvidence ||= [];
  const duplicate = agentContext.negativeEvidence.some(
    (item) => item.kind === evidence.kind && item.query === evidence.query && item.scope === evidence.scope && item.sourceTool === evidence.sourceTool
  );

  // 同一工具、查询和范围只记录一次，避免证据列表随缓存命中持续膨胀。
  if (!duplicate) agentContext.negativeEvidence.push({ ...evidence, createdAt: Date.now() });
}

function removeNegativeEvidence(agentContext: AgentContext, evidence: Pick<NegativeEvidence, "query" | "scope" | "sourceTool">) {
  if (!agentContext.negativeEvidence?.length) return;
  agentContext.negativeEvidence = agentContext.negativeEvidence.filter(
    (item) => item.query !== evidence.query || item.scope !== evidence.scope || item.sourceTool !== evidence.sourceTool
  );
}

function normalizeEvidenceTarget(value: string) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function correctContradictoryExistenceEvidence(agentContext: AgentContext, target: ExistenceCheckTarget, correctedStatus: string, runId: string) {
  const normalizedTarget = normalizeEvidenceTarget(target.value);
  const authoritative = correctedStatus === "existing" || correctedStatus === "dependency_installed" || correctedStatus === "dependency_declared";
  if (!authoritative) return;

  const correctedStatuses: string[] = [];
  for (const [key, resolution] of Object.entries(agentContext.referenceChecks || {})) {
    const parsed = parseReferenceCheckKey(key);
    const oldKind = parsed?.kind || "unknown";
    const oldValue = normalizeEvidenceTarget(parsed?.value || "");
    if (oldValue !== normalizedTarget || !resolution.blocking) continue;
    // package 权威检查可以纠正此前把依赖名误当 symbol/import 的缺失结论。
    if (target.kind !== "package" && oldKind !== target.kind) continue;
    correctedStatuses.push(resolution.status);
    delete agentContext.referenceChecks?.[key];
  }

  const oldNegativeEvidence = agentContext.negativeEvidence || [];
  const retainedNegativeEvidence = oldNegativeEvidence.filter((item) => normalizeEvidenceTarget(item.query) !== normalizedTarget);
  if (retainedNegativeEvidence.length !== oldNegativeEvidence.length) {
    correctedStatuses.push("negative_evidence");
    agentContext.negativeEvidence = retainedNegativeEvidence;
  }

  for (const previousStatus of [...new Set(correctedStatuses)]) {
    const event = {
      targetKind: target.kind,
      targetValue: target.value.trim(),
      previousStatus,
      correctedStatus,
      sourceTool: "checkExistence" as const,
      createdAt: Date.now()
    };
    agentContext.evidenceCorrections ??= [];
    agentContext.evidenceCorrections.push(event);
    logAi(runId, "runtime.existenceEvidenceCorrected", event);
  }
}

function createSearchToolResult<T>(options: {
  matches: T[];
  query: string;
  searchedPath: string;
  requestedLimit: number;
  hardLimit: number;
}): SearchToolResult<T> {
  const effectiveLimit = Math.min(options.requestedLimit, options.hardLimit);
  // 底层能力无法越过硬上限多取一条；正好达到硬上限时保守视为可能截断。
  const truncated = options.matches.length > effectiveLimit || (effectiveLimit === options.hardLimit && options.matches.length >= options.hardLimit);
  const matches = options.matches.slice(0, effectiveLimit);
  return {
    matches,
    query: options.query,
    searchedPath: options.searchedPath || ".",
    exhaustive: !truncated,
    cached: false,
    conclusion: matches.length > 0 ? "matches_found" : truncated ? "scope_incomplete" : "target_absent"
  };
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
  ...modificationPlanAgentToolDefinitions,
  {
    name: "recoverContextArtifact",
    description: "Recover a bounded chunk of an earlier tool result using its tool-call reference. Use offset/nextOffset to continue without resending the entire artifact.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Recoverable reference in tool-call:<id> format." },
        offset: { type: "integer", minimum: 0, description: "Zero-based character offset. Defaults to 0." },
        maxChars: { type: "integer", minimum: 200, maximum: 4000, description: "Maximum characters to return." }
      },
      required: ["reference"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      if (!runtime.taskSessionId) throw new Error("Artifact recovery requires an active task session");
      return recoverStoredContextArtifact({
        taskSessionId: runtime.taskSessionId,
        reference: requiredString(args, "reference"),
        offset: optionalNonNegativeInteger(args, "offset", 0),
        maxChars: optionalPositiveInteger(args, "maxChars", 4_000)
      });
    },
    summarize(result) {
      return result;
    }
  },
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

      return executeImpactAnalysis(workspaceRoot, changes, runtime.agentContext, {
        maxDepth: optionalPositiveInteger(args, "maxDepth", 4),
        maxFiles: optionalPositiveInteger(args, "maxFiles", 300)
      });
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
    description: "Verify that imports, packages, symbols, package scripts, environment-variable sources, and directories actually exist. Returns exists, missing, or ambiguous; resolve missing and ambiguous results before editing or claiming a command ran.",
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
              kind: { type: "string", enum: ["import", "package", "symbol", "script", "environment", "directory"] },
              value: { type: "string" },
              fromPath: { type: "string", description: "Optional workspace-relative source file for import/package/symbol lookup or package.json path for script lookup." },
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
        const validKinds = new Set(["import", "package", "symbol", "script", "environment", "directory"]);
        if (!validKinds.has(kind)) throw new Error("target.kind is invalid");
        return { kind: kind as ExistenceCheckTarget["kind"], value: requiredString(target, "value"), ...(optionalString(target, "fromPath") ? { fromPath: optionalString(target, "fromPath") } : {}), ...(optionalString(target, "environmentMode") ? { environmentMode: optionalString(target, "environmentMode") } : {}) };
      });
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) throw new Error("No workspace selected");
      const result = await checkExistence(workspaceRoot, targets);
      runtime.agentContext.existenceCheckPerformed = true;
      runtime.agentContext.referenceChecks ??= {};
      for (const check of result.checks) {
        correctContradictoryExistenceEvidence(runtime.agentContext, check.target, check.resolution.status, runtime.runId);
        runtime.agentContext.referenceChecks[createReferenceCheckKey(check.target)] = {
          ...check.resolution,
          candidates: check.resolution.candidates.map((candidate) => ({ ...candidate }))
        };
      }
      // 兼容旧会话字段；新门禁消费 referenceChecks，并按本次编辑目标过滤。
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

      // 多取一条用于区分“完整空结果”和“命中数量被上限截断”。
      const results = await searchWorkspaceFilesByName(query, dir, Math.min(limit, MAX_FILE_SEARCH_RESULTS) + 1, { allowIgnored: includeIgnored });
      const searchResult = createSearchToolResult({ matches: results, query, searchedPath: dir, requestedLimit: limit, hardLimit: MAX_FILE_SEARCH_RESULTS });

      if (searchResult.exhaustive) {
        const scannedEntries = await listWorkspaceFiles(dir, { recursive: true, allowIgnored: includeIgnored, limit: MAX_FILE_SEARCH_RESULTS });
        // 达到目录扫描硬上限时无法证明后续未扫描条目中也没有目标。
        if (scannedEntries.length >= MAX_FILE_SEARCH_RESULTS) {
          searchResult.exhaustive = false;
          if (searchResult.conclusion === "target_absent") searchResult.conclusion = "scope_incomplete";
        }
      }

      for (const result of searchResult.matches) {
        uniquePush(runtime.agentContext.searchResultFiles, result.path);
        uniquePush(runtime.agentContext.relevantFiles, result.path);
      }

      if (searchResult.conclusion === "target_absent") {
        recordNegativeEvidence(runtime.agentContext, {
          kind: "path_absent",
          query,
          scope: normalizeSearchScope(dir),
          sourceTool: "searchFilesByName",
          exhaustive: true
        });
      } else if (searchResult.conclusion === "matches_found") {
        removeNegativeEvidence(runtime.agentContext, { query, scope: normalizeSearchScope(dir), sourceTool: "searchFilesByName" });
      }

      return searchResult;
    },
    summarize(result, cached, args) {
      const value = result && typeof result === "object" ? (result as SearchToolResult<{ path?: unknown; matchedBy?: unknown }>) : null;
      const results = value?.matches || [];
      return {
        query: args.query,
        path: args.path || "",
        cached,
        exhaustive: value?.exhaustive === true,
        conclusion: value?.conclusion,
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
      const requestedLimit = options.limit;
      const searchOptions = { ...options, limit: Math.min(requestedLimit, MAX_TEXT_SEARCH_RESULTS - 1) + 1 };
      const evidenceScope = normalizeSearchScope(options.path, options.filePattern);
      const results = (await searchWorkspaceCode(query, searchOptions)).map((result) => ({
        filePath: result.filePath,
        line: result.line,
        column: result.column,
        content: result.content,
        match: result.match,
        contextBefore: result.contextBefore,
        contextAfter: result.contextAfter
      }));

      const searchResult = createSearchToolResult({
        matches: results,
        query,
        searchedPath: options.path,
        requestedLimit,
        hardLimit: MAX_TEXT_SEARCH_RESULTS
      });
      for (const result of searchResult.matches) {
        uniquePush(runtime.agentContext.searchResultFiles, result.filePath);
        uniquePush(runtime.agentContext.relevantFiles, result.filePath);
      }

      if (searchResult.conclusion === "target_absent") {
        recordNegativeEvidence(runtime.agentContext, {
          kind: "text_absent",
          query,
          scope: evidenceScope,
          sourceTool: "searchCode",
          exhaustive: true
        });
      } else if (searchResult.conclusion === "matches_found") {
        removeNegativeEvidence(runtime.agentContext, { query, scope: evidenceScope, sourceTool: "searchCode" });
      }

      return searchResult;
    },
    summarize(result, cached, args) {
      const value = result && typeof result === "object" ? (result as SearchToolResult<{ filePath?: unknown; line?: unknown; column?: unknown; content?: unknown; match?: unknown }>) : null;
      const results = value?.matches || [];
      return {
        query: args.query,
        path: args.path || "",
        filePattern: args.filePattern || "",
        caseSensitive: args.caseSensitive === true,
        cached,
        exhaustive: value?.exhaustive === true,
        conclusion: value?.conclusion,
        resultCount: results.length,
        files: [...new Set(results.map((item) => (typeof item.filePath === "string" ? item.filePath : "")).filter(Boolean))].slice(0, 10),
        // 仅保留定位所需的命中文件、行号与短片段，完整文件继续通过读取工具按需获取。
        matches: results.slice(0, 20).map((item) => ({
          filePath: item.filePath,
          line: item.line,
          column: item.column,
          content: typeof item.content === "string" ? item.content.slice(0, 300) : "",
          match: typeof item.match === "string" ? item.match.slice(0, 160) : ""
        }))
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

      const requestedLimit = options.limit;
      const searchOptions = { ...options, limit: Math.min(requestedLimit, MAX_TEXT_SEARCH_RESULTS - 1) + 1 };
      const evidenceScope = normalizeSearchScope(options.path, options.filePattern);
      const results = (await searchTextRegex(regex, searchOptions)).map((result) => ({
        filePath: result.filePath,
        line: result.line,
        column: result.column,
        content: result.content,
        match: result.match,
        contextBefore: result.contextBefore,
        contextAfter: result.contextAfter
      }));

      const searchResult = createSearchToolResult({
        matches: results,
        query: regex,
        searchedPath: options.path,
        requestedLimit,
        hardLimit: MAX_TEXT_SEARCH_RESULTS
      });
      for (const result of searchResult.matches) {
        uniquePush(runtime.agentContext.searchResultFiles, result.filePath);
        uniquePush(runtime.agentContext.relevantFiles, result.filePath);
      }

      if (searchResult.conclusion === "target_absent") {
        recordNegativeEvidence(runtime.agentContext, {
          kind: "text_absent",
          query: regex,
          scope: evidenceScope,
          sourceTool: "searchCodeRegex",
          exhaustive: true
        });
      } else if (searchResult.conclusion === "matches_found") {
        removeNegativeEvidence(runtime.agentContext, { query: regex, scope: evidenceScope, sourceTool: "searchCodeRegex" });
      }

      return searchResult;
    },
    summarize(result, cached, args) {
      const value = result && typeof result === "object" ? (result as SearchToolResult<{ filePath?: unknown; line?: unknown; column?: unknown; content?: unknown; match?: unknown }>) : null;
      const results = value?.matches || [];
      return {
        regex: args.regex,
        path: args.path || "",
        filePattern: args.filePattern || "",
        caseSensitive: args.caseSensitive === true,
        cached,
        exhaustive: value?.exhaustive === true,
        conclusion: value?.conclusion,
        resultCount: results.length,
        files: [...new Set(results.map((item) => (typeof item.filePath === "string" ? item.filePath : "")).filter(Boolean))].slice(0, 10),
        matches: results.slice(0, 20).map((item) => ({
          filePath: item.filePath,
          line: item.line,
          column: item.column,
          content: typeof item.content === "string" ? item.content.slice(0, 300) : "",
          match: typeof item.match === "string" ? item.match.slice(0, 160) : ""
        }))
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
        truncated: value.truncated,
        content: value.content
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
        truncated: value.truncated,
        content: value.content
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
        truncated: value.truncated,
        content: value.content
      };
    }
  },
  ...externalContextReadonlyToolDefinitions
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
    return `分析 ${count || "计划中的"} 个变更目标的直接和间接影响，避免遗漏关联文件。`;
  }

  if (toolName === "analyzeSymbolGraph") {
    return `分析“${String(args.symbolName || args.filePath || "当前范围")}”的${String(args.kind || "符号")}关系，为后续修改确认依赖。`;
  }

  if (toolName === "inspectProject") {
    return "检查项目技术栈、包管理器和依赖版本，以选择兼容的实现方式。";
  }

  if (toolName === "searchCode") {
    return `在工作区搜索“${String(args.query || "").trim()}”，定位现有实现和可复用代码。`;
  }

  if (toolName === "searchCodeRegex") {
    return `用正则“${String(args.regex || "").trim()}”搜索工作区，定位符合模式的代码。`;
  }

  if (toolName === "listFiles") {
    return `查看“${String(args.path || "").trim() || "."}”下的目录结构，确定相关文件位置。`;
  }

  if (toolName === "searchFilesByName") {
    return `按名称查找“${String(args.query || "").trim()}”相关文件，缩小需要阅读的范围。`;
  }

  if (toolName === "listCodeDefinitionNames") {
    return `提取“${String(args.path || "").trim() || "."}”中的顶层定义，快速判断相关入口。`;
  }

  if (toolName === "readFile") {
    return `读取“${String(args.filePath || "").trim()}”的内容，了解现有实现后再作决策。`;
  }

  if (toolName === "readFileChunk") {
    return `读取“${String(args.filePath || "").trim()}”第 ${String(args.startLine || "1")} 至 ${String(args.endLine || "默认结束行")} 行，补充所需上下文。`;
  }

  if (toolName === "readFileRange") {
    return `读取“${String(args.filePath || "").trim()}”第 ${String(args.startLine || "?")} 至 ${String(args.endLine || "?")} 行，核对具体实现细节。`;
  }

  if (toolName === "replaceInFile") {
    return `在“${String(args.filePath || "").trim()}”中执行精确替换，完成已确认的局部修改。`;
  }

  if (toolName === "writeFile") {
    return `写入“${String(args.filePath || "").trim()}”的最新完整内容，落地已确认的修改。`;
  }

  if (toolName === "runCommand") return `运行命令“${String(args.command || "").trim()}”，执行验证或推进当前任务。`;
  if (toolName === "proposePatch") return "生成待审阅补丁，汇总建议的文件修改而不直接写入工作区。";
  if (toolName === "applyPatch") return "应用已生成的补丁，将审阅后的修改写入工作区。";
  if (toolName === "deleteFile") return `删除“${String(args.filePath || args.path || "").trim()}”，移除不再需要的文件。`;
  if (toolName === "automateBrowser") return `在“${String(args.url || "").trim()}”执行浏览器自动化，完成必要的页面检查或交互。`;
  if (toolName === "askUser") return "向用户补充询问必要信息，避免在关键条件不明确时继续执行。";
  return `调用 ${toolName}，获取推进当前任务所需的信息或执行结果。`;
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
    if (Array.isArray(value.matches)) {
      for (const item of value.matches) {
        if (!item || typeof item !== "object") continue;
        const match = item as Record<string, unknown>;
        if (typeof match.filePath === "string") resourcePaths.add(match.filePath);
        if (typeof match.path === "string") resourcePaths.add(match.path);
      }
    }
  }

  return [...resourcePaths];
}

function withCacheMarker(result: unknown, toolName: string) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result,
      note: `${toolName} was already called with these arguments.`,
      cached: true
    };
  }

  return {
    note: `${toolName} was already called with these arguments.`,
    cached: true,
    results: result
  };
}

/**
 * 将工具异常转换为模型可直接判断的结构化结果。
 * 错误作为数据返回而非抛出，便于 Agent 基于错误码选择读取、修正参数或停止重试。
 */
function createToolFailurePayload(toolName: string, args: Record<string, unknown>, error: unknown): ToolFailurePayload & Record<string, unknown> {
  const exception = error instanceof Error ? error : null;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : undefined;
  const filePath = typeof record.filePath === "string"
    ? record.filePath
    : typeof args.filePath === "string" ? args.filePath : undefined;
  const message = exception?.message || `${toolName} failed`;

  if (exception?.name === "SearchReplaceMismatchError") {
    return {
      ...args,
      error: message,
      errorCode: "SEARCH_BLOCK_NOT_FOUND",
      retryable: true,
      suggestedAction: `先读取 ${filePath || "目标文件"} 的当前内容，基于最新文本重新生成 search；不要重复提交相同的 replaceInFile 参数。`,
      toolName,
      status,
      ...(filePath ? { filePath } : {})
    };
  }

  if (status === 404) {
    return {
      ...args,
      error: message,
      errorCode: "RESOURCE_NOT_FOUND",
      retryable: true,
      suggestedAction: "先检查目标路径是否存在；若任务明确要求新建文件，请改用允许创建的写入工具。",
      toolName,
      status,
      ...(filePath ? { filePath } : {})
    };
  }

  if (status === 422) {
    return {
      ...args,
      error: message,
      errorCode: "INVALID_TOOL_INPUT",
      retryable: true,
      suggestedAction: "检查工具参数与目标文件当前状态，修正参数后再重试；不要重复提交完全相同的调用。",
      toolName,
      status,
      ...(filePath ? { filePath } : {})
    };
  }

  return {
    ...args,
    error: message,
    errorCode: "TOOL_EXECUTION_FAILED",
    retryable: false,
    suggestedAction: "检查错误详情与当前上下文；若无法定位可恢复原因，请停止重试并说明阻塞条件。",
    toolName,
    status,
    ...(filePath ? { filePath } : {})
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
    if (runtime.taskSessionId && toolCall.id && toolName !== "recoverContextArtifact") {
      await storeContextArtifact({ taskSessionId: runtime.taskSessionId, toolCallId: toolCall.id, toolName, arguments: args, result }).catch((error) => {
        // 恢复存储属于辅助能力，写入失败不能改变已成功的工具执行结果。
        console.warn("[context-artifact] failed to persist tool result", error instanceof Error ? error.message : "unknown error");
      });
    }
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
    return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(createToolFailurePayload(toolName, args, error)) };
  }
}
