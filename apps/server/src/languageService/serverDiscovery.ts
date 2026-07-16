import fs from "node:fs/promises";
import path from "node:path";

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

export function languageFamily(languageId: string): LanguageServerLaunch["family"] | null {
  if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(languageId)) return "typescript";
  if (languageId === "vue") return "vue";
  if (languageId === "python") return "python";
  return null;
}

async function findWorkspaceNodeBin(workspaceRoot: string, command: string) {
  const packageNames = command === "vue-language-server" ? ["@vue/language-server"] : command.includes("pyright") ? [command.replace("-langserver", "")] : [command];

  for (const packageName of packageNames) {
    const packageJsonPath = path.join(workspaceRoot, "node_modules", ...packageName.split("/"), "package.json");
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
      const binPath = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[command];
      if (binPath) return path.resolve(path.dirname(packageJsonPath), binPath);
    } catch {
      // 工作区未安装该候选服务端时继续尝试 PATH，不将缺失视为启动错误。
    }
  }
  return null;
}

async function findPathCommand(command: string) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
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

/** 仅使用固定白名单发现服务端；不读取项目中的任意命令或参数配置。 */
export async function discoverLanguageServer(workspaceRoot: string, languageId: string): Promise<LanguageServerLaunch | null> {
  const family = languageFamily(languageId);
  if (!family) return null;

  for (const candidate of commandNames[family]) {
    const workspaceBin = await findWorkspaceNodeBin(workspaceRoot, candidate.name);
    if (workspaceBin) return { family, command: process.execPath, args: [workspaceBin, ...candidate.args] };
    const pathCommand = await findPathCommand(candidate.name);
    if (pathCommand) return { family, command: pathCommand, args: [...candidate.args] };
  }
  return null;
}
