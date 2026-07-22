import type { CommandInitiator, ShellCapability } from "./types.js";

export type ShellLaunchSpec = {
  name: string;
  capability: ShellCapability;
  file: string;
  args: string[];
};

type ShellOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  initiator?: CommandInitiator;
};

/** 为 Agent 选择可预测的 shell；手工命令仍尊重系统配置。 */
export function resolveShellLaunch(command: string, options: ShellOptions = {}): ShellLaunchSpec {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;

  if (platform === "win32") {
    if (options.initiator === "agent" || options.initiator === "validation") {
      return {
        name: "powershell",
        capability: "rich",
        file: environment.MINI_AI_POWERSHELL_PATH || "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
      };
    }
    return {
      name: "cmd",
      capability: "basic",
      file: environment.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }

  const configuredShell = environment.SHELL?.trim() || "/bin/sh";
  const name = configuredShell.split(/[\\/]/).pop() || "sh";
  return {
    name,
    capability: /(?:bash|zsh|fish|sh)$/i.test(name) ? "basic" : "none",
    file: configuredShell,
    args: ["-lc", command]
  };
}

/** 仅 Agent/验证命令注入机器环境；CI 由调用方按兼容性显式开启。 */
export function createCommandEnvironment(input: { initiator: CommandInitiator; ci?: boolean }, base: NodeJS.ProcessEnv = process.env) {
  const environment = { ...base };
  if (input.initiator === "agent" || input.initiator === "validation") environment.MINI_AI_AGENT = "1";
  if (input.ci === true) environment.CI = "1";
  return environment;
}
