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
  "npm test",
  "pnpm build",
  "pnpm test",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm type-check",
  "pnpm check",
  "yarn build",
  "yarn test",
  "yarn lint",
  "yarn typecheck",
  "yarn type-check",
  "yarn check",
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

  const safeCommand = safeCommands.find((policyCommand) => matchesCommandPrefix(normalizedCommand, policyCommand.toLowerCase()));

  if (safeCommand) {
    return {
      level: "safe",
      reason: `Command is allowlisted: ${safeCommand}`
    };
  }

  return {
    level: "confirm",
    reason: "Command is not in the safe allowlist and requires user confirmation."
  };
}
