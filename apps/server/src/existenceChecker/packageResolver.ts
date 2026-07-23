import fs from "node:fs/promises";
import path from "node:path";
import type { ExistenceCandidate, ReferenceResolution } from "./types.js";

type PackageJson = {
  name?: string;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

export type PackageResolverOptions = {
  workspaceRoot: string;
  specifier: string;
  fromPath?: string;
};

const PACKAGE_JSON = "package.json";
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", ".mini-ai", ".ai-agent"]);
const IMPORT_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".cjs", ".json"];

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readPackageJson(filePath: string): Promise<PackageJson | null> {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  try {
    return content ? JSON.parse(content) as PackageJson : null;
  } catch {
    return null;
  }
}

async function pathExists(filePath: string) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

async function resolvePackageTarget(workspaceRoot: string, packageDirectory: string, subpath: string, detail: string) {
  const basePath = subpath ? path.join(packageDirectory, subpath) : path.join(packageDirectory, PACKAGE_JSON);
  const candidates: ExistenceCandidate[] = [];
  for (const extension of IMPORT_EXTENSIONS) {
    const filePath = `${basePath}${extension}`;
    if (isInside(workspaceRoot, filePath) && await pathExists(filePath)) {
      candidates.push({ path: normalizePath(path.relative(workspaceRoot, filePath)), detail });
    }
  }
  if (subpath) {
    for (const extension of IMPORT_EXTENSIONS.slice(1)) {
      const filePath = path.join(basePath, `index${extension}`);
      if (isInside(workspaceRoot, filePath) && await pathExists(filePath)) {
        candidates.push({ path: normalizePath(path.relative(workspaceRoot, filePath)), detail: `${detail}（目录 index）` });
      }
    }
  }
  return candidates.filter((candidate, index, all) => all.findIndex((item) => item.path === candidate.path) === index);
}

function splitPackageSpecifier(specifier: string) {
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return { packageName, subpath: specifier.slice(packageName.length).replace(/^\//, "") };
}

function dependencyDeclared(manifest: PackageJson | null, packageName: string) {
  return Boolean(
    manifest?.dependencies?.[packageName]
    || manifest?.devDependencies?.[packageName]
    || manifest?.peerDependencies?.[packageName]
    || manifest?.optionalDependencies?.[packageName]
  );
}

function ancestorDirectories(workspaceRoot: string, startDirectory: string) {
  const directories: string[] = [];
  let current = startDirectory;
  while (isInside(workspaceRoot, current)) {
    directories.push(current);
    if (path.resolve(current) === path.resolve(workspaceRoot)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

async function findWorkspacePackages(workspaceRoot: string, packageName: string) {
  const matches: string[] = [];
  async function visit(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
      if (entry.isFile() && entry.name === PACKAGE_JSON) {
        const manifest = await readPackageJson(absolutePath);
        if (manifest?.name === packageName) matches.push(path.dirname(absolutePath));
      }
    }
  }
  await visit(workspaceRoot);
  return matches;
}

function resolution(
  status: ReferenceResolution["status"],
  blocking: boolean,
  reason: string,
  candidates: ExistenceCandidate[],
  extras: Pick<ReferenceResolution, "packageRoot" | "resolvedPath"> = {}
): ReferenceResolution {
  return { status, blocking, reason, candidates, ...extras };
}

/**
 * 从引用文件所属目录向上解析依赖，确保多包仓库优先使用最近包边界。
 */
export async function resolvePackageImport(options: PackageResolverOptions): Promise<ReferenceResolution> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const fromAbsolutePath = path.resolve(workspaceRoot, options.fromPath || PACKAGE_JSON);
  if (!isInside(workspaceRoot, fromAbsolutePath)) {
    return resolution("unknown", true, "引用发起路径超出工作区，已阻止包解析", []);
  }

  const specifier = options.specifier.trim();
  const { packageName, subpath } = splitPackageSpecifier(specifier);
  if (!packageName || packageName === "@") return resolution("truly_missing", true, "包引用格式无效", []);

  const ancestors = ancestorDirectories(workspaceRoot, path.dirname(fromAbsolutePath));
  const packageBoundaries: Array<{ directory: string; manifestPath: string; manifest: PackageJson }> = [];
  for (const directory of ancestors) {
    const manifestPath = path.join(directory, PACKAGE_JSON);
    const manifest = await readPackageJson(manifestPath);
    if (manifest) packageBoundaries.push({ directory, manifestPath, manifest });
  }
  const nearestBoundary = packageBoundaries[0];
  const declaringBoundary = packageBoundaries.find((boundary) => dependencyDeclared(boundary.manifest, packageName));

  // Node 的查找顺序天然保证子包 node_modules 优先于工作区根目录。
  for (const directory of ancestors) {
    const installedDirectory = path.join(directory, "node_modules", packageName);
    const installedManifest = await readPackageJson(path.join(installedDirectory, PACKAGE_JSON));
    if (installedManifest?.name !== packageName) continue;
    const candidates = await resolvePackageTarget(workspaceRoot, installedDirectory, subpath, "已安装包");
    if (!candidates.length) {
      return resolution("truly_missing", true, `依赖 ${packageName} 已安装，但子路径 ${subpath} 不存在`, [], {
        packageRoot: normalizePath(path.relative(workspaceRoot, nearestBoundary?.directory || directory))
      });
    }
    return resolution("dependency_installed", false, `依赖 ${packageName} 已从最近的 node_modules 解析`, candidates, {
      packageRoot: normalizePath(path.relative(workspaceRoot, nearestBoundary?.directory || directory)),
      resolvedPath: candidates[0].path
    });
  }

  const workspacePackages = await findWorkspacePackages(workspaceRoot, packageName);
  const workspaceCandidates = (await Promise.all(
    workspacePackages.map((directory) => resolvePackageTarget(workspaceRoot, directory, subpath, "工作区包"))
  )).flat();
  if (workspaceCandidates.length === 1) {
    return resolution("existing", false, `工作区包 ${packageName} 已解析`, workspaceCandidates, {
      packageRoot: normalizePath(path.relative(workspaceRoot, workspacePackages[0])),
      resolvedPath: workspaceCandidates[0].path
    });
  }
  if (workspaceCandidates.length > 1) {
    return resolution("ambiguous", true, `工作区内存在多个 ${packageName} 候选`, workspaceCandidates);
  }

  if (declaringBoundary) {
    const candidate = {
      path: normalizePath(path.relative(workspaceRoot, declaringBoundary.manifestPath)),
      detail: `声明依赖 ${packageName}`
    };
    return resolution("dependency_declared", true, `依赖 ${packageName} 已声明，但未确认安装`, [candidate], {
      packageRoot: normalizePath(path.relative(workspaceRoot, declaringBoundary.directory))
    });
  }

  return resolution("truly_missing", true, `未找到包 ${packageName} 的声明、安装位置或工作区包`, []);
}
