import { HttpError } from "../errors.js";
import type { NormalizedVue2TemplateRequest, Vue2TemplateFragment } from "./types.js";

function tryDecodeBase64(value: string) {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.trim() ? decoded : value;
  } catch {
    return value;
  }
}

function parseJsonArrayString(value: string) {
  const candidates = [value, tryDecodeBase64(value)];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 继续尝试 base64 解码后的内容，最后统一抛出接口错误。
    }
  }

  throw new HttpError(400, "'fragments' must be an array or a base64-encoded array string.");
}

function normalizeTemplate(value: unknown) {
  if (typeof value !== "string") {
    throw new HttpError(400, "'template' must be a string.");
  }

  const decoded = tryDecodeBase64(value);
  return decoded.includes("<") ? decoded : value;
}

function normalizeFragments(value: unknown): Vue2TemplateFragment[] {
  const parsedValue = typeof value === "string" ? parseJsonArrayString(value) : value;

  if (!Array.isArray(parsedValue)) {
    throw new HttpError(400, "'fragments' must be an array.");
  }

  return parsedValue.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HttpError(400, `fragments[${index}] must be an object.`);
    }

    const fragment = item as Partial<Vue2TemplateFragment>;

    if (typeof fragment.section !== "string" || !fragment.section.trim()) {
      throw new HttpError(400, `fragments[${index}].section must be a string.`);
    }

    if (typeof fragment.code !== "string") {
      throw new HttpError(400, `fragments[${index}].code must be a string.`);
    }

    return {
      section: fragment.section.trim(),
      code: fragment.code
    };
  });
}

export function parseVue2TemplateRequest(body: unknown): NormalizedVue2TemplateRequest {
  const requestBody = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  return {
    template: normalizeTemplate(requestBody.template),
    fragments: normalizeFragments(requestBody.fragments)
  };
}
