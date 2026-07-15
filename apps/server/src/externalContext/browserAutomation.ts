import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright-core";
import { config } from "../config.js";
import { projectRuntimeDirectory } from "../statePaths.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import type { BrowserAction, BrowserAutomationInput, BrowserAutomationResult, ExternalContextSource } from "./types.js";
import { validateExternalUrl } from "./urlPolicy.js";

const MAX_BROWSER_ACTIONS = 10;
const MAX_ACTION_TIMEOUT_MS = 10_000;
const MAX_RENDERED_CONTENT_CHARS = 100_000;

function browserCandidates() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  return [
    config.externalBrowserExecutablePath,
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
    localAppData ? path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") : "",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].filter(Boolean);
}

export async function findBrowserExecutable() {
  for (const candidate of browserCandidates()) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 继续尝试下一个系统浏览器路径。
    }
  }
  return null;
}

export async function getBrowserAutomationCapability() {
  const executablePath = await findBrowserExecutable();
  return {
    available: Boolean(executablePath || config.externalBrowserChannel),
    executablePath: executablePath || undefined,
    channel: config.externalBrowserChannel || undefined,
    proxyConfigured: Boolean(config.externalBrowserProxyUrl)
  };
}

function validateAction(action: BrowserAction) {
  if (action.type === "waitForTimeout") {
    if (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 0 || action.timeoutMs > MAX_ACTION_TIMEOUT_MS) throw new Error(`waitForTimeout must be between 0 and ${MAX_ACTION_TIMEOUT_MS}ms`);
    return;
  }
  if (!("selector" in action) || !action.selector.trim() || action.selector.length > 500) throw new Error("Browser action selector must be between 1 and 500 characters");
  if (action.type === "fill" && action.value.length > 4_000) throw new Error("Browser fill value is too long");
  if (action.type === "waitForSelector" && action.timeoutMs !== undefined && (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 1 || action.timeoutMs > MAX_ACTION_TIMEOUT_MS)) {
    throw new Error(`waitForSelector timeout must be between 1 and ${MAX_ACTION_TIMEOUT_MS}ms`);
  }
}

async function executeAction(page: Page, action: BrowserAction) {
  validateAction(action);
  if (action.type === "click") await page.locator(action.selector).click({ timeout: MAX_ACTION_TIMEOUT_MS });
  else if (action.type === "fill") await page.locator(action.selector).fill(action.value, { timeout: MAX_ACTION_TIMEOUT_MS });
  else if (action.type === "press") await page.locator(action.selector).press(action.key, { timeout: MAX_ACTION_TIMEOUT_MS });
  else if (action.type === "select") await page.locator(action.selector).selectOption(action.value, { timeout: MAX_ACTION_TIMEOUT_MS });
  else if (action.type === "waitForSelector") await page.locator(action.selector).waitFor({ timeout: action.timeoutMs || MAX_ACTION_TIMEOUT_MS });
  else await page.waitForTimeout(action.timeoutMs);
}

type BrowserAutomationOverrides = {
  executablePath?: string;
  validateUrl?: (url: URL) => Promise<void>;
};

