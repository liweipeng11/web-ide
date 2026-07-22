import type { CommandInteractionKind } from "./types.js";

const interactionPatterns: Array<{ kind: CommandInteractionKind; pattern: RegExp }> = [
  { kind: "password", pattern: /(?:password|密码)\s*[:：]?\s*$/im },
  { kind: "passphrase", pattern: /(?:passphrase|口令)\s*[:：]?\s*$/im },
  { kind: "pin", pattern: /(?:\bpin\b|个人识别码)\s*[:：]?\s*$/im },
  { kind: "verification_code", pattern: /(?:verification\s+code|one[- ]time\s+(?:code|password)|验证码)\s*[:：]?\s*$/im },
  { kind: "login_confirmation", pattern: /(?:confirm\s+(?:login|sign[ -]?in)|approve\s+(?:login|sign[ -]?in)|确认登录|是否登录).*?(?:\[?y\/n\]?|yes\/no)?\s*$/im }
];

export function detectCommandInteraction(outputTail: string): CommandInteractionKind | null {
  const tail = outputTail.slice(-2_000);
  return interactionPatterns.find(({ pattern }) => pattern.test(tail))?.kind ?? null;
}

/** 模型和 CommandResult 只能看到脱敏文本，完整终端展示不受影响。 */
export function sanitizeSensitiveOutput(output: string) {
  return output
    .replace(/((?:password|passphrase|\bpin\b|verification\s+code|one[- ]time\s+(?:code|password)|密码|口令|验证码)\s*[:：]\s*)\S+/gim, "$1[REDACTED]")
    .replace(/((?:token|secret|api[_ -]?key)\s*[=:]\s*)\S+/gim, "$1[REDACTED]");
}
