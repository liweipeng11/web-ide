import fs from "node:fs/promises";
import path from "node:path";

export type ProjectCommand = {
  name: string;
  command: string;
  source: string;
  language: "javascript" | "unknown";
  packageManager?: string;
  dependencyState?: "installed" | "missing" | "unknown";
};

export function detectPackageManager(files: string[]) {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lockb")) return "bun";
  return "npm";
}

function buildScriptCommand(packageManager: string, scriptName: string) {
  if (packageManager === "npm") {
    return `npm run ${scriptName}`;
  }

  return `${packageManager} ${scriptName}`;
}

async function discoverPackageScripts(workspaceRoot: string): Promise<ProjectCommand[]> {
  const entries = await fs.readdir(workspaceRoot).catch((): string[] => []);

  if (!entries.includes("package.json")) {
    return [];
  }

  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const rawPackageJson = await fs.readFile(packageJsonPath, "utf8").catch(() => "");

  if (!rawPackageJson) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawPackageJson);
  } catch {
    return [];
  }

  const scripts = parsed && typeof parsed === "object" ? (parsed as { scripts?: unknown }).scripts : null;

  if (!scripts || typeof scripts !== "object") {
    return [];
  }

  const packageManager = detectPackageManager(entries);
  const dependencyState = entries.includes("node_modules") || entries.includes(".pnp.cjs") ? "installed" : "missing";

  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name]) => ({
      name,
      command: buildScriptCommand(packageManager, name),
      source: "package.json",
      language: "javascript" as const,
      packageManager,
      dependencyState
    }));
}

export async function discoverProjectCommands(workspaceRoot: string): Promise<ProjectCommand[]> {
  const detectors = [discoverPackageScripts];
  const commandGroups = await Promise.all(detectors.map((detector) => detector(workspaceRoot)));

  return commandGroups.flat();
}
