import { discoverProjectCommands } from "./commandDiscovery.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

const validationScriptPriority = ["test", "typecheck", "type-check", "check", "lint", "build"];

export function isValidationCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  const validationToolPattern = /(?:^|\s)(?:tsc|eslint|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test)(?:\s|$)/;
  return validationScriptPriority.some((name) => new RegExp(`(?:^|\\s|:)${name}(?::|\\s|$)`).test(normalized)) || validationToolPattern.test(normalized);
}

function commandPriority(name: string) {
  const normalized = name.trim().toLowerCase();
  const exactIndex = validationScriptPriority.indexOf(normalized);

  if (exactIndex >= 0) return exactIndex;

  const prefixIndex = validationScriptPriority.findIndex((candidate) => normalized.startsWith(`${candidate}:`));
  return prefixIndex >= 0 ? validationScriptPriority.length + prefixIndex : Number.POSITIVE_INFINITY;
}

export async function selectDefaultValidationCommand() {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) return null;

  return selectDefaultValidationCommandForRoot(workspaceRoot);
}

export async function selectDefaultValidationCommandForRoot(workspaceRoot: string) {
  const commands = await discoverProjectCommands(workspaceRoot);
  const candidate = commands
    .map((command) => ({ command, priority: commandPriority(command.name) }))
    .filter((item) => Number.isFinite(item.priority))
    .sort((left, right) => left.priority - right.priority)[0];

  return candidate?.command.command || null;
}
