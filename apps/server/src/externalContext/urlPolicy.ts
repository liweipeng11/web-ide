import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

export type ExternalUrlPolicyOptions = {
  allowProxyMappedAddresses?: boolean;
};

function isProxyMappedIpv4(first: number, second: number) {
  return first === 198 && (second === 18 || second === 19);
}

function isPrivateIpv4(address: string, options: ExternalUrlPolicyOptions = {}) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;

  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (isProxyMappedIpv4(first, second) && !options.allowProxyMappedAddresses) ||
    (first === 198 && second === 51) ||
    (first === 203 && second === 0) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string, options: ExternalUrlPolicyOptions = {}) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped, options);
    const groups = mapped.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const value = Number.parseInt(groups[0], 16) * 65_536 + Number.parseInt(groups[1], 16);
      return isPrivateIpv4([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."), options);
    }
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

export function isPrivateNetworkAddress(address: string, options: ExternalUrlPolicyOptions = {}) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address, options);
  if (family === 6) return isPrivateIpv6(address, options);
  return true;
}

/**
 * 校验 Agent 提供的外部地址及其所有 DNS 结果，避免通过私网、环回或云元数据地址实施 SSRF。
 */
export async function validateExternalUrl(url: URL, options: ExternalUrlPolicyOptions = {}) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("External URL must use http or https");
  if (url.username || url.password) throw new Error("External URL must not contain credentials");

  const rawHostname = url.hostname.toLowerCase().replace(/\.$/, "");
  // WHATWG URL 会保留 IPv6 字面量两侧的方括号，net.isIP 需要无括号形式。
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]") ? rawHostname.slice(1, -1) : rawHostname;
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("External URL host is not allowed");
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    // 代理映射只适用于域名解析结果，绝不允许用户直接访问保留地址字面量。
    if (isPrivateNetworkAddress(hostname)) throw new Error("External URL resolves to a private or reserved address");
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`External URL DNS lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkAddress(address, options))) {
    throw new Error("External URL resolves to a private or reserved address");
  }
}
