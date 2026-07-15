export type ExternalContextSourceKind = "official_docs" | "web_search" | "browser" | "api_docs";

export type ExternalContextSource = {
  kind: ExternalContextSourceKind;
  title: string;
  url: string;
  snippet: string;
  domain: string;
  retrievedAt: string;
  trusted: boolean;
  trustReason: "configured_official" | "domain_matched" | "untrusted";
};

export type ExternalSearchInput = {
  query: string;
  count?: number;
  domains?: string[];
  officialOnly?: boolean;
};

export type ExternalSearchResult = {
  query: string;
  provider: "brave";
  sources: ExternalContextSource[];
};

export type ExternalDocumentResult = {
  source: ExternalContextSource;
  content: string;
  contentType: string;
  links: Array<{ text: string; url: string }>;
  truncated: boolean;
  untrustedContent: true;
  apiSchema?: {
    format: "openapi_json" | "openapi_yaml" | "json" | "yaml";
    title?: string;
    version?: string;
    operationCount?: number;
    paths?: string[];
  };
};

export type BrowserAction =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "press"; selector: string; key: string }
  | { type: "select"; selector: string; value: string }
  | { type: "waitForSelector"; selector: string; timeoutMs?: number }
  | { type: "waitForTimeout"; timeoutMs: number };

export type BrowserAutomationInput = {
  url: string;
  actions?: BrowserAction[];
  screenshot?: boolean;
};

export type BrowserAutomationResult = ExternalDocumentResult & {
  executedActions: number;
  screenshotPath?: string;
  renderedWith: "playwright";
};

export type ExternalContextGatewayOptions = {
  searchApiKey: string;
  searchBaseUrl: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  trustedDocumentationDomains?: string[];
  allowProxyMappedAddresses?: boolean;
  fetch?: typeof fetch;
  validateUrl?: (url: URL) => Promise<void>;
};

export type ReasoningSequenceInput = {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  isRevision?: boolean;
  revisesThought?: number;
  branchId?: string;
  branchFromThought?: number;
};

export type ReasoningSequenceResult = {
  accepted: true;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNumber: number | null;
  complete: boolean;
  branchId: string;
  recordedThoughtCount: number;
  auditPath: string;
};

export type ReasoningAuditRecord = ReasoningSequenceInput & {
  branchId: string;
  recordedAt: string;
};

export type ReasoningAudit = {
  schemaVersion: 1;
  runId: string;
  branches: Record<string, ReasoningAuditRecord[]>;
  completedBranches: string[];
  createdAt: string;
  updatedAt: string;
};
