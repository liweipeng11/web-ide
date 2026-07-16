import type { ModelMessage } from "../contracts/model.js";

export interface TokenEstimator {
  readonly kind: "provider" | "conservative";
  estimateText(value: string): number;
  estimateMessages(messages: ModelMessage[]): number;
  estimateValue(value: unknown): number;
}

/**
 * Provider tokenizer 尚不可用时使用偏保守的字符估算。
 * 该数值只用于预算门禁，不会作为精确 usage 展示或计费依据。
 */
export class ConservativeTokenEstimator implements TokenEstimator {
  readonly kind = "conservative" as const;

  estimateText(value: string) {
    if (!value) return 0;
    const asciiLength = value.replace(/[^\x00-\x7F]/g, "").length;
    const nonAsciiLength = value.length - asciiLength;
    return Math.ceil(asciiLength / 3.2 + nonAsciiLength / 1.5);
  }

  estimateValue(value: unknown) {
    try {
      return this.estimateText(typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      return this.estimateText(String(value));
    }
  }

  estimateMessages(messages: ModelMessage[]) {
    return messages.reduce((total, message) => total + 12 + this.estimateValue(message), 0);
  }
}

