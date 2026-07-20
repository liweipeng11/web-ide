import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import { safeResolve } from "./fileTools.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import type { ProjectRule, ProjectRulesResponse } from "./types.js";

const legacyRootRuleFiles = [
  { path: "AGENTS.md", source: "agents" as const, title: "AGENTS.md" },
  { path: ".cursorrules", source: "cursor" as const, title: ".cursorrules" },
  { path: ".windsurfrules", source: "windsurf" as const, title: ".windsurfrules" }
];

const miniAiDir = ".mini-ai";
const miniAiRulesDir = ".mini-ai/rules";
const miniAiAgentFile = ".mini-ai/AGENTS.md";
const maxRuleFileChars = 20_000;
const maxCombinedRuleChars = 60_000;

export const supportedProjectRuleFiles = [
  "~/.mini-ai/AGENTS.md",
  "~/.mini-ai/rules/*.md",
  miniAiAgentFile,
  `${miniAiRulesDir}/*.md`,
  ...legacyRootRuleFiles.map((file) => `${file.path} (legacy)`)
];

type RuleMetadata = {
  globs: string[];
  alwaysApply?: boolean;
  body: string;
};

type DiscoverProjectRulesOptions = {
  globalRulesRoot?: string;
};

export type AgentRulesSettings = {
  global: { path: string; content: string };
  project: { path: string; content: string; available: boolean };
};

export type AgentRulesSettingsInput = {
  globalContent?: unknown;
  projectContent?: unknown;
};

function normalizeWorkspacePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeDisplayPath(value: string) {
  return value.replace(/\\/g, "/");
}

function stripInlineQuotes(value: string) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function parseGlobList(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map(stripInlineQuotes)
      .filter(Boolean);
  }

  return trimmed
    .split(",")
    .map(stripInlineQuotes)
    .filter(Boolean);
}

function parseBoolean(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "always"].includes(normalized)) return true;
  if (["false", "no", "0", "manual"].includes(normalized)) return false;
  return undefined;
}

function parseRuleMetadata(content: string): RuleMetadata {
  if (!content.startsWith("---")) {
    return { globs: [], body: content.trim() };
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!match) {
    return { globs: [], body: content.trim() };
  }

  const metadataLines = match[1].split(/\r?\n/);
  const metadata: RuleMetadata = { globs: [], body: match[2].trim() };

  for (const line of metadataLines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (key === "globs" || key === "glob" || key === "paths") {
      metadata.globs = parseGlobList(value);
    }

    if (key === "alwaysapply" || key === "always_apply" || key === "always") {
      metadata.alwaysApply = parseBoolean(value);
    }
  }

  return metadata;
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(glob: string) {
  const normalized = normalizeWorkspacePath(glob);
  let pattern = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      pattern += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += escapeRegex(char);
  }

  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(filePath: string, globs: string[]) {
  const normalizedPath = normalizeWorkspacePath(filePath);

  return globs.some((glob) => {
    const normalizedGlob = normalizeWorkspacePath(glob);
    const candidates = normalizedGlob.includes("/") ? [normalizedGlob] : [normalizedGlob, `**/${normalizedGlob}`];
    return candidates.some((candidate) => globToRegex(candidate).test(normalizedPath));
  });
}

function isRuleActive(rule: Pick<ProjectRule, "alwaysApply" | "globs">, contextPaths: string[]) {
  if (rule.alwaysApply || rule.globs.length === 0) {
    return true;
  }

  if (!contextPaths.length) {
    return false;
  }

  return contextPaths.some((contextPath) => matchesAnyGlob(contextPath, rule.globs));
}

async function readRuleFile(
  absolutePath: string,
  displayPath: string,
  scope: ProjectRule["scope"],
  source: ProjectRule["source"],
  title: string,
  contextPaths: string[]
): Promise<ProjectRule | null> {
  const content = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (content === null) {
    return null;
  }

  const metadata = parseRuleMetadata(content);
  const body = metadata.body.slice(0, maxRuleFileChars);
  const rule = {
    path: normalizeDisplayPath(displayPath),
    scope,
    source,
    title,
    content: body,
    globs: metadata.globs,
    alwaysApply: metadata.alwaysApply ?? metadata.globs.length === 0,
    active: false,
    truncated: metadata.body.length > body.length
  };

  return {
    ...rule,
    active: isRuleActive(rule, contextPaths)
  };
}

async function readRulesDirectory(absoluteRulesDir: string, displayRulesDir: string, scope: ProjectRule["scope"], contextPaths: string[]) {
  const entries = await fs.readdir(absoluteRulesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });

  const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  const rules = await Promise.all(
    markdownFiles.map((entry) => {
      const absolutePath = path.join(absoluteRulesDir, entry.name);
      const displayPath = normalizeDisplayPath(path.posix.join(displayRulesDir, entry.name));
      return readRuleFile(absolutePath, displayPath, scope, "mini-ai", entry.name, contextPaths);
    })
  );

  return rules.filter((rule): rule is ProjectRule => Boolean(rule));
}

async function readMiniAiAgentFile(absoluteFilePath: string, displayPath: string, scope: ProjectRule["scope"], contextPaths: string[]) {
  return readRuleFile(absoluteFilePath, displayPath, scope, "mini-ai", "AGENTS.md", contextPaths);
}

async function readGlobalRules(globalRulesRoot: string, contextPaths: string[]) {
  const agentFile = await readMiniAiAgentFile(path.join(globalRulesRoot, "AGENTS.md"), "~/.mini-ai/AGENTS.md", "global", contextPaths);
  const ruleFiles = await readRulesDirectory(path.join(globalRulesRoot, "rules"), "~/.mini-ai/rules", "global", contextPaths);

  return [agentFile, ...ruleFiles].filter((rule): rule is ProjectRule => Boolean(rule));
}

