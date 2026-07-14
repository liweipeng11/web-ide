import fs from "node:fs/promises";
import path from "node:path";
import { analyzeImpact } from "../impactAnalyzer/index.js";
import type { ImpactAnalysisResult } from "../impactAnalyzer/index.js";
import type { ProjectAnalysis, ValidationCommandCandidate } from "../projectAnalyzerTypes.js";
import type { IncrementalVerificationInput, VerificationCommand, VerificationIssueCategory, VerificationPlan } from "./types.js";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);
const buildSensitiveNames = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "turbo.json",
  "nx.json"
]);

type IncrementalPlannerDependencies = {
  analyzeImpact: typeof analyzeImpact;
};

const defaultDependencies: IncrementalPlannerDependencies = { analyzeImpact };

function normalizeChangedFile(workspaceRoot: string, filePath: string) {
  const value = filePath.trim().replace(/\\/g, "/");
  if (!value) return null;
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relativePath = path.relative(root, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error(`Changed file is outside workspace: ${filePath}`);
  return relativePath.split(path.sep).join("/");
}

function packageDirectoryFromManifest(manifestPath: string) {
  const directory = path.posix.dirname(manifestPath);
  return directory === "." ? "" : directory;
}

function findOwningPackage(filePath: string, packageDirectories: string[]) {
  return packageDirectories
    .filter((directory) => !directory || filePath === directory || filePath.startsWith(`${directory}/`))
    .sort((left, right) => right.length - left.length)[0] ?? "";
}

function commandPackage(candidate: ValidationCommandCandidate) {
  return candidate.source.endsWith("package.json") ? packageDirectoryFromManifest(candidate.source) : "";
}

function isTestFile(filePath: string) {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(filePath);
}

function isBuildSensitive(filePath: string) {
  const basename = path.posix.basename(filePath);
  return buildSensitiveNames.has(basename)
    || /^(?:vite|webpack|next|eslint)\.config\.[cm]?[jt]s$/i.test(basename)
    || /(?:^|\/)(?:config|configs)\//i.test(filePath);
}

function buildRequiredByFailure(categories: VerificationIssueCategory[]) {
  // 只有构建阶段自身失败时才强制回归 build，类型、lint、测试失败先保持低成本验证。
  return categories.includes("build");
}

function preferBaseStageCommand(commands: VerificationCommand[], stage: VerificationCommand["stage"]) {
  const baseNames: Record<VerificationCommand["stage"], string[]> = {
    format_syntax: ["format:check", "format-check", "check"],
    typecheck: ["typecheck", "type-check"],
    lint: ["lint"],
    test: ["test"],
    build: ["build"]
  };
  for (const name of baseNames[stage]) {
    const preferred = commands.filter((command) => command.name.toLowerCase() === name);
    if (preferred.length) return preferred;
  }
  return commands;
}

function selectPackageCommands(commands: VerificationCommand[], affectedPackages: Set<string>, buildRequired: boolean) {
  const selected: VerificationCommand[] = [];
  const stages = ["format_syntax", "typecheck", "lint", "test", ...(buildRequired ? ["build"] : [])] as VerificationCommand["stage"][];

  for (const stage of stages) {
    const stageCommands = commands.filter((command) => command.stage === stage);
    for (const packageDirectory of affectedPackages) {
      // 严格限制在所属包内，不能用其他包或工作区全量脚本冒充相关模块验证。
      const candidates = stageCommands.filter((command) => commandPackage(command) === packageDirectory);
      // 基础脚本通常已经汇总同阶段的子脚本，优先选它可避免 test 与 test:* 重复执行。
      selected.push(...preferBaseStageCommand(candidates, stage));
    }
  }

  return [...new Map(selected.map((command) => [command.command.trim().toLowerCase(), command])).values()];
}

function detectFocusedTestRunner(script: string) {
  if (/\btsx\s+--test\b/.test(script)) return "tsx --test";
  if (/\bnode\s+--test\b/.test(script)) return "node --test";
  if (/\bvitest(?:\s+run)?\b/.test(script)) return "vitest run";
  if (/\bjest\b/.test(script)) return "jest";
  return null;
}

function isSafeCommandPath(filePath: string) {
  return /^[a-zA-Z0-9_./-]+$/.test(filePath) && !filePath.split("/").includes("..");
}

async function focusRelatedTests(
  workspaceRoot: string,
  commands: VerificationCommand[],
  relatedTests: Set<string>,
  packageDirectories: string[],
  packageManager: string | null
) {
  if (!relatedTests.size || !["pnpm", "npm"].includes(packageManager || "")) return commands;

  return Promise.all(commands.map(async (command): Promise<VerificationCommand> => {
    if (command.stage !== "test" || !command.source.endsWith("package.json")) return command;
    const packageDirectory = commandPackage(command);
    const packageTests = [...relatedTests]
      .filter((filePath) => findOwningPackage(filePath, packageDirectories) === packageDirectory)
      .map((filePath) => packageDirectory ? path.posix.relative(packageDirectory, filePath) : filePath)
      .filter((filePath) => isSafeCommandPath(filePath) && isTestFile(filePath));
    if (!packageTests.length) return command;

    const manifest = await fs.readFile(path.join(workspaceRoot, command.source), "utf8").then((content) => JSON.parse(content) as { scripts?: Record<string, unknown> }).catch(() => null);
    const script = manifest?.scripts?.[command.name];
    const runner = typeof script === "string" ? detectFocusedTestRunner(script) : null;
    if (!runner) return command;

    // focused 命令只使用经过白名单校验的相对测试路径，避免 shell 参数注入。
    const prefix = packageManager === "pnpm"
      ? `pnpm${packageDirectory ? ` --dir ${packageDirectory}` : ""} exec`
      : `npm${packageDirectory ? ` --prefix ${packageDirectory}` : ""} exec --`;
    return {
      ...command,
      name: "focused:test",
      command: `${prefix} ${runner} ${packageTests.sort().join(" ")}`,
      reason: `根据 changed-files 定向执行 ${packageTests.length} 个相关测试`
    };
  }));
}

async function existingSourceTargets(workspaceRoot: string, changedFiles: string[]) {
  const candidates = changedFiles.filter((filePath) => sourceExtensions.has(path.posix.extname(filePath).toLowerCase()));
  const existence = await Promise.all(candidates.map(async (filePath) => ({ filePath, exists: Boolean(await fs.stat(path.join(workspaceRoot, filePath)).catch(() => null)) })));
  return existence.filter((item) => item.exists).map((item) => ({ filePath: item.filePath, changeKind: "modify" as const }));
}

/**
 * 将改动文件收敛为相关包和测试；静态分析不完整时退回包级命令，不会声称无需验证。
 */
export async function planIncrementalVerification(
  workspaceRoot: string,
  analysis: ProjectAnalysis,
  allCommands: VerificationCommand[],
  input: IncrementalVerificationInput = {},
  dependencies: IncrementalPlannerDependencies = defaultDependencies
): Promise<VerificationPlan> {
  const requestedChangedFiles = Array.isArray(input.changedFiles) ? input.changedFiles.filter((filePath): filePath is string => typeof filePath === "string") : [];
  const changedFiles = [...new Set(requestedChangedFiles.map((filePath) => normalizeChangedFile(workspaceRoot, filePath)).filter((filePath): filePath is string => Boolean(filePath)))];
  if (!changedFiles.length) {
    return {
      mode: "full",
      commands: allCommands,
      changedFiles: [],
      affectedPackages: [],
      relatedTests: [],
      buildRequired: true,
      reasons: ["未提供 changed-files，执行完整验证流水线"],
      diagnostics: []
    };
  }

  const packageDirectories = analysis.packageManager.packageJsonFiles.map(packageDirectoryFromManifest);
  const affectedPackages = new Set(changedFiles.map((filePath) => findOwningPackage(filePath, packageDirectories)));
  const relatedTests = new Set(changedFiles.filter(isTestFile));
  const diagnostics: string[] = [];
  let impact: ImpactAnalysisResult | null = null;
  const targets = await existingSourceTargets(workspaceRoot, changedFiles);

  if (targets.length) {
    try {
      impact = await dependencies.analyzeImpact(workspaceRoot, targets);
      impact.relatedTests.forEach((filePath) => relatedTests.add(filePath));
      impact.impactedFiles.forEach((file) => affectedPackages.add(findOwningPackage(file.filePath, packageDirectories)));
      diagnostics.push(...impact.diagnostics);
    } catch (error) {
      diagnostics.push(`影响分析失败，已退回包级验证：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 静态图可能无法覆盖测试框架的动态加载，补充同包同名测试作为低成本映射证据。
  for (const changedFile of changedFiles) {
    const stem = path.posix.basename(changedFile).replace(/\.[^.]+$/, "").toLowerCase();
    const owner = findOwningPackage(changedFile, packageDirectories);
    for (const testFile of analysis.testSystem.testFiles) {
      if (findOwningPackage(testFile, packageDirectories) === owner && path.posix.basename(testFile).toLowerCase().includes(stem)) relatedTests.add(testFile);
    }
  }

  const failureCategories = Array.isArray(input.failureCategories) ? input.failureCategories : [];
  const buildRequired = changedFiles.some(isBuildSensitive)
    || Boolean(impact?.boundaryFiles.length)
    || buildRequiredByFailure(failureCategories)
    || allCommands.some((command) => command.source === "request" && command.stage === "build");
  let commands = selectPackageCommands(allCommands, affectedPackages, buildRequired);
  commands = await focusRelatedTests(workspaceRoot, commands, relatedTests, packageDirectories, analysis.packageManager.name);
  let mode: VerificationPlan["mode"] = impact?.complete ? "incremental" : "package_fallback";

  if (!commands.length) {
    mode = "package_fallback";
    diagnostics.push("相关包没有可用验证脚本，未执行其他包的无关命令");
  }
  if (buildRequired && !commands.some((command) => command.stage === "build")) diagnostics.push("当前相关包没有可用 build 脚本，已保留其他验证阶段");

  return {
    mode,
    commands,
    changedFiles,
    affectedPackages: [...affectedPackages].sort(),
    relatedTests: [...relatedTests].sort(),
    buildRequired,
    reasons: [
      `根据 ${changedFiles.length} 个改动文件选择 ${affectedPackages.size} 个包`,
      relatedTests.size ? `映射到 ${relatedTests.size} 个相关测试文件` : "未发现精确关联测试，保留包级测试作为回退",
      buildRequired ? "配置、边界文件或构建失败类别要求执行 build" : "当前错误类别和改动范围无需执行 build"
    ],
    diagnostics
  };
}