async function installNetworkPolicy(page: Page, validateUrl: (url: URL) => Promise<void>) {
  const checkedOrigins = new Map<string, Promise<void>>();
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      await route.abort("blockedbyclient");
      return;
    }

    if (url.protocol === "data:" || url.protocol === "blob:") {
      await route.continue();
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.abort("blockedbyclient");
      return;
    }

    try {
      const key = `${url.protocol}//${url.host}`;
      const validation = checkedOrigins.get(key) || validateUrl(url);
      checkedOrigins.set(key, validation);
      await validation;
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

async function saveScreenshot(page: Page, url: string) {
  const directory = path.join(projectRuntimeDirectory("external-context"), "screenshots");
  await fs.mkdir(directory, { recursive: true });
  const name = `${Date.now()}-${createHash("sha256").update(url).digest("hex").slice(0, 12)}.png`;
  const absolutePath = path.join(directory, name);
  // 只截取当前视口，避免恶意超长页面制造巨型图片占用内存和磁盘。
  await page.screenshot({ path: absolutePath, fullPage: false });
  const workspaceRoot = getWorkspaceRoot();
  return workspaceRoot ? path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/") : absolutePath;
}

/**
 * 使用本机 Chrome/Edge 执行受限浏览器动作。每个网络请求仍经过外部 URL 策略，防止页面脚本绕过 SSRF 防护。
 */
export async function automateBrowser(input: BrowserAutomationInput, overrides: BrowserAutomationOverrides = {}): Promise<BrowserAutomationResult> {
  const actions = input.actions || [];
  if (actions.length > MAX_BROWSER_ACTIONS) throw new Error(`Browser automation accepts at most ${MAX_BROWSER_ACTIONS} actions`);
  const initialUrl = new URL(input.url);
  const urlValidator = overrides.validateUrl || ((url: URL) => validateExternalUrl(url, { allowProxyMappedAddresses: config.externalContextAllowProxyMappedAddresses }));
  await urlValidator(initialUrl);

  const useConfiguredChannel = !overrides.executablePath && !config.externalBrowserExecutablePath && Boolean(config.externalBrowserChannel);
  const executablePath = useConfiguredChannel ? null : overrides.executablePath || (await findBrowserExecutable());
  if (!executablePath && !config.externalBrowserChannel) throw new Error("No Chrome or Edge executable was found for browser automation");

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: executablePath || undefined,
      channel: useConfiguredChannel ? config.externalBrowserChannel : undefined,
      proxy: config.externalBrowserProxyUrl ? { server: config.externalBrowserProxyUrl } : undefined
    });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(MAX_ACTION_TIMEOUT_MS);
    await installNetworkPolicy(page, urlValidator);
    const response = await page.goto(initialUrl.toString(), { waitUntil: "domcontentloaded", timeout: config.externalContextTimeoutMs });
    if (!response) throw new Error("Browser navigation did not return a response");
    if (!response.ok()) throw new Error(`Browser navigation failed with HTTP ${response.status()}`);

    for (const action of actions) await executeAction(page, action);
    const finalUrl = new URL(page.url());
    await urlValidator(finalUrl);
    const title = (await page.title()).trim() || finalUrl.hostname;
    const renderedContent = (await page.locator("body").innerText({ timeout: MAX_ACTION_TIMEOUT_MS })).replace(/\s+/g, " ").trim();
    const content = renderedContent.slice(0, MAX_RENDERED_CONTENT_CHARS);
    const links = await page.locator("a[href]").evaluateAll((elements) =>
      elements.slice(0, 50).flatMap((element) => {
        const anchor = element as HTMLAnchorElement;
        return anchor.href.startsWith("http://") || anchor.href.startsWith("https://") ? [{ text: (anchor.innerText || anchor.textContent || "").trim().slice(0, 200), url: anchor.href }] : [];
      })
    );
    const screenshotPath = input.screenshot ? await saveScreenshot(page, finalUrl.toString()) : undefined;
    const source: ExternalContextSource = {
      kind: "browser",
      title,
      url: finalUrl.toString(),
      snippet: content.slice(0, 500),
      domain: finalUrl.hostname.toLowerCase().replace(/^www\./, ""),
      retrievedAt: new Date().toISOString(),
      trusted: false,
      trustReason: "untrusted"
    };

    return {
      source,
      content,
      contentType: await page.evaluate(() => document.contentType || "text/html"),
      links,
      truncated: renderedContent.length > MAX_RENDERED_CONTENT_CHARS,
      untrustedContent: true,
      executedActions: actions.length,
      screenshotPath,
      renderedWith: "playwright"
    };
  } finally {
    await browser?.close();
  }
}
