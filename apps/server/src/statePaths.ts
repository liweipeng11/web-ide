import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { safeResolve } from "./fileTools.js";

const projectRuntimeRoot = ".mini-ai/state/runtime";
const legacyProjectRuntimeRoot = ".ai-agent";

type RuntimeDirectoryName = "checkpoints" | "task-sessions" | "ai-logs" | "external-context";

export function appStatePath(fileName: string) {
  return path.join(config.stateDirectory, fileName);
}

export function legacyAppStatePath(fileName: string) {
  return path.join(config.legacyStateDirectory, fileName);
}

export function projectRuntimeDirectory(name: RuntimeDirectoryName) {
  return safeResolve(`${projectRuntimeRoot}/${name}`, { allowIgnored: true });
}

export function legacyProjectRuntimeDirectory(name: RuntimeDirectoryName) {
  return safeResolve(`${legacyProjectRuntimeRoot}/${name}`, { allowIgnored: true });
}

export async function readTextWithLegacyFallback(primaryPath: string, legacyPath: string) {
  const primary = await fs.readFile(primaryPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (primary !== null) {
    return primary;
  }

  return fs.readFile(legacyPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
}

export async function listJsonFilesWithLegacyFallback(primaryDirectory: string, legacyDirectory: string) {
  const readDirectory = async (directory: string) =>
    fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });

  const [primaryEntries, legacyEntries] = await Promise.all([readDirectory(primaryDirectory), readDirectory(legacyDirectory)]);
  const primaryFiles = primaryEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(primaryDirectory, entry.name));
  const primaryNames = new Set(primaryEntries.map((entry) => entry.name));
  const legacyFiles = legacyEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !primaryNames.has(entry.name)).map((entry) => path.join(legacyDirectory, entry.name));

  return [...primaryFiles, ...legacyFiles];
}
