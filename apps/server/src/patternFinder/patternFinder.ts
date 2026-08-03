import fs from "node:fs/promises";
import path from "node:path";
import type { PatternCandidate, PatternFinderInput, PatternFinderResult } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".vue", ".py"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", ".mini-ai", ".ai-agent"]);
const MAX_INDEXED_FILES = 1_500;
const MIN_RELEVANCE_SCORE = 36;
const CROSS_PROJECT_MIN_RELEVANCE_SCORE = 44;
const GENERIC_PATH_TOKENS = new Set(["app", "apps", "src", "source", "package", "packages", "index", "main", "js", "jsx", "ts", "tsx", "vue", "py"]);

type Framework = "vue" | "react" | "python" | "generic";

type FileFeatures = {
  filePath: string;
  content: string;
  imports: string[];
  definitions: string[];
  responsibilities: string[];
  errorPatterns: string[];
  structurePatterns: string[];
  framework: Framework;
  projectRoot: string;
  extension: string;
  isTest: boolean;
  updatedAt: number;
};

type ProjectBoundary = {
  root: string;
  frameworks: Framework[];
};

function unique(values: string[]) {
  return [...new Set(values)];
}

// 将自然语言、路径、驼峰命名统一拆成可比较的关键词。
function tokenize(value: string) {
  return unique(
    value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((token) => token.length >= 2)
  );
}