async function readProjectRules(contextPaths: string[]) {
  const agentFile = await readMiniAiAgentFile(safeResolve(miniAiAgentFile, { allowIgnored: true }), miniAiAgentFile, "project", contextPaths);
  const ruleFiles = await readRulesDirectory(safeResolve(miniAiRulesDir, { allowIgnored: true }), miniAiRulesDir, "project", contextPaths);

  return [agentFile, ...ruleFiles].filter((rule): rule is ProjectRule => Boolean(rule));
}

async function readLegacyProjectRules(contextPaths: string[]) {
  const rules = await Promise.all(
    legacyRootRuleFiles.map((file) => readRuleFile(safeResolve(file.path, { allowIgnored: true }), file.path, "legacy", file.source, file.title, contextPaths))
  );

  return rules.filter((rule): rule is ProjectRule => Boolean(rule));
}

function combineActiveRules(rules: ProjectRule[]) {
  const activeRules = rules.filter((rule) => rule.active && rule.content.trim());

  if (!activeRules.length) {
    return null;
  }

  const combined = [
    "Global and project rules discovered for this workspace. Follow these instructions when they do not conflict with higher-priority system/developer instructions.",
    "",
    ...activeRules.flatMap((rule) => [`## ${rule.scope}: ${rule.path}`, rule.content.trim(), ""])
  ].join("\n");

  return combined.slice(0, maxCombinedRuleChars);
}

export async function ensureProjectRulesDirectory(workspaceRoot = getWorkspaceRoot()) {
  if (!workspaceRoot) {
    return null;
  }

  const rulesRoot = path.join(workspaceRoot, miniAiDir);
  await fs.mkdir(path.join(rulesRoot, "rules"), { recursive: true });
  return rulesRoot;
}

export function getDefaultGlobalRulesRoot() {
  return path.join(os.homedir(), miniAiDir);
}

export async function ensureGlobalRulesDirectory(globalRulesRoot = getDefaultGlobalRulesRoot()) {
  await fs.mkdir(path.join(globalRulesRoot, "rules"), { recursive: true });
  return globalRulesRoot;
}

async function readEditableRule(filePath: string) {
  return fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

function normalizeEditableRule(value: unknown, fieldName: string) {
  if (typeof value !== "string") throw new HttpError(400, `${fieldName} must be a string`);
  if (value.length > maxRuleFileChars) throw new HttpError(400, `${fieldName} cannot exceed ${maxRuleFileChars} characters`);
  return value.replace(/\r\n/g, "\n");
}

/** 读取设置页可直接维护的全局和项目 AGENTS.md。 */
export async function readAgentRulesSettings(options: DiscoverProjectRulesOptions = {}): Promise<AgentRulesSettings> {
  const globalRulesRoot = options.globalRulesRoot || getDefaultGlobalRulesRoot();
  const workspaceRoot = getWorkspaceRoot();

  return {
    global: {
      path: "~/.mini-ai/AGENTS.md",
      content: await readEditableRule(path.join(globalRulesRoot, "AGENTS.md"))
    },
    project: {
      path: miniAiAgentFile,
      content: workspaceRoot ? await readEditableRule(safeResolve(miniAiAgentFile, { allowIgnored: true })) : "",
      available: Boolean(workspaceRoot)
    }
  };
}

/** 保存设置页中的 AGENTS.md；未提交的作用域保持原内容不变。 */
export async function writeAgentRulesSettings(input: AgentRulesSettingsInput, options: DiscoverProjectRulesOptions = {}) {
  const globalRulesRoot = options.globalRulesRoot || getDefaultGlobalRulesRoot();
  const workspaceRoot = getWorkspaceRoot();

  if (input.globalContent === undefined && input.projectContent === undefined) {
    throw new HttpError(400, "At least one Agent Rules field is required");
  }

  if (input.globalContent !== undefined) {
    const content = normalizeEditableRule(input.globalContent, "globalContent");
    await ensureGlobalRulesDirectory(globalRulesRoot);
    await fs.writeFile(path.join(globalRulesRoot, "AGENTS.md"), content, "utf8");
  }

  if (input.projectContent !== undefined) {
    if (!workspaceRoot) throw new HttpError(400, "Open a workspace before saving project Agent Rules");
    const content = normalizeEditableRule(input.projectContent, "projectContent");
    await ensureProjectRulesDirectory(workspaceRoot);
    await fs.writeFile(safeResolve(miniAiAgentFile, { allowIgnored: true }), content, "utf8");
  }

  return readAgentRulesSettings({ globalRulesRoot });
}

export async function discoverProjectRules(contextPaths: string[] = [], options: DiscoverProjectRulesOptions = {}): Promise<ProjectRulesResponse> {
  if (!getWorkspaceRoot()) {
    return {
      rules: [],
      combinedInstructions: null,
      supportedFiles: supportedProjectRuleFiles
    };
  }

  const normalizedContextPaths = contextPaths.map(normalizeWorkspacePath).filter(Boolean);
  const globalRulesRoot = options.globalRulesRoot || getDefaultGlobalRulesRoot();
  const rules = [
    ...(await readGlobalRules(globalRulesRoot, normalizedContextPaths)),
    ...(await readProjectRules(normalizedContextPaths)),
    ...(await readLegacyProjectRules(normalizedContextPaths))
  ];

  return {
    rules,
    combinedInstructions: combineActiveRules(rules),
    supportedFiles: supportedProjectRuleFiles
  };
}
