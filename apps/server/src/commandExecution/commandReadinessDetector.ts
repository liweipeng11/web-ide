import { detectLocalReadyUrl, stripAnsi } from "./commandOutputParser.js";

export type CommandReadinessMatch = {
  ready: boolean;
  readyUrl?: string;
  source?: "pattern" | "local_url" | "startup_message";
};

const startupPatterns = [
  /\bready\s+(?:in|on|at)\b/i,
  /\b(?:server|app)\s+(?:is\s+)?(?:running|listening)\b/i,
  /\bcompiled\s+successfully\b/i,
  /\blocal:\s*https?:\/\//i
];

/** 根据显式规则、本地地址和可靠启动文案判断长运行服务是否已经可用。 */
export function detectCommandReadiness(output: string, options: { readyPattern?: string; configuredLocalDomains?: string[] } = {}): CommandReadinessMatch {
  const cleanOutput = stripAnsi(output);

  if (options.readyPattern) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(options.readyPattern, "im");
    } catch {
      throw new Error("readyPattern must be a valid regular expression");
    }
    if (pattern.test(cleanOutput)) return { ready: true, source: "pattern" };
  }

  const readyUrl = detectLocalReadyUrl(cleanOutput, options.configuredLocalDomains);
  if (readyUrl) return { ready: true, readyUrl, source: "local_url" };

  if (startupPatterns.some((pattern) => pattern.test(cleanOutput))) {
    return { ready: true, source: "startup_message" };
  }

  return { ready: false };
}
