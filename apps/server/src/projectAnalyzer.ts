import fs from "node:fs/promises";
import path from "node:path";
import { detectPackageManager } from "./commandDiscovery.js";
import { configMatchers, dependencyHints, highRiskDirectoryReasons, ignoredDirectoryNames, validationScriptPriority } from "./projectAnalyzerConfig.js";
import type { HighRiskDirectory, PackageJsonInfo, ProjectAnalysis, ProjectStructureSummary, TechStackAnalysis, TestSystemAnalysis, ValidationCommandCandidate } from "./projectAnalyzerTypes.js";

function addUnique(values: string[], value: string) {
  if (value && !values.includes(value)) values.push(value);
}

function toRelative(root: string, target: string) {
  const relativePath = path.relative(root, target).replaceAll(path.sep, "/");
  return relativePath || ".";
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function collectProjectFiles(workspaceRoot: string, limit = 5000) {
  const results: string[] = [];

  async function visit(directory: string) {
    if (results.length >= limit) return;

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toRelative(workspaceRoot, absolutePath);
      results.push(relativePath);

      // 扫描时跳过高风险和生成目录，避免把依赖、构建产物误判为项目源码。
      if (entry.isDirectory() && !ignoredDirectoryNames.has(entry.name)) {
        await visit(absolutePath);
      }

      if (results.length >= limit) break;
    }
  }

  await visit(workspaceRoot);
  return results.sort((left, right) => left.localeCompare(right));
}

async function readPackageJson(workspaceRoot: string, relativePath: string): Promise<PackageJsonInfo | null> {
  const absolutePath = path.join(workspaceRoot, relativePath);
  const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const packageJson = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};

    return {
      relativePath,
      directory: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath).replaceAll(path.sep, "/"),
      name: typeof packageJson.name === "string" ? packageJson.name : null,
      scripts: stringRecord(packageJson.scripts),
      dependencies: stringRecord(packageJson.dependencies),
      devDependencies: stringRecord(packageJson.devDependencies)
    };
  } catch {
    return null;
  }
}

async function collectPackageJsons(workspaceRoot: string, files: string[]) {
  const packageJsonPaths = files.filter((filePath) => path.basename(filePath) === "package.json" && !filePath.includes("node_modules/"));
  const packages = await Promise.all(packageJsonPaths.map((filePath) => readPackageJson(workspaceRoot, filePath)));
  return packages.filter((item): item is PackageJsonInfo => Boolean(item));
}

function detectLanguages(files: string[], packages: PackageJsonInfo[]) {
  const languages: string[] = [];
  if (files.some((filePath) => /\.[cm]?tsx?$/.test(filePath)) || packages.length > 0) addUnique(languages, "javascript");
  if (files.some((filePath) => /\.[cm]?tsx?$/.test(filePath)) || files.some((filePath) => path.basename(filePath) === "tsconfig.json")) addUnique(languages, "typescript");
  if (files.some((filePath) => /\.py$/.test(filePath) || ["requirements.txt", "pyproject.toml"].includes(path.basename(filePath)))) addUnique(languages, "python");
  return languages;
}

function detectTechStack(files: string[], packages: PackageJsonInfo[]): TechStackAnalysis {
  const techStack: TechStackAnalysis = {
    languages: detectLanguages(files, packages),
    frameworks: [],
    buildTools: [],
    lintTools: [],
    typeSystems: [],
    configFiles: []
  };

  for (const filePath of files) {
    const basename = path.basename(filePath);
    for (const [pattern, target, value] of configMatchers) {
      if (pattern.test(basename)) {
        addUnique(techStack[target], value);
        addUnique(techStack.configFiles, filePath);
      }
    }
  }

  for (const packageJson of packages) {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const [dependencyName, target, value] of dependencyHints) {
      if (dependencies[dependencyName]) addUnique(techStack[target], value);
    }
  }

  return techStack;
}

function detectTestSystem(files: string[], packages: PackageJsonInfo[]): TestSystemAnalysis {
  const testSystem: TestSystemAnalysis = { tools: [], configFiles: [], testFiles: [], hasTests: false };

  for (const filePath of files) {
    const basename = path.basename(filePath);
    if (/(\.test|\.spec)\.[cm]?[jt]sx?$/.test(basename) || filePath.includes("__tests__/") || /^test_.*\.py$/.test(basename)) {
      addUnique(testSystem.testFiles, filePath);
    }
    if (["pytest.ini", "tox.ini"].includes(basename)) {
      addUnique(testSystem.configFiles, filePath);
      addUnique(testSystem.tools, basename === "pytest.ini" ? "pytest" : "tox");
    }
  }

  for (const packageJson of packages) {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (dependencies.vitest) addUnique(testSystem.tools, "vitest");
    if (dependencies.jest) addUnique(testSystem.tools, "jest");
    if (Object.values(packageJson.scripts).some((script) => /\bnode\s+--test\b|\btsx\s+--test\b/.test(script))) addUnique(testSystem.tools, "node:test");
  }

  testSystem.hasTests = testSystem.tools.length > 0 || testSystem.testFiles.length > 0;
  return testSystem;
}

