import fs from "node:fs/promises";
import path from "node:path";
import { analyzeProject, type ProjectAnalysis } from "./projectAnalyzer.js";
import { detectPackageManager } from "./commandDiscovery.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

export type ProjectInspection = {
  packageManager: string | null;
  packageName: string | null;
  packageJsonPath: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  frameworkHints: string[];
  analysis: ProjectAnalysis;
};

const frameworkDependencyHints: Array<[string, string]> = [
  ["vue", "vue"],
  ["@vue/cli-service", "vue"],
  ["vue-router", "vue-router"],
  ["react", "react"],
  ["react-dom", "react"],
  ["next", "next"],
  ["svelte", "svelte"],
  ["@sveltejs/kit", "svelte"],
  ["angular", "angular"],
  ["@angular/core", "angular"],
  ["vite", "vite"],
  ["webpack", "webpack"],
  ["typescript", "typescript"]
];

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function detectFrameworkHints(dependencies: Record<string, string>, devDependencies: Record<string, string>) {
  const allDependencies = { ...dependencies, ...devDependencies };
  const hints = new Set<string>();

  for (const [dependencyName, hint] of frameworkDependencyHints) {
    if (allDependencies[dependencyName]) {
      hints.add(hint);
    }
  }

  return [...hints];
}

export async function inspectProject(workspaceRoot: string | null | undefined): Promise<ProjectInspection> {
  const analysis = await analyzeProject(workspaceRoot);

  if (!workspaceRoot) {
    return {
      packageManager: null,
      packageName: null,
      packageJsonPath: null,
      scripts: {},
      dependencies: {},
      devDependencies: {},
      frameworkHints: [],
      analysis
    };
  }

  const entries = await fs.readdir(workspaceRoot).catch((): string[] => []);
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const rawPackageJson = entries.includes("package.json") ? await fs.readFile(packageJsonPath, "utf8").catch(() => "") : "";

  if (!rawPackageJson) {
    return {
      packageManager: entries.length ? detectPackageManager(entries) : null,
      packageName: null,
      packageJsonPath: null,
      scripts: {},
      dependencies: {},
      devDependencies: {},
      frameworkHints: [],
      analysis
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawPackageJson);
  } catch {
    return {
      packageManager: detectPackageManager(entries),
      packageName: null,
      packageJsonPath: "package.json",
      scripts: {},
      dependencies: {},
      devDependencies: {},
      frameworkHints: [],
      analysis
    };
  }

  const packageJson = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const scripts = stringRecord(packageJson.scripts);
  const dependencies = stringRecord(packageJson.dependencies);
  const devDependencies = stringRecord(packageJson.devDependencies);

  return {
    packageManager: detectPackageManager(entries),
    packageName: typeof packageJson.name === "string" ? packageJson.name : null,
    packageJsonPath: "package.json",
    scripts,
    dependencies,
    devDependencies,
    frameworkHints: detectFrameworkHints(dependencies, devDependencies),
    analysis
  };
}

export async function inspectCurrentProject() {
  return inspectProject(getWorkspaceRoot());
}
