import type { CommandResult } from "../types.js";

const defaultMaxStoredOutputLength = 12_000;
const defaultMaxPreviewLength = 4_000;
const localHostnames = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

export function stripAnsi(value: string) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function trimUrlPunctuation(value: string) {
  return value.replace(/[)},.;!?]+$/, "");
}

// 收集输出中的全部 HTTP(S) 地址；是否代表本地服务就绪由 detectLocalReadyUrl 单独判断。
export function detectUrls(output: string) {
  const matches = output.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return [...new Set(matches.map(trimUrlPunctuation).filter(Boolean))];
}

export function detectLocalReadyUrl(output: string, configuredLocalDomains: string[] = []) {
  const allowedHosts = new Set([...localHostnames, ...configuredLocalDomains.map((host) => host.trim().toLowerCase()).filter(Boolean)]);

  for (const value of detectUrls(output)) {
    try {
      const url = new URL(value);
      if (allowedHosts.has(url.hostname.toLowerCase())) return value;
    } catch {
      // 外部命令输出可能包含不完整 URL；忽略无效项，继续检查其余候选。
    }
  }

  return undefined;
}

function tail(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

type ParseCommandOutputInput = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
  longRunning: boolean;
  maxStoredOutputLength?: number;
  maxPreviewLength?: number;
};

// 将外部进程输出转换为稳定的摘要和状态，避免普通文档链接触发“服务已就绪”。
export function parseCommandOutput(input: ParseCommandOutputInput) {
  const maxStoredOutputLength = input.maxStoredOutputLength ?? defaultMaxStoredOutputLength;
  const maxPreviewLength = input.maxPreviewLength ?? defaultMaxPreviewLength;
  const stdout = stripAnsi(input.stdout).trim();
  const stderr = stripAnsi(input.stderr).trim();
  const combined = [stderr, stdout].filter(Boolean).join("\n");
  const detectedUrl = detectLocalReadyUrl(combined);
  const status: NonNullable<CommandResult["status"]> = detectedUrl && input.longRunning ? "running" : input.timedOut ? "timeout" : input.exitCode === 0 ? "success" : "failed";
  const preview = tail(combined, maxPreviewLength);
  const summary = [
    status === "running" && detectedUrl ? `Development server is running at ${detectedUrl}.` : "",
    status === "timeout" ? `Command timed out after ${input.timeoutMs / 1000} seconds.` : "",
    status === "success" ? "Command completed successfully." : "",
    status === "failed" ? `Command failed with exit code ${input.exitCode ?? "null"}.` : "",
    preview ? `Output preview:\n${preview}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    detectedUrl,
    detectedUrls: detectUrls(combined),
    status,
    summary,
    stdout: tail(stdout, maxStoredOutputLength),
    stderr: tail(stderr, maxStoredOutputLength),
    outputTruncated: stdout.length > maxStoredOutputLength || stderr.length > maxStoredOutputLength
  };
}
