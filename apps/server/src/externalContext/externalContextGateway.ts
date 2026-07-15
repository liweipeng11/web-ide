import { config } from "../config.js";
import type { ExternalContextGatewayOptions, ExternalContextSource, ExternalDocumentResult, ExternalSearchInput, ExternalSearchResult } from "./types.js";
import { validateExternalUrl } from "./urlPolicy.js";

const MAX_REDIRECTS = 5;
const ACCEPTED_DOCUMENT_TYPES = ["text/html", "text/plain", "text/markdown", "application/json", "application/yaml", "application/x-yaml", "text/yaml"];
const API_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

type RedirectPolicy = {
  sameOriginOnly?: boolean;
  requireHttps?: boolean;
};

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const value = Number(code);
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
    });
}

function extractHtml(html: string, baseUrl: URL) {
  const title = normalizeText(decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || baseUrl.hostname));
  const links: Array<{ text: string; url: string }> = [];
  const linkPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(linkPattern)) {
    if (links.length >= 50) break;
    try {
      const url = new URL(match[1], baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      links.push({ text: normalizeText(decodeHtml(match[2].replace(/<[^>]+>/g, " "))).slice(0, 200), url: url.toString() });
    } catch {
      // 忽略页面中的无效链接，不影响正文提取。
    }
  }

  const content = normalizeText(
    decodeHtml(
      html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--([\s\S]*?)-->/g, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );

  return { title, content, links };
}

function normalizeDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.endsWith(".")) throw new Error(`Invalid documentation domain: ${value}`);
  return domain;
}

