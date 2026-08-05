import type { CommandInitiator, ShellCapability } from "./types.js";

export type ShellLaunchSpec = {
  name: string;
  capability: ShellCapability;
  file: string;
  args: string[];
};

/**
 * 将实际执行命令的 Shell 约束转成模型可执行的提示词，避免模型按其它系统的语法组装命令。
 */
export function createAgentCommandShellPrompt(options: ShellOptions = {}) {
  const platform = options.platform ?? process.platform;
  const shell = resolveShellLaunch("", { ...options, initiator: "agent" });

  if (shell.name === "powershell") {
    return [
      "命令执行环境：Windows PowerShell（powershell.exe）。所有 runCommand 的 command 必须使用 PowerShell 语法。",
      "禁止使用 Bash、zsh、cmd.exe 或 Git Bash 语法/包装器：不要使用 bash -c、cmd /c、&&、||、2>&1、$(...) 或 echo $?.",
      "多条命令用 ; 分隔；需要根据上一条命令退出码继续处理时，使用 $LASTEXITCODE 和 if。例如：npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }。",
      "检查文件或目录使用 Test-Path；列出文件使用 Get-ChildItem；环境变量使用 $env:NAME。优先直接运行 npm、node 等程序，不要额外套 shell。"
    ].join("\n");
  }

  const platformLabel = platform === "darwin"
    ? "macOS"
    : platform === "linux"
      ? "Linux"
      : `Unix（${platform}）`;
  const shellSyntax = shell.name.toLowerCase() === "fish"
    ? "Fish 语法（不要假定 Bash/Zsh 的变量赋值、数组或命令替换语法可用）"
    : shell.name.toLowerCase() === "zsh"
      ? "Zsh/POSIX 兼容语法"
      : "POSIX Shell 语法";
  const shellExamples = shell.name.toLowerCase() === "fish"
    ? "不要使用 Bash 的 &&、||、2>&1、$(...) 或 $VAR 语法；按 Fish 语法组合命令和读取环境变量。"
    : "可使用 &&、||、2>&1、$(...) 和 $VAR 等 Unix Shell 语法；不要包装为 PowerShell 或 cmd.exe 命令。";

  return [
    `命令执行环境：${platformLabel}，Shell 为 ${shell.name}（${shell.file}）。所有 runCommand 的 command 必须使用 ${shellSyntax}。`,
    shellExamples,
    "检查文件或目录优先使用 test -e 或 [ -e path ]；列出文件使用 ls；环境变量使用 $NAME。优先直接运行 npm、node 等项目命令。"
  ].join("\n");
}

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
