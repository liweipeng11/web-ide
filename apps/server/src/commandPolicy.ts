export type CommandRiskLevel = "safe" | "confirm" | "blocked";

export type CommandPolicyResult = {
  level: CommandRiskLevel;
  reason: string;
};

const safeCommands = [
  "npm run build",
  "npm run test",
  "npm run lint",
  "npm run typecheck",
  "npm run type-check",
  "npm run check",
  "npm run format:check",
  "npm run format-check",
  "npm test",
  "pnpm build",
  "pnpm test",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm type-check",
  "pnpm check",
  "pnpm format:check",
  "pnpm format-check",
  "yarn build",
  "yarn test",
  "yarn lint",
  "yarn typecheck",
  "yarn type-check",
  "yarn check",
  "yarn format:check",
  "yarn format-check",
  "npm run dev",
  "npm run serve"
];

const confirmCommands = ["npm install", "pnpm add", "yarn add", "git reset", "git checkout", "curl", "wget"];

const blockedCommands = ["rm -rf", "sudo", "chmod -R 777", "mkfs", "shutdown", "reboot"];

function normalizeCommand(command: string) {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function matchesCommandPrefix(command: string, policyCommand: string) {
  return command === policyCommand || command.startsWith(`${policyCommand} `);
}

function isValidationScriptName(value: string) {
  return /^(?:format:check|format-check|check|typecheck|type-check|lint|test|build)(?::[a-z0-9_.-]+)*$/i.test(value);
}

// 自动验证白名单只接受完整命令结构，不允许通过命令参数拼接额外 shell 操作。
function isSafeRootValidationCommand(command: string) {
  const pnpmOrYarn = command.match(/^(?:pnpm|yarn)\s+([^\s]+)$/i);
  if (pnpmOrYarn) return isValidationScriptName(pnpmOrYarn[1]);

  const npm = command.match(/^npm\s+(?:run\s+)?([^\s]+)$/i);
  return Boolean(npm && isValidationScriptName(npm[1]));
}

// workspace 子包验证命令仅允许受控目录和验证脚本名。
function isSafeWorkspaceValidationCommand(command: string) {
  const matched = command.match(/^(?:pnpm\s+--dir|npm\s+--prefix)\s+([a-z0-9_./\\-]+)\s+(?:run\s+)?([^\s]+)$/i);
  return Boolean(matched && isValidationScriptName(matched[2]));
}

export function evaluateCommandPolicy(command: string): CommandPolicyResult {
  const normalizedCommand = normalizeCommand(command);

  if (!normalizedCommand) {
    return {
      level: "blocked",
      reason: "Empty commands cannot be executed."
    };
  }

  const blockedCommand = blockedCommands.find((policyCommand) => normalizedCommand.includes(policyCommand.toLowerCase()));

  if (blockedCommand) {
    return {
      level: "blocked",
      reason: `Command contains blocked pattern: ${blockedCommand}`
    };
  }

  const confirmCommand = confirmCommands.find((policyCommand) => matchesCommandPrefix(normalizedCommand, policyCommand.toLowerCase()));

  if (confirmCommand) {
    return {
      level: "confirm",
      reason: `Command requires user confirmation: ${confirmCommand}`
    };
  }

  const safeCommand = safeCommands.find((policyCommand) => normalizedCommand === policyCommand.toLowerCase());

  if (safeCommand || isSafeRootValidationCommand(normalizedCommand) || isSafeWorkspaceValidationCommand(normalizedCommand)) {
    return {
      level: "safe",
      reason: `Command is allowlisted: ${safeCommand || "validation script"}`
    };
  }

  return {
    level: "confirm",
    reason: "Command is not in the safe allowlist and requires user confirmation."
  };
}