function buildScriptCommand(packageManager: string | null, packageJson: PackageJsonInfo, scriptName: string) {
  const manager = packageManager || "npm";
  if (!packageJson.directory) return manager === "npm" ? `npm run ${scriptName}` : `${manager} ${scriptName}`;
  if (manager === "pnpm") return `pnpm --dir ${packageJson.directory} ${scriptName}`;
  return `npm --prefix ${packageJson.directory} run ${scriptName}`;
}

function discoverValidationCommands(packageManager: string | null, packages: PackageJsonInfo[], files: string[]) {
  const candidates: ValidationCommandCandidate[] = [];

  for (const packageJson of packages) {
    for (const scriptName of validationScriptPriority) {
      if (!packageJson.scripts[scriptName]) continue;
      candidates.push({
        name: scriptName,
        command: buildScriptCommand(packageManager, packageJson, scriptName),
        source: packageJson.relativePath,
        reason: `package.json 中定义了 ${scriptName} 验证脚本`
      });
    }
  }

  // Python 项目常见没有 package.json，这里根据配置文件补充可执行候选命令。
  if (files.some((filePath) => path.basename(filePath) === "pytest.ini")) {
    candidates.push({ name: "pytest", command: "pytest", source: "pytest.ini", reason: "检测到 pytest 配置文件" });
  }
  if (files.some((filePath) => path.basename(filePath) === "ruff.toml")) {
    candidates.push({ name: "ruff", command: "ruff check .", source: "ruff.toml", reason: "检测到 ruff 配置文件" });
  }
  if (files.some((filePath) => path.basename(filePath) === "mypy.ini")) {
    candidates.push({ name: "mypy", command: "mypy .", source: "mypy.ini", reason: "检测到 mypy 配置文件" });
  }

  return candidates;
}

function summarizeStructure(rootEntries: string[], files: string[], packages: PackageJsonInfo[]): ProjectStructureSummary {
  const sourceDirectories = files
    .filter((filePath) => /(^|\/)(src|app|pages|components|services|routes|tests|__tests__)(\/|$)/.test(filePath))
    .map((filePath) => filePath.split("/").slice(0, -1).join("/"))
    .filter(Boolean);

  return {
    rootEntries: rootEntries.slice().sort((left, right) => left.localeCompare(right)),
    sourceDirectories: [...new Set(sourceDirectories)].slice(0, 80),
    workspacePackages: packages.map((packageJson) => packageJson.directory).filter(Boolean)
  };
}

function detectHighRiskDirectories(files: string[]): HighRiskDirectory[] {
  const directories: HighRiskDirectory[] = [];

  for (const [directoryName, reason] of highRiskDirectoryReasons) {
    const matched = files.filter((filePath) => filePath === directoryName || filePath.endsWith(`/${directoryName}`));
    for (const filePath of matched) directories.push({ path: filePath, reason });
  }

  return directories;
}

export async function analyzeProject(workspaceRoot: string | null | undefined): Promise<ProjectAnalysis> {
  if (!workspaceRoot) {
    return {
      packageManager: { name: null, lockfile: null, workspaceFile: null, packageJsonFiles: [] },
      techStack: { languages: [], frameworks: [], buildTools: [], lintTools: [], typeSystems: [], configFiles: [] },
      structure: { rootEntries: [], sourceDirectories: [], workspacePackages: [] },
      testSystem: { tools: [], configFiles: [], testFiles: [], hasTests: false },
      validationCommands: [],
      highRiskDirectories: []
    };
  }

  const rootEntries = await fs.readdir(workspaceRoot).catch((): string[] => []);
  const files = await collectProjectFiles(workspaceRoot);
  const packages = await collectPackageJsons(workspaceRoot, files);
  const lockfile = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "package-lock.json"].find((fileName) => rootEntries.includes(fileName)) || null;
  const packageManagerName = rootEntries.some((entry) => ["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "package-lock.json"].includes(entry)) ? detectPackageManager(rootEntries) : null;

  return {
    packageManager: {
      name: packageManagerName,
      lockfile,
      workspaceFile: rootEntries.includes("pnpm-workspace.yaml") ? "pnpm-workspace.yaml" : null,
      packageJsonFiles: packages.map((packageJson) => packageJson.relativePath)
    },
    techStack: detectTechStack(files, packages),
    structure: summarizeStructure(rootEntries, files, packages),
    testSystem: detectTestSystem(files, packages),
    validationCommands: discoverValidationCommands(packageManagerName, packages, files),
    highRiskDirectories: detectHighRiskDirectories(files)
  };
}

export type { ProjectAnalysis } from "./projectAnalyzerTypes.js";
