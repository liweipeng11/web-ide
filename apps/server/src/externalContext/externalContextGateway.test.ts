import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExternalContextGateway } from "./externalContextGateway.js";
import { clearReasoningSequence, recordReasoningThought } from "./reasoningSequence.js";
import { isPrivateNetworkAddress, validateExternalUrl } from "./urlPolicy.js";
import { getAgentModeConfig } from "../agentModes.js";
import { evaluateAgentToolApproval } from "../agentPermissions.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { readReasoningAudit } from "./reasoningSequence.js";

function createGateway(fetchImplementation: typeof fetch, overrides: Partial<ConstructorParameters<typeof ExternalContextGateway>[0]> = {}) {
  return new ExternalContextGateway({
    searchApiKey: "test-key",
    searchBaseUrl: "https://api.search.brave.com/res/v1/web/search",
    requestTimeoutMs: 1_000,
    maxResponseBytes: 10_000,
    trustedDocumentationDomains: ["nodejs.org"],
    fetch: fetchImplementation,
    validateUrl: async () => undefined,
    ...overrides
  });
}

test("官方文档检索添加域名范围并丢弃非官方结果", async () => {
  let requestedUrl = "";
  const gateway = createGateway(async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        web: {
          results: [
            { title: "Node.js API", url: "https://nodejs.org/api/fs.html", description: "File system docs" },
            { title: "转载", url: "https://example.com/node", description: "Unofficial copy" }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  const result = await gateway.search({ query: "fs promises", domains: ["nodejs.org"], officialOnly: true });

  assert.match(new URL(requestedUrl).searchParams.get("q") || "", /site:nodejs\.org/);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].kind, "official_docs");
  assert.equal(result.sources[0].trusted, true);
  assert.equal(result.sources[0].trustReason, "configured_official");
});

test("官方文档检索先过滤域名再应用结果数量上限", async () => {
  const gateway = createGateway(async () =>
    new Response(JSON.stringify({ web: { results: [
      { title: "非官方", url: "https://example.com/copy", description: "copy" },
      { title: "官方", url: "https://nodejs.org/api/http.html", description: "official" }
    ] } }), { status: 200, headers: { "content-type": "application/json" } })
  );
  const result = await gateway.search({ query: "http", domains: ["nodejs.org"], officialOnly: true, count: 1 });
  assert.equal(result.sources[0]?.url, "https://nodejs.org/api/http.html");
});

test("搜索在缺少密钥或使用非 HTTPS 端点时返回明确错误", async () => {
  const fetchImplementation = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(createGateway(fetchImplementation, { searchApiKey: "" }).search({ query: "node" }), /BRAVE_SEARCH_API_KEY/);
  await assert.rejects(createGateway(fetchImplementation, { searchBaseUrl: "http://search.example.com/api" }).search({ query: "node" }), /must use https/);
});

test("网页导航提取可见正文与绝对链接，并标记为不可信内容", async () => {
  const gateway = createGateway(async () =>
    new Response('<html><head><title> API Guide </title><style>.x{}</style></head><body><h1>Quick start</h1><script>ignore()</script><a href="/reference">Reference</a></body></html>', {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    })
  );

  const result = await gateway.fetchDocument("https://docs.example.com/guide", "browser");

  assert.equal(result.source.title, "API Guide");
  assert.match(result.content, /Quick start/);
  assert.doesNotMatch(result.content, /ignore/);
  assert.deepEqual(result.links, [{ text: "Reference", url: "https://docs.example.com/reference" }]);
  assert.equal(result.untrustedContent, true);
});

test("每一次重定向都会重新执行外部 URL 安全校验", async () => {
  const validated: string[] = [];
  let calls = 0;
  const gateway = createGateway(
    async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.example.com/spec.json" } });
      return new Response('{"openapi":"3.1.0"}', { status: 200, headers: { "content-type": "application/json" } });
    },
    { validateUrl: async (url) => void validated.push(url.toString()) }
  );

  const result = await gateway.fetchDocument("https://api.example.com/openapi.json", "api_docs");

  assert.deepEqual(validated, ["https://api.example.com/openapi.json", "https://cdn.example.com/spec.json"]);
  assert.equal(result.contentType, "application/json");
});

test("搜索提供商拒绝跨域重定向，避免泄漏订阅密钥", async () => {
  const requests: Array<{ url: string; token: string | null }> = [];
  const gateway = createGateway(async (input, init) => {
    requests.push({ url: String(input), token: new Headers(init?.headers).get("X-Subscription-Token") });
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/search" } });
  });
  await assert.rejects(gateway.search({ query: "security" }), /cannot redirect to another origin/);
  assert.deepEqual(requests, [{ url: "https://api.search.brave.com/res/v1/web/search?q=security&count=5", token: "test-key" }]);
});