function inspectApiSchema(content: string, contentType: string): ExternalDocumentResult["apiSchema"] {
  if (contentType === "application/json") {
    try {
      const value = JSON.parse(content) as Record<string, unknown>;
      const pathsValue = value.paths && typeof value.paths === "object" && !Array.isArray(value.paths) ? (value.paths as Record<string, unknown>) : {};
      const paths = Object.keys(pathsValue).slice(0, 200);
      let operationCount = 0;
      for (const pathItem of Object.values(pathsValue)) {
        if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;
        operationCount += Object.keys(pathItem).filter((key) => API_METHODS.has(key.toLowerCase())).length;
      }
      const info = value.info && typeof value.info === "object" && !Array.isArray(value.info) ? (value.info as Record<string, unknown>) : {};
      const openApiVersion = typeof value.openapi === "string" ? value.openapi : typeof value.swagger === "string" ? value.swagger : undefined;
      return {
        format: openApiVersion ? "openapi_json" : "json",
        title: typeof info.title === "string" ? info.title : undefined,
        version: typeof info.version === "string" ? info.version : openApiVersion,
        operationCount: openApiVersion ? operationCount : undefined,
        paths: openApiVersion ? paths : undefined
      };
    } catch {
      return undefined;
    }
  }

  if (["application/yaml", "application/x-yaml", "text/yaml"].includes(contentType)) {
    const openApiVersion = content.match(/^\s*(?:openapi|swagger):\s*["']?([^\s"']+)/m)?.[1];
    const paths = [...content.matchAll(/^\s{0,4}(\/[^:\r\n]+):\s*$/gm)].map((match) => match[1]).slice(0, 200);
    const operationCount = [...content.matchAll(/^\s+(get|put|post|delete|options|head|patch|trace):\s*$/gim)].length;
    return { format: openApiVersion ? "openapi_yaml" : "yaml", version: openApiVersion, operationCount: openApiVersion ? operationCount : undefined, paths: openApiVersion ? paths : undefined };
  }

  return undefined;
}

async function readLimitedBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error(`External response exceeds ${maxBytes} bytes`);
  if (!response.body) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

export class ExternalContextGateway {
  private readonly options: ExternalContextGatewayOptions;

  constructor(options: ExternalContextGatewayOptions) {
    if (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) throw new Error("External context timeout must be a positive number");
    if (!Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) throw new Error("External context response budget must be a positive integer");
    this.options = options;
  }

  async search(input: ExternalSearchInput): Promise<ExternalSearchResult> {
    const query = input.query.trim();
    if (!query) throw new Error("query is required");
    if (!this.options.searchApiKey) throw new Error("BRAVE_SEARCH_API_KEY is not configured");

    const domains = [...new Set((input.domains || []).map(normalizeDomain))].slice(0, 5);
    if (input.officialOnly && !domains.length) throw new Error("Official documentation search requires at least one domain");
    const count = Math.min(Math.max(input.count || 5, 1), 10);
    const scopedQuery = domains.length ? `${query} (${domains.map((domain) => `site:${domain}`).join(" OR ")})` : query;
    const searchUrl = new URL(this.options.searchBaseUrl);
    if (searchUrl.protocol !== "https:") throw new Error("Search provider URL must use https");
    searchUrl.searchParams.set("q", scopedQuery);
    searchUrl.searchParams.set("count", String(count));

    const { text } = await this.request(searchUrl, { headers: { Accept: "application/json", "X-Subscription-Token": this.options.searchApiKey } }, true, 0, { sameOriginOnly: true, requireHttps: true });
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Search provider returned invalid JSON");
    }

    const rawResults = payload && typeof payload === "object" && "web" in payload && (payload as { web?: { results?: unknown } }).web?.results;
    const results = Array.isArray(rawResults) ? rawResults : [];
    const retrievedAt = new Date().toISOString();
    const trustedDomains = new Set((this.options.trustedDocumentationDomains || []).map(normalizeDomain));
    const sources = results.flatMap((entry): ExternalContextSource[] => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.url !== "string") return [];
      try {
        const url = new URL(value.url);
        const domain = url.hostname.toLowerCase().replace(/^www\./, "");
        const matchesDomainScope = domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
        if (domains.length && !matchesDomainScope) return [];
        const trusted = input.officialOnly === true && [...trustedDomains].some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
        return [{
          kind: input.officialOnly ? "official_docs" : "web_search",
          title: typeof value.title === "string" ? normalizeText(value.title) : url.hostname,
          url: url.toString(),
          snippet: typeof value.description === "string" ? normalizeText(value.description).slice(0, 1000) : "",
          domain,
          retrievedAt,
          trusted,
          trustReason: trusted ? "configured_official" : matchesDomainScope ? "domain_matched" : "untrusted"
        }];
      } catch {
        return [];
      }
    }).slice(0, count);

    return { query, provider: "brave", sources };
  }

  async fetchDocument(rawUrl: string, kind: "browser" | "api_docs"): Promise<ExternalDocumentResult> {
    const initialUrl = new URL(rawUrl);
    const { response, text, truncated } = await this.request(initialUrl, { headers: { Accept: kind === "api_docs" ? "application/json, application/yaml, text/yaml, text/plain, text/html" : "text/html, text/plain, text/markdown" } }, true);
    const contentType = (response.headers.get("content-type") || "text/plain").split(";")[0].trim().toLowerCase();
    if (!ACCEPTED_DOCUMENT_TYPES.includes(contentType)) throw new Error(`Unsupported external content type: ${contentType || "unknown"}`);
    const finalUrl = new URL(response.url || initialUrl.toString());
    const extracted = contentType === "text/html" ? extractHtml(text, finalUrl) : { title: finalUrl.pathname.split("/").filter(Boolean).at(-1) || finalUrl.hostname, content: text.trim(), links: [] };

    return {
      source: {
        kind,
        title: extracted.title,
        url: finalUrl.toString(),
        snippet: extracted.content.slice(0, 500),
        domain: finalUrl.hostname.toLowerCase().replace(/^www\./, ""),
        retrievedAt: new Date().toISOString(),
        trusted: false,
        trustReason: "untrusted"
      },
      content: extracted.content,
      contentType,
      links: extracted.links,
      truncated,
      untrustedContent: true,
      apiSchema: kind === "api_docs" ? inspectApiSchema(extracted.content, contentType) : undefined
    };
  }

  private async request(url: URL, init: RequestInit, validateUserUrl: boolean, redirects = 0, redirectPolicy: RedirectPolicy = {}): Promise<{ response: Response; text: string; truncated: boolean }> {
    if (redirectPolicy.requireHttps && url.protocol !== "https:") throw new Error("External request must use https");
    if (validateUserUrl) {
      if (this.options.validateUrl) await this.options.validateUrl(url);
      else await validateExternalUrl(url, { allowProxyMappedAddresses: this.options.allowProxyMappedAddresses });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

    try {
      const response = await (this.options.fetch || fetch)(url, { ...init, redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= MAX_REDIRECTS) throw new Error(`External request exceeded ${MAX_REDIRECTS} redirects`);
        const location = response.headers.get("location");
        if (!location) throw new Error("External redirect did not include a location");
        const redirectUrl = new URL(location, url);
        if (url.protocol === "https:" && redirectUrl.protocol !== "https:") throw new Error("External redirect cannot downgrade from https to http");
        if (redirectPolicy.sameOriginOnly && redirectUrl.origin !== url.origin) throw new Error("Search provider cannot redirect to another origin");
        return this.request(redirectUrl, init, validateUserUrl, redirects + 1, redirectPolicy);
      }
      if (!response.ok) throw new Error(`External request failed with HTTP ${response.status}`);
      const body = await readLimitedBody(response, this.options.maxResponseBytes);
      return { response, ...body };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`External request timed out after ${this.options.requestTimeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createExternalContextGateway() {
  return new ExternalContextGateway({
    searchApiKey: config.braveSearchApiKey,
    searchBaseUrl: config.braveSearchBaseUrl,
    requestTimeoutMs: config.externalContextTimeoutMs,
    maxResponseBytes: config.externalContextMaxResponseBytes,
    trustedDocumentationDomains: config.externalContextTrustedDocDomains,
    allowProxyMappedAddresses: config.externalContextAllowProxyMappedAddresses
  });
}
