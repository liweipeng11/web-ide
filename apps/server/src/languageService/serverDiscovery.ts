import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LanguageServerLaunch = {
  family: "typescript" | "vue" | "python";
  command: string;
  args: string[];
};

const commandNames: Record<LanguageServerLaunch["family"], Array<{ name: string; args: string[] }>> = {
  typescript: [{ name: "typescript-language-server", args: ["--stdio"] }],
  vue: [{ name: "vue-language-server", args: ["--stdio"] }],
  python: [
    { name: "basedpyright-langserver", args: ["--stdio"] },
    { name: "pyright-langserver", args: ["--stdio"] },
    { name: "pylsp", args: [] }
  ]
};

const defaultBuiltInRoot = fileURLToPath(new URL("../../", import.meta.url));

export type LanguageServerDiscoveryOptions = {
  /** 测试或定制部署可覆盖内置依赖根目录，默认指向 apps/server。 */
  builtInRoot?: string;
  /** 测试可隔离系统 PATH，生产环境默认读取当前进程 PATH。 */
  pathValue?: string;
};

export function languageFamily(languageId: string): LanguageServerLaunch["family"] | null {
  if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(languageId)) return "typescript";
  if (languageId === "vue") return "vue";
  if (languageId === "python") return "python";
  return null;
}

async function findNodePackageBin(packageRoot: string, command: string) {
  const packageNames = command === "vue-language-server"
    ? ["@vue/language-server"]
    : command.includes("pyright")
      ? [command.replace("-langserver", "")]
      : [command];

  for (const packageName of packageNames) {
    const packageJsonPath = path.join(packageRoot, "node_modules", ...packageName.split("/"), "package.json");
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
      const binPath = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[command];
      if (binPath) return path.resolve(path.dirname(packageJsonPath), binPath);
    } catch {
      // 当前依赖根目录未安装候选服务端时继续尝试下一来源。
    }
  }
  return null;
}

async function findPathCommand(command: string, pathValue = process.env.PATH ?? "") {
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      const found = await fs.stat(candidate).then((stat) => stat.isFile(), () => false);
      if (found) return candidate;
    }
  }
  return null;
}

/** 仅从固定白名单发现服务端，不读取项目中的任意命令或参数配置。 */
export async function discoverLanguageServer(
  workspaceRoot: string,
  languageId: string,
  options: LanguageServerDiscoveryOptions = {}
): Promise<LanguageServerLaunch | null> {
  const family = languageFamily(languageId);
  if (!family) return null;
  const candidates = commandNames[family];

  // 可信项目可固定自己的语言服务版本，因此任一工作区候选都优先于内置版本。
  for (const candidate of candidates) {
    const workspaceBin = await findNodePackageBin(workspaceRoot, candidate.name);
    if (workspaceBin) return { family, command: process.execPath, args: [workspaceBin, ...candidate.args] };
  }

  // 内置版本保证新项目和离线环境无需额外安装即可获得完整语言能力。
  const builtInRoot = options.builtInRoot ?? defaultBuiltInRoot;
  for (const candidate of candidates) {
    const builtInBin = await findNodePackageBin(builtInRoot, candidate.name);
    if (builtInBin) return { family, command: process.execPath, args: [builtInBin, ...candidate.args] };
  }

  for (const candidate of candidates) {
    const pathCommand = await findPathCommand(candidate.name, options.pathValue);
    if (pathCommand) return { family, command: pathCommand, args: [...candidate.args] };
  }
  return null;
}
