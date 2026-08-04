import type { AgentContext } from "./agentToolTypes.js";

const dependencyOperationPatterns = [
  /(?:添加|安装|引入|接入|移除|卸载|删除|升级|更新).{0,30}(?:依赖|包|库|组件库|插件|SDK)/i,
  /(?:依赖|包|库|组件库|插件|SDK).{0,30}(?:添加|安装|引入|接入|移除|卸载|删除|升级|更新)/i,
  /\b(?:add|install|introduce|remove|uninstall|upgrade|update)\b.{0,40}\b(?:dependency|dependencies|package|library|plugin|sdk)\b/i,
  /\b(?:dependency|dependencies|package|library|plugin|sdk)\b.{0,40}\b(?:add|install|introduce|remove|uninstall|upgrade|update)\b/i
];

const explicitManifestEditPatterns = [
  /(?:手动|直接).{0,12}(?:修改|编辑|写入).{0,20}(?:依赖|清单|锁文件|package\.json|manifest)/i,
  /(?:不要|无需|禁止).{0,12}(?:执行|运行).{0,10}(?:命令|包管理器)/i,
  /\b(?:manually|directly)\s+(?:edit|modify|write).{0,30}(?:manifest|lockfile|dependencies|package\.json)\b/i,
  /\b(?:do not|don't|without)\s+(?:run|use).{0,20}(?:command|package manager)\b/i
];

const dependencyManagedFiles = [
  /(^|\/)package\.json$/i,
  /(^|\/)(?:package-lock|npm-shrinkwrap)\.json$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)bun\.lockb?$/i,
  /(^|\/)pyproject\.toml$/i,
  /(^|\/)(?:poetry|pdm|uv)\.lock$/i,
  /(^|\/)requirements(?:[-_.][^/]+)?\.txt$/i,
  /(^|\/)Pipfile(?:\.lock)?$/i,
  /(^|\/)Cargo\.(?:toml|lock)$/i,
  /(^|\/)go\.(?:mod|sum)$/i,
  /(^|\/)Gemfile(?:\.lock)?$/i,
  /(^|\/)[^/]+\.(?:csproj|fsproj|vbproj)$/i,
  /(^|\/)packages\.config$/i
];

const dependencyManagerCommandPatterns = [
  /\b(?:npm|pnpm|yarn|bun)\b[^\r\n;&|]*\b(?:add|install|i|remove|uninstall|update|upgrade|up)\b/i,
  /\b(?:pip|pip3|poetry|pipenv|uv|pdm)\b[^\r\n;&|]*\b(?:add|install|remove|uninstall|update|upgrade|sync)\b/i,
  /\bcargo\b[^\r\n;&|]*\b(?:add|remove|update)\b/i,
  /\bgo\b[^\r\n;&|]*\b(?:get|mod\s+tidy)\b/i,
  /\b(?:bundle|gem)\b[^\r\n;&|]*\b(?:add|install|remove|uninstall|update)\b/i,
  /\bdotnet\b[^\r\n;&|]*\b(?:add|remove)\b[^\r\n;&|]*\bpackage\b/i
];

function normalizePath(filePath: string) {
  return filePath.trim().replace(/\\/g, "/");
}

function collectEditPaths(toolName: string, args: Record<string, unknown>) {
  const paths = new Set<string>();
  const filePath = typeof args.filePath === "string" ? normalizePath(args.filePath) : "";
  if (filePath) paths.add(filePath);

  if (toolName === "proposePatch" && Array.isArray(args.plannedChanges)) {
    for (const change of args.plannedChanges) {
      if (!change || typeof change !== "object" || Array.isArray(change)) continue;
      const value = (change as { filePath?: unknown }).filePath;
      const plannedPath = typeof value === "string" ? normalizePath(value) : "";
      if (plannedPath) paths.add(plannedPath);
    }
  }

  return [...paths];
}

export function isDependencyOperationRequest(userGoal: string) {
  return dependencyOperationPatterns.some((pattern) => pattern.test(userGoal));
}

export function explicitlyAllowsManifestEditing(userGoal: string) {
  return explicitManifestEditPatterns.some((pattern) => pattern.test(userGoal));
}

export function isDependencyManagedFile(filePath: string) {
  const normalized = normalizePath(filePath);
  return dependencyManagedFiles.some((pattern) => pattern.test(normalized));
}

export function isDependencyManagerCommand(command: string) {
  return dependencyManagerCommandPatterns.some((pattern) => pattern.test(command));
}

/**
 * 依赖增删升级应由包管理器维护清单和锁文件，避免模型用脆弱的文本替换制造状态漂移。
 */
export function getDependencyOperationEditBlockReason(input: {
  toolName: string;
  toolArguments: Record<string, unknown>;
  agentContext: AgentContext;
  runCommandAvailable: boolean;
}) {
  const { toolName, toolArguments, agentContext, runCommandAvailable } = input;
  if (!runCommandAvailable || !["proposePatch", "replaceInFile", "writeFile"].includes(toolName)) return null;
  if (!isDependencyOperationRequest(agentContext.userGoal) || explicitlyAllowsManifestEditing(agentContext.userGoal)) return null;

  const managedPaths = collectEditPaths(toolName, toolArguments).filter(isDependencyManagedFile);
  if (!managedPaths.length) return null;

  const dependencyCommands = (agentContext.commandsRun || []).filter((entry) => isDependencyManagerCommand(entry.command));
  const successfulCommand = dependencyCommands.find((entry) => entry.status === "success");
  if (successfulCommand) {
    return `Dependency manifest or lockfile is already managed by the successful package-manager command "${successfulCommand.command}". Re-read the generated state and continue with required source configuration or validation; do not patch ${managedPaths.join(", ")} manually.`;
  }

  const failedCommand = [...dependencyCommands].reverse().find((entry) => entry.status === "failed" || entry.status === "cancelled");
  if (failedCommand) {
    return `The package-manager command "${failedCommand.command}" did not succeed. Inspect its output and the current manifest/lockfile, then run a corrected package-manager command. Do not bypass the failure by patching ${managedPaths.join(", ")} manually unless the user explicitly requests a manual manifest edit.`;
  }

  return `Dependency changes for ${managedPaths.join(", ")} must be performed with the project's detected package manager via runCommand first. Detect it from packageManager metadata and lockfiles, use the requested subproject as cwd, and let the command update manifests and lockfiles atomically.`;
}
