import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import { parsePackageScript } from "./commandClassifier.js";

const ignoredDirectoryNames = new Set([
  ".git",
  ".mini-ai",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);
const packageManifestLimit = 200;

type PackageManifest = {
  directory: string;
  relativePath: string;
  scripts: Record<string, string>;
};

export type PackageScriptResolution = {
  cwd: string;
  packageDirectory?: string;
  packageJsonPath?: string;
  script?: string;
};

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/") || ".";
}

function resolveInsideWorkspace(workspaceRoot: string, value?: string) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = value
    ? path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(resolvedRoot, value)
    : resolvedRoot;
  const relativePath = path.relative(resolvedRoot, resolvedPath);

  // cwd 属于命令安全边界，禁止通过绝对路径或 .. 逃出当前工作区。
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new HttpError(400, "Command working directory must stay inside the workspace");
  }

  return resolvedPath;
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

async function readPackageManifest(workspaceRoot: string, packageJsonPath: string): Promise<PackageManifest | null> {
  const raw = await fs.readFile(packageJsonPath, "utf8").catch(() => "");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    const directory = path.dirname(packageJsonPath);
    return {
      directory,
      relativePath: normalizeRelativePath(path.relative(workspaceRoot, packageJsonPath)),
      scripts: stringRecord(parsed.scripts)
    };
  } catch {
    return null;
  }
}

async function collectPackageManifests(workspaceRoot: string) {
  const manifests: PackageManifest[] = [];

  async function visit(directory: string) {
    if (manifests.length >= packageManifestLimit) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (manifests.length >= packageManifestLimit) return;
      if (entry.isSymbolicLink()) continue;

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectoryNames.has(entry.name)) {
        await visit(absolutePath);
      } else if (entry.isFile() && entry.name === "package.json") {
        const manifest = await readPackageManifest(workspaceRoot, absolutePath);
        if (manifest) manifests.push(manifest);
      }
    }
  }

  await visit(workspaceRoot);
  return manifests;
}

function missingScriptMessage(script: string, packageJsonPath: string) {
  return `Package script "${script}" is missing in ${packageJsonPath}.`;
}

/**
 * 将包脚本与实际执行目录绑定。显式 cwd/目录参数优先；只有唯一子包匹配时才自动推断，
 * 避免 monorepo 中同名脚本被静默运行到错误项目。
 */
export async function resolvePackageScriptExecution(
  workspaceRoot: string,
  command: string,
  requestedCwd?: string
): Promise<PackageScriptResolution> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const commandCwd = resolveInsideWorkspace(resolvedRoot, requestedCwd);
  const parsed = parsePackageScript(command);
  if (!parsed) return { cwd: commandCwd };

  if (parsed.directory) {
    const packageDirectory = resolveInsideWorkspace(resolvedRoot, path.resolve(commandCwd, parsed.directory));
    const packageJsonPath = path.join(packageDirectory, "package.json");
    const manifest = await readPackageManifest(resolvedRoot, packageJsonPath);
    if (!manifest?.scripts[parsed.script]) {
      throw new HttpError(400, missingScriptMessage(parsed.script, normalizeRelativePath(path.relative(resolvedRoot, packageJsonPath))));
    }
    return {
      cwd: commandCwd,
      packageDirectory,
      packageJsonPath: manifest.relativePath,
      script: parsed.script
    };
  }

  if (requestedCwd?.trim()) {
    const packageJsonPath = path.join(commandCwd, "package.json");
    const manifest = await readPackageManifest(resolvedRoot, packageJsonPath);
    if (!manifest?.scripts[parsed.script]) {
      throw new HttpError(400, missingScriptMessage(parsed.script, normalizeRelativePath(path.relative(resolvedRoot, packageJsonPath))));
    }
    return {
      cwd: commandCwd,
      packageDirectory: commandCwd,
      packageJsonPath: manifest.relativePath,
      script: parsed.script
    };
  }

  const manifests = await collectPackageManifests(resolvedRoot);
  const matches = manifests.filter((manifest) => Boolean(manifest.scripts[parsed.script]));

  if (matches.length === 1) {
    const [manifest] = matches;
    return {
      cwd: manifest.directory,
      packageDirectory: manifest.directory,
      packageJsonPath: manifest.relativePath,
      script: parsed.script
    };
  }

  if (matches.length > 1) {
    const candidates = matches.map((manifest) => normalizeRelativePath(path.dirname(manifest.relativePath))).join(", ");
    throw new HttpError(
      400,
      `Package script "${parsed.script}" exists in multiple directories: ${candidates}. Specify cwd or a package-manager directory option.`
    );
  }

  throw new HttpError(400, `Package script "${parsed.script}" is missing in the workspace.`);
}
