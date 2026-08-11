export type CommandClassification = {
  kind: "one_shot" | "long_running" | "unknown";
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  script?: string;
  directory?: string;
};

const packageManagers = new Set<NonNullable<CommandClassification["packageManager"]>>(["npm", "pnpm", "yarn", "bun"]);
const longRunningScripts = new Set(["dev", "develop", "serve", "server", "start", "preview", "watch"]);
const oneShotScripts = new Set(["build", "check", "compile", "format", "lint", "test", "typecheck"]);
const directLongRunningCommands = new Set(["vite", "webpack-dev-server"]);

function tokenizeCommand(command: string) {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|[^\s]+/g;

  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[0]);
  }

  return tokens;
}

function normalizedScriptKind(script: string): CommandClassification["kind"] {
  const normalized = script.toLowerCase();
  const baseName = normalized.split(":")[0];

  if (longRunningScripts.has(normalized) || longRunningScripts.has(baseName)) return "long_running";
  if (oneShotScripts.has(normalized) || oneShotScripts.has(baseName)) return "one_shot";
  return "unknown";
}

function parsePackageCommand(command: string) {
  const tokens = tokenizeCommand(command.trim());
  const packageManager = tokens.shift()?.toLowerCase() as CommandClassification["packageManager"] | undefined;

  if (!packageManager || !packageManagers.has(packageManager)) return null;

  let directory: string | undefined;

  while (tokens[0]?.startsWith("-")) {
    const option = tokens.shift() || "";
    const matchedDirectory = option.match(/^(?:--dir|--prefix|--cwd|-C)=(.+)$/i);

    if (matchedDirectory) {
      directory = matchedDirectory[1];
      continue;
    }

    if (["--dir", "--prefix", "--cwd", "-c"].includes(option.toLowerCase())) {
      directory = tokens.shift();
    }
  }

  const subcommand = tokens[0]?.toLowerCase();
  if (subcommand === "run") {
    tokens.shift();
  } else if (["exec", "x", "dlx"].includes(subcommand || "")) {
    // exec/dlx 调用的是二进制而非 package.json script，不能进入脚本目录绑定逻辑。
    return null;
  }
  const script = tokens[0]?.match(/^[\w:.-]+$/)?.[0];
  return script ? { packageManager, script, directory } : null;
}

// 保持现有命令校验接口不变，同时复用目录参数解析逻辑。
export function parsePackageScript(command: string) {
  const parsed = parsePackageCommand(command);
  return parsed ? { script: parsed.script, directory: parsed.directory } : null;
}

// 返回结构化分类，避免调用方再次依赖容易漏掉包管理器参数的正则表达式。
export function classifyCommand(command: string): CommandClassification {
  const tokens = tokenizeCommand(command.trim());
  const executable = tokens[0]?.toLowerCase();
  const packageScript = parsePackageCommand(command);

  if (packageScript) {
    return {
      kind: normalizedScriptKind(packageScript.script),
      ...packageScript
    };
  }

  if (executable === "npx" || executable === "pnpx" || executable === "bunx") {
    const invokedCommand = tokens.find((token, index) => index > 0 && !token.startsWith("-"))?.toLowerCase();
    return { kind: invokedCommand && directLongRunningCommands.has(invokedCommand) ? "long_running" : "unknown" };
  }

  if (executable && directLongRunningCommands.has(executable)) return { kind: "long_running" };
  if (executable === "next" && tokens[1]?.toLowerCase() === "dev") return { kind: "long_running" };
  if (executable === "vue-cli-service" && tokens[1]?.toLowerCase() === "serve") return { kind: "long_running" };

  return { kind: "unknown" };
}
