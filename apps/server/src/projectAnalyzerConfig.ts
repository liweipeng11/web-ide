import type { TechStackAnalysis } from "./projectAnalyzerTypes.js";

export const ignoredDirectoryNames = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".venv", "__pycache__"]);

export const highRiskDirectoryReasons = new Map<string, string>([
  [".git", "版本控制内部目录，直接修改风险极高"],
  ["node_modules", "依赖安装产物，通常不应由代码生成流程修改"],
  ["dist", "构建产物目录，修改后容易被下一次构建覆盖"],
  ["build", "构建产物目录，修改后容易被下一次构建覆盖"],
  [".next", "Next.js 运行产物目录，通常不应直接编辑"],
  [".turbo", "任务缓存目录，直接修改没有稳定收益"],
  ["coverage", "测试覆盖率产物目录，通常由测试命令生成"],
  [".venv", "Python 虚拟环境目录，不应作为业务代码编辑目标"],
  ["__pycache__", "Python 字节码缓存目录，不应直接编辑"]
]);

export const validationScriptPriority = ["test", "typecheck", "type-check", "check", "lint", "build"];

// 配置文件匹配规则用于补足依赖未安装或 package.json 不完整时的技术栈判断。
export const configMatchers: Array<[RegExp, keyof Omit<TechStackAnalysis, "languages" | "configFiles">, string]> = [
  [/^vite\.config\.[cm]?[jt]s$/, "buildTools", "vite"],
  [/^next\.config\.[cm]?[jt]s$/, "frameworks", "next"],
  [/^webpack\.config\.[cm]?[jt]s$/, "buildTools", "webpack"],
  [/^turbo\.json$/, "buildTools", "turbo"],
  [/^nx\.json$/, "buildTools", "nx"],
  [/^tsconfig\.json$/, "typeSystems", "typescript"],
  [/^eslint\.config\.[cm]?[jt]s$/, "lintTools", "eslint"],
  [/^\.eslintrc(?:\..+)?$/, "lintTools", "eslint"],
  [/^ruff\.toml$/, "lintTools", "ruff"],
  [/^mypy\.ini$/, "typeSystems", "mypy"],
  [/^pytest\.ini$/, "frameworks", "pytest"],
  [/^tox\.ini$/, "buildTools", "tox"],
  [/^pyproject\.toml$/, "buildTools", "python"],
  [/^requirements\.txt$/, "buildTools", "python"],
  [/^poetry\.lock$/, "buildTools", "poetry"]
];

// 依赖名到技术栈标签的映射，供 Project Analyzer 生成稳定上下文。
export const dependencyHints: Array<[string, keyof Omit<TechStackAnalysis, "languages" | "configFiles">, string]> = [
  ["react", "frameworks", "react"],
  ["react-dom", "frameworks", "react"],
  ["vue", "frameworks", "vue"],
  ["vue-router", "frameworks", "vue-router"],
  ["next", "frameworks", "next"],
  ["express", "frameworks", "express"],
  ["vite", "buildTools", "vite"],
  ["webpack", "buildTools", "webpack"],
  ["typescript", "typeSystems", "typescript"],
  ["eslint", "lintTools", "eslint"],
  ["vitest", "frameworks", "vitest"],
  ["jest", "frameworks", "jest"],
  ["tsx", "buildTools", "tsx"]
];