test("API 文档抓取识别 OpenAPI 元数据和操作数量", async () => {
  const gateway = createGateway(async () =>
    new Response(JSON.stringify({ openapi: "3.1.0", info: { title: "Orders", version: "2" }, paths: { "/orders": { get: {}, post: {} } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
  const result = await gateway.fetchDocument("https://api.example.com/openapi.json", "api_docs");
  assert.deepEqual(result.apiSchema, { format: "openapi_json", title: "Orders", version: "2", operationCount: 2, paths: ["/orders"] });
});

test("响应体超过预算时只返回受限内容并标记截断", async () => {
  const gateway = createGateway(async () => new Response("1234567890", { status: 200, headers: { "content-type": "text/plain" } }), { maxResponseBytes: 5 });
  const result = await gateway.fetchDocument("https://example.com/large.txt", "api_docs");

  assert.equal(result.content, "12345");
  assert.equal(result.truncated, true);
});

test("URL 策略拒绝环回、私网和云元数据地址", async () => {
  assert.equal(isPrivateNetworkAddress("127.0.0.1"), true);
  assert.equal(isPrivateNetworkAddress("10.0.0.8"), true);
  assert.equal(isPrivateNetworkAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
  assert.equal(isPrivateNetworkAddress("198.18.0.10"), true);
  assert.equal(isPrivateNetworkAddress("198.18.0.10", { allowProxyMappedAddresses: true }), false);
  await assert.rejects(validateExternalUrl(new URL("http://127.0.0.1/admin")), /private or reserved/);
  await assert.rejects(validateExternalUrl(new URL("http://[::1]/admin")), /private or reserved/);
  await assert.rejects(validateExternalUrl(new URL("http://198.18.0.10/admin"), { allowProxyMappedAddresses: true }), /private or reserved/);
  await assert.rejects(validateExternalUrl(new URL("http://metadata.google.internal/latest")), /not allowed/);
});

test("顺序推理按运行和分支持久化，并校验步骤连续性", async () => {
  const runId = "external-reasoning-test";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "external-reasoning-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  await clearReasoningSequence(runId);

  const first = await recordReasoningThought(runId, { thought: "确认约束", thoughtNumber: 1, totalThoughts: 2, nextThoughtNeeded: true });
  await assert.rejects(recordReasoningThought(runId, { thought: "跳步", thoughtNumber: 3, totalThoughts: 3, nextThoughtNeeded: false }), /Expected thoughtNumber 2/);
  const second = await recordReasoningThought(runId, { thought: "形成结论", thoughtNumber: 2, totalThoughts: 2, nextThoughtNeeded: false });
  const branch = await recordReasoningThought(runId, { thought: "检查替代方案", thoughtNumber: 2, totalThoughts: 3, nextThoughtNeeded: true, branchId: "alternative", branchFromThought: 1 });

  assert.equal(first.nextThoughtNumber, 2);
  assert.equal(second.complete, true);
  assert.equal(branch.branchId, "alternative");
  const audit = await readReasoningAudit(runId);
  assert.equal(audit?.branches.main.length, 2);
  assert.deepEqual(audit?.completedBranches, ["main"]);
  assert.match(first.auditPath, /external-context\/reasoning/);
  await clearReasoningSequence(runId);
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test("Plan 与 Act 模式注册外部只读工具，交互式浏览仅在 Act 模式提供", () => {
  const expectedTools = ["getExternalContextStatus", "searchOfficialDocs", "searchWeb", "browseWebPage", "fetchApiDocs", "sequenceReasoning"];
  for (const mode of ["plan", "act"] as const) {
    const names = getAgentModeConfig(mode).registry.definitions.map((definition) => definition.name);
    for (const toolName of expectedTools) assert.ok(names.includes(toolName), `${mode} should include ${toolName}`);
  }
  assert.equal(getAgentModeConfig("plan").registry.get("automateBrowser"), undefined);
  assert.ok(getAgentModeConfig("act").registry.get("automateBrowser"));

  const approval = evaluateAgentToolApproval(
    { id: "external-search", type: "function", function: { name: "searchOfficialDocs", arguments: JSON.stringify({ query: "Node.js fetch", domains: ["nodejs.org"] }) } },
    getAgentModeConfig("plan").registry.get("searchOfficialDocs")
  );
  assert.equal(approval.status, "auto_approved");

  const browserApproval = evaluateAgentToolApproval(
    { id: "browser-action", type: "function", function: { name: "automateBrowser", arguments: JSON.stringify({ url: "https://example.com", actions: [{ type: "click", selector: "#continue" }] }) } },
    getAgentModeConfig("act").registry.get("automateBrowser")
  );
  assert.equal(browserApproval.status, "requires_approval");
  const browserLoadApproval = evaluateAgentToolApproval(
    { id: "browser-load", type: "function", function: { name: "automateBrowser", arguments: JSON.stringify({ url: "https://example.com" }) } },
    getAgentModeConfig("act").registry.get("automateBrowser")
  );
  assert.equal(browserLoadApproval.status, "requires_approval");
});
