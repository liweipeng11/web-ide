import type { CommandResult } from "../../api";

export type CommandSuggestion = {
  command: string;
  cwd?: string;
  reason?: string;
  risk?: string;
};

export type CommandRunState = {
  status: "running" | "done" | "error";
  command: string;
  error?: string;
  result?: CommandResult;
};

const maxRenderedMessageLength = 12_000;

export function formatMessageForDisplay(content: string) {
  if (content.length <= maxRenderedMessageLength) {
    return content;
  }

  return [
    content.slice(0, 4_000),
    "",
    `... 内容过长，已折叠显示（省略 ${content.length - maxRenderedMessageLength} 个字符）...`,
    "",
    content.slice(-8_000)
  ].join("\n");
}

export function parseCommandSuggestion(content: string): { suggestion: CommandSuggestion | null; visibleContent: string } {
  const blockMatch = content.match(/```command-suggestion\s*([\s\S]*?)\s*```/i);

  if (!blockMatch?.[1]) {
    return { suggestion: null, visibleContent: content };
  }

  try {
    const parsed = JSON.parse(blockMatch[1]) as Partial<CommandSuggestion>;

    if (!parsed.command?.trim()) {
      return { suggestion: null, visibleContent: content };
    }

    return {
      suggestion: {
        command: parsed.command.trim(),
        cwd: typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        risk: typeof parsed.risk === "string" ? parsed.risk : ""
      },
      visibleContent: content.replace(blockMatch[0], "").trim()
    };
  } catch {
    return { suggestion: null, visibleContent: content };
  }
}

export function summarizeUnknown(value: unknown) {
  if (value === null || value === undefined) return "";

  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}...` : value;
  }

  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 120)}...` : text;
  } catch {
    return String(value);
  }
}

export function getStringField(value: unknown, field: string) {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[field] === "string" ? String((value as Record<string, unknown>)[field]) : "";
}

export function getNumberField(value: unknown, field: string) {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[field] === "number" ? Number((value as Record<string, unknown>)[field]) : null;
}