function intersectionSize(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function extractImports(content: string) {
  const values: string[] = [];
  const expression = /(?:from\s+|import\s*\(|require\s*\()["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = expression.exec(content))) values.push(match[1]);
  // Python 的 import 语句没有引号，需单独解析以保证跨语言项目也能比较依赖模式。
  const pythonExpression = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  while ((match = pythonExpression.exec(content))) values.push(match[1] || match[2]);
  return unique(values);
}

function extractDefinitions(content: string) {
  const values: string[] = [];
  const expression = /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;

  while ((match = expression.exec(content))) values.push(match[1]);
  const pythonExpression = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm;
  while ((match = pythonExpression.exec(content))) values.push(match[1]);
  return unique(values);
}

// 抽取跨语言的轻量结构标记，用于区分仅名称相近和真正实现形态相近的候选。
function detectStructurePatterns(content: string) {
  const checks: Array<[string, RegExp]> = [
    ["async-function", /\basync\s+(?:function|def)\b|\basync\s*\([^)]*\)\s*=>/],
    ["class", /\bclass\s+[A-Za-z_$][\w$]*/],
    ["arrow-function", /(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/],
    ["try-catch", /\btry\s*\{|\bexcept\b/],
    ["react-hook", /\buse[A-Z][A-Za-z0-9]*\s*\(/],
    ["vue-composition", /\b(?:ref|computed|watch|onMounted)\s*\(/],
    ["route-handler", /\b(?:router|app)\.(?:get|post|put|patch|delete)\s*\(/],
    ["object-return", /\breturn\s*\{/]
  ];

  return checks.filter(([, expression]) => expression.test(content)).map(([name]) => name);
}

function detectFramework(filePath: string, content: string, projectFrameworks: Framework[]): Framework {
  const extension = path.posix.extname(filePath).toLowerCase();
  const source = content.toLowerCase();
  if (extension === ".vue" || /(?:from\s+|require\()['"](?:vue|vue-router)|<template\b|definecomponent\s*\(/i.test(source)) return "vue";
  if ([".tsx", ".jsx"].includes(extension) || /(?:from\s+|require\()['"](?:react|react-router)|\buse(?:state|effect|memo|callback)\s*\(/i.test(source)) return "react";
  if (extension === ".py") return "python";
  return projectFrameworks.length === 1 ? projectFrameworks[0] : "generic";
}

function inferRequestedFramework(input: PatternFinderInput, target: FileFeatures | null, boundary?: ProjectBoundary): Framework {
  if (target?.framework && target.framework !== "generic") return target.framework;
  const source = `${input.taskDescription} ${input.targetPath || ""} ${input.targetResponsibility || ""}`.toLowerCase();
  if (/\bvue(?:\.js)?\b|vue-router|\.vue\b/.test(source)) return "vue";
  if (/\breact(?:\.js)?\b|react-router|\.tsx\b|\.jsx\b/.test(source)) return "react";
  if (/\bpython\b|\.py\b/.test(source)) return "python";
  return boundary?.frameworks.length === 1 ? boundary.frameworks[0] : "generic";
}

function detectResponsibilities(filePath: string, content: string) {
  const source = `${filePath}\n${content.slice(0, 8_000)}`.toLowerCase();
  const checks: Array<[string, RegExp]> = [
    ["component", /\.(tsx|jsx|vue)$|react|definecomponent|<template/],
    ["service", /service|async function|fetch\(|axios|request\./],
    ["route", /route|router\.|app\.(get|post|put|delete)|express/],
    ["test", /\.(test|spec)\.|node:test|describe\(|it\(|test\(/],
    ["repository", /repository|database|prisma|query\(/],
    ["utility", /utils?|format|parse|validate/]
  ];

  return checks.filter(([, expression]) => expression.test(source)).map(([name]) => name);
}

function detectErrorPatterns(content: string) {
  const patterns: Array<[string, RegExp]> = [
    ["try-catch", /\btry\s*\{/],
    ["throw-error", /\bthrow\s+new\s+(?:Error|HttpError)/],
    ["http-status", /\b(?:res|response)\.status\(/],
    ["error-result", /\b(?:error|err)\b/]
  ];

  return patterns.filter(([, expression]) => expression.test(content)).map(([name]) => name);
}

function isTestFile(filePath: string) {
  return /(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__(?:\/|$)|(?:^|\/)test_[^/]+\.py$/i.test(filePath);
}

async function collectSourceFiles(workspaceRoot: string) {
  const files: string[] = [];

  async function visit(directory: string) {
    if (files.length >= MAX_INDEXED_FILES) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (files.length >= MAX_INDEXED_FILES) return;
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        // 不扫描依赖和构建产物，避免把生成代码误认为项目模式。
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.isSymbolicLink()) await visit(absolutePath);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(workspaceRoot, absolutePath).split(path.sep).join("/"));
      }
    }
  }

  await visit(workspaceRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectProjectBoundaries(workspaceRoot: string): Promise<ProjectBoundary[]> {
  const manifestPaths: string[] = [];
  async function visit(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
      if (entry.isFile() && entry.name === "package.json") manifestPaths.push(absolutePath);
    }
  }
  await visit(workspaceRoot);
  return (await Promise.all(manifestPaths.map(async (manifestPath) => {
    const raw = await fs.readFile(manifestPath, "utf8").catch(() => "");
    try {
      const manifest = JSON.parse(raw) as Record<string, Record<string, unknown> | undefined>;
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
      const frameworks: Framework[] = [];
      if (dependencies.vue || dependencies["vue-router"]) frameworks.push("vue");
      if (dependencies.react || dependencies["react-router"] || dependencies["react-router-dom"]) frameworks.push("react");
      return { root: path.relative(workspaceRoot, path.dirname(manifestPath)).split(path.sep).join("/") || ".", frameworks };
    } catch {
      return null;
    }
  }))).filter((item): item is ProjectBoundary => Boolean(item))
    .sort((left, right) => right.root.length - left.root.length);
}

function resolveProjectBoundary(filePath: string, boundaries: ProjectBoundary[]) {
  return boundaries.find((boundary) => boundary.root === "." || filePath === boundary.root || filePath.startsWith(`${boundary.root}/`))
    || { root: ".", frameworks: [] };
}

function resolveLogicalProjectRoot(filePath: string, boundary: ProjectBoundary) {
  if (boundary.root !== ".") return boundary.root;
  const segments = filePath.split("/");
  return ["apps", "packages"].includes(segments[0]) && segments[1] ? `${segments[0]}/${segments[1]}` : ".";
}

async function readFeatures(workspaceRoot: string, filePath: string, boundaries: ProjectBoundary[]): Promise<FileFeatures | null> {
  const absolutePath = path.join(workspaceRoot, filePath);
  const [content, stat] = await Promise.all([fs.readFile(absolutePath, "utf8").catch(() => ""), fs.stat(absolutePath).catch(() => null)]);
  if (!content || !stat) return null;

  const boundary = resolveProjectBoundary(filePath, boundaries);
  return {
    filePath,
    content,
    imports: extractImports(content),
    definitions: extractDefinitions(content),
    responsibilities: detectResponsibilities(filePath, content),
    errorPatterns: detectErrorPatterns(content),
    structurePatterns: detectStructurePatterns(content),
    framework: detectFramework(filePath, content, boundary.frameworks),
    projectRoot: resolveLogicalProjectRoot(filePath, boundary),
    extension: path.posix.extname(filePath).toLowerCase(),
    isTest: isTestFile(filePath),
    updatedAt: stat.mtimeMs
  };
}

function baseStem(filePath: string) {
  return path.posix.basename(filePath).replace(/\.(test|spec)\.[^.]+$/i, "").replace(/^test_/i, "").replace(/\.[^.]+$/, "");
}

function findRelatedTests(candidate: FileFeatures, allFiles: FileFeatures[]) {
  const stem = baseStem(candidate.filePath).toLowerCase();
  return allFiles.filter((file) => file.isTest && file.filePath !== candidate.filePath && baseStem(file.filePath).toLowerCase() === stem).map((file) => file.filePath);
}

function buildReusableElements(candidate: FileFeatures, relatedTests: string[]) {
  const elements: string[] = [];
  if (candidate.definitions.length) elements.push(`顶层定义：${candidate.definitions.slice(0, 4).join("、")}`);
  if (candidate.imports.length) elements.push(`依赖导入：${candidate.imports.slice(0, 3).join("、")}`);
  if (candidate.errorPatterns.length) elements.push(`错误处理：${candidate.errorPatterns.join("、")}`);
  if (candidate.structurePatterns.length) elements.push(`代码结构：${candidate.structurePatterns.join("、")}`);
  if (relatedTests.length) elements.push(`配套测试：${relatedTests.join("、")}`);
  return elements;
}

function scoreCandidate(candidate: FileFeatures, target: FileFeatures | null, input: PatternFinderInput, allFiles: FileFeatures[], targetProjectRoot: string, targetFramework: Framework) {
  const reasons: string[] = [];
  let score = 0;
  const targetTokens = unique([...
    tokenize(input.taskDescription),
    ...tokenize(input.targetPath || ""),
    ...tokenize(input.targetResponsibility || "")
  ]);
  // 通用目录名和扩展名由专门边界分处理，不能重复伪装成业务关键词。
  const candidatePathTokens = tokenize(candidate.filePath).filter((token) => !GENERIC_PATH_TOKENS.has(token));
  const semanticTargetTokens = targetTokens.filter((token) => !GENERIC_PATH_TOKENS.has(token));
  const keywordMatches = intersectionSize(semanticTargetTokens, candidatePathTokens);
  if (keywordMatches) {
    score += Math.min(keywordMatches * 7, 21);
    reasons.push(`路径或命名命中 ${keywordMatches} 个任务关键词`);
  }

  if (input.targetPath && candidate.projectRoot === targetProjectRoot) {
    score += 22;
    reasons.push("与目标位于同一子项目");
  } else if (input.targetPath) {
    score -= 12;
  }

  if (targetFramework !== "generic" && candidate.framework === targetFramework) {
    score += 22;
    reasons.push(`与目标使用相同 ${targetFramework} 技术栈`);
  } else if (targetFramework !== "generic" && candidate.framework !== "generic" && candidate.framework !== targetFramework) {
    // 明确跨 Vue/React 的候选会制造错误上下文，必须显著降权。
    score -= 48;
    reasons.push(`与目标技术栈不一致（${candidate.framework}）`);
  }

  const targetExtension = path.posix.extname(input.targetPath || "").toLowerCase();
  if (targetExtension && candidate.extension === targetExtension) {
    score += 10;
    reasons.push("与目标文件类型一致");
  }

  const targetDirectory = input.targetPath ? path.posix.dirname(input.targetPath) : "";
  if (targetDirectory && targetDirectory !== "." && path.posix.dirname(candidate.filePath) === targetDirectory) {
    score += 24;
    reasons.push("与目标文件位于同一目录");
  }

  const requestedResponsibilities = unique([...
    tokenize(input.targetResponsibility || ""),
    ...targetTokens.filter((token) => ["component", "service", "route", "test", "repository", "utility"].includes(token))
  ]);
  const responsibilityMatches = intersectionSize(requestedResponsibilities, candidate.responsibilities);
  if (responsibilityMatches) {
    score += responsibilityMatches * 15;
    reasons.push(`匹配 ${candidate.responsibilities.filter((item) => requestedResponsibilities.includes(item)).join("、")} 职责模式`);
  }

  if (target) {
    const sharedImports = intersectionSize(target.imports, candidate.imports);
    if (sharedImports) {
      score += Math.min(sharedImports * 6, 18);
      reasons.push(`复用 ${sharedImports} 个相同导入依赖`);
    }
    const sharedErrors = intersectionSize(target.errorPatterns, candidate.errorPatterns);
    if (sharedErrors) {
      score += sharedErrors * 6;
      reasons.push(`采用相同错误处理模式：${candidate.errorPatterns.filter((item) => target.errorPatterns.includes(item)).join("、")}`);
    }
    const sharedStructures = intersectionSize(target.responsibilities, candidate.responsibilities);
    if (sharedStructures) {
      score += sharedStructures * 5;
      reasons.push("代码职责结构相近");
    }
    const sharedStructurePatterns = intersectionSize(target.structurePatterns, candidate.structurePatterns);
    if (sharedStructurePatterns) {
      score += Math.min(sharedStructurePatterns * 4, 16);
      reasons.push(`复用 ${sharedStructurePatterns} 个相同代码结构特征`);
    }
  }

  const relatedTests = findRelatedTests(candidate, allFiles);
  if (relatedTests.length) {
    score += 5;
    reasons.push("存在同名配套测试文件");
  }

  const referenceCount = allFiles.filter((file) => file.filePath !== candidate.filePath && file.content.includes(baseStem(candidate.filePath))).length;
  if (referenceCount > 0) {
    score += Math.min(referenceCount, 5);
    reasons.push(`被 ${referenceCount} 个文件引用或提及`);
  }

  return { score, reasons, relatedTests };
}

/**
 * 在工作区中寻找与当前任务相近的已有实现。
 * 该实现只做文件级特征索引，结果用于指导后续 readFile，不替代对源码的实际阅读。
 */
export async function findSimilarPatterns(workspaceRoot: string, input: PatternFinderInput): Promise<PatternFinderResult> {
  const taskDescription = input.taskDescription.trim();
  if (!taskDescription) throw new Error("taskDescription is required");

  const limit = Math.min(Math.max(input.limit || 3, 1), 3);
  const filePaths = await collectSourceFiles(workspaceRoot);
  const boundaries = await collectProjectBoundaries(workspaceRoot);
  const features = (await Promise.all(filePaths.map((filePath) => readFeatures(workspaceRoot, filePath, boundaries)))).filter((item): item is FileFeatures => Boolean(item));
  const targetPath = input.targetPath?.replaceAll("\\", "/");
  const target = targetPath ? features.find((file) => file.filePath === targetPath) || null : null;
  const targetBoundary = targetPath ? resolveProjectBoundary(targetPath, boundaries) : undefined;
  const targetProjectRoot = target?.projectRoot || (targetPath && targetBoundary ? resolveLogicalProjectRoot(targetPath, targetBoundary) : ".");
  const targetFramework = inferRequestedFramework({ ...input, targetPath }, target, targetBoundary);
  // 只奖励最近 20% 的文件，避免直接比较时间戳量级导致所有文件都被误判为“近期”。
  const recentThreshold = [...features.map((file) => file.updatedAt)].sort((left, right) => right - left)[Math.max(0, Math.ceil(features.length * 0.2) - 1)] || 0;

  const rankedCandidates: PatternCandidate[] = features
    .filter((file) => file.filePath !== targetPath)
    .map((file) => {
      const ranked = scoreCandidate(file, target, { ...input, targetPath }, features, targetProjectRoot, targetFramework);
      // 近期维护只能作为已有相似信号的加分项，不能把无关文件变成候选。
      const recencyBonus = ranked.score > 0 && recentThreshold > 0 && file.updatedAt >= recentThreshold ? 2 : 0;
      const reasons = recencyBonus ? [...ranked.reasons, "属于近期维护的实现"] : ranked.reasons;

      return {
        filePath: file.filePath,
        score: ranked.score + recencyBonus,
        reasons,
        reusableElements: buildReusableElements(file, ranked.relatedTests),
        relatedTests: ranked.relatedTests
      };
    })
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
  const candidates = rankedCandidates.filter((candidate) => {
    const candidateFeature = features.find((file) => file.filePath === candidate.filePath);
    const minimumScore = candidateFeature?.projectRoot === targetProjectRoot ? MIN_RELEVANCE_SCORE : CROSS_PROJECT_MIN_RELEVANCE_SCORE;
    return candidate.score >= minimumScore;
  }).slice(0, limit);
  const noMatchReason = candidates.length ? undefined : features.length ? "未找到与任务或目标职责足够相关的现有实现。" : "工作区中没有可索引的受支持源码文件。";

  return { query: { ...input, taskDescription, limit }, candidates, indexedFileCount: features.length, ...(noMatchReason ? { noMatchReason } : {}) };
}
