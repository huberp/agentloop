import * as dns from "dns/promises";
import { TidyURL } from "tidy-url";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Built-in domain blocklist — common localhost aliases plus a small set of
// known-bad patterns.  Users can extend this via WEB_DOMAIN_BLOCKLIST.
// ---------------------------------------------------------------------------
const BUILTIN_DOMAIN_BLOCKLIST = [
  "localhost",
  "metadata.google.internal",
];

// Private / loopback / link-local CIDR ranges used for SSRF protection.
// All comparisons are done on the raw numeric representation of each IPv4/v6
// address, so this is resilient to notation variations.
const PRIVATE_IPV4_RANGES: [number, number, number][] = [
  // [network, mask, bits] encoded as 32-bit unsigned integers
  [0x7f000000, 0xff000000, 8],    // 127.0.0.0/8  — loopback
  [0x0a000000, 0xff000000, 8],    // 10.0.0.0/8   — private
  [0xac100000, 0xfff00000, 12],   // 172.16.0.0/12 — private
  [0xc0a80000, 0xffff0000, 16],   // 192.168.0.0/16 — private
  [0xa9fe0000, 0xffff0000, 16],   // 169.254.0.0/16 — link-local
  [0x00000000, 0xff000000, 8],    // 0.0.0.0/8    — "this" network
  [0xe0000000, 0xf0000000, 4],    // 224.0.0.0/4  — multicast
  [0xf0000000, 0xf0000000, 4],    // 240.0.0.0/4  — reserved
  [0xffffffff, 0xffffffff, 32],   // 255.255.255.255 — broadcast
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 string into a 32-bit unsigned integer. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const byte = parseInt(part, 10);
    if (isNaN(byte) || byte < 0 || byte > 255) return null;
    n = (n << 8) | byte;
  }
  // Shift to unsigned 32-bit
  return n >>> 0;
}

/** Return true when the IPv4 address falls inside any private/loopback range. */
function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return PRIVATE_IPV4_RANGES.some(([net, mask]) => (n & mask) === (net & mask));
}

/** Return true when the IPv6 address is loopback (::1) or link-local (fe80::/10). */
function isPrivateIPv6(addr: string): boolean {
  const normalized = addr.toLowerCase().replace(/\[|\]/g, "");
  if (normalized === "::1") return true;
  // fe80::/10
  if (normalized.startsWith("fe80:")) return true;
  // fc00::/7 — unique-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Remove tracking parameters from a URL using tidy-url. */
export function sanitizeUrl(raw: string): string {
  try {
    const result = TidyURL.clean(raw);
    return result.url;
  } catch {
    return raw;
  }
}

/**
 * Validate a URL against the configured security policy.
 *
 * Checks (in order):
 *  1. Protocol enforcement (https only, unless WEB_ALLOW_HTTP=true)
 *  2. Domain blocklist (built-in + user-configured)
 *  3. Domain allowlist (if configured, only listed domains are permitted)
 *
 * Returns `null` on success or an error string on failure.
 * Does NOT perform async DNS resolution — call `checkSsrf()` separately for that.
 */
export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: "${url}"`;
  }

  const proto = parsed.protocol;
  if (proto !== "https:" && proto !== "http:") {
    return `Unsupported protocol "${proto}": only https (and optionally http) are allowed.`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Domain blocklist checked before protocol to give the most specific error message
  // Merge built-in + user-configured blocklist
  const blocklist = [...BUILTIN_DOMAIN_BLOCKLIST, ...appConfig.webDomainBlocklist.map((d) => d.toLowerCase())];
  if (blocklist.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))) {
    return `Domain "${hostname}" is on the blocklist.`;
  }

  if (proto === "http:" && !appConfig.webAllowHttp) {
    return `http:// URLs are not permitted. Set WEB_ALLOW_HTTP=true to enable insecure HTTP.`;
  }

  // Allowlist check (only when a non-empty allowlist is configured)
  const allowlist = appConfig.webDomainAllowlist.map((d) => d.toLowerCase());
  if (allowlist.length > 0) {
    const permitted = allowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
    if (!permitted) {
      return `Domain "${hostname}" is not on the allowlist. Permitted domains: ${allowlist.join(", ")}.`;
    }
  }

  return null; // OK
}

/**
 * Async SSRF check: resolve the hostname via DNS and reject any address that
 * falls inside a private/loopback/link-local range.
 *
 * Returns `null` on success or an error string if the address is private.
 */
export async function checkSsrf(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: "${url}"`;
  }

  const hostname = parsed.hostname;

  // If the hostname is already a bare IPv4 address, check it directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return `URL "${url}" resolves to a private IP address (${hostname}) — request blocked (SSRF protection).`;
    }
    return null;
  }

  // Bare IPv6 literal (may be wrapped in [ ])
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const addr = hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIPv6(addr)) {
      return `URL "${url}" targets a private IPv6 address (${addr}) — request blocked (SSRF protection).`;
    }
    return null;
  }

  // Perform DNS lookup and check every returned address.
  try {
    const addresses = await dns.resolve(hostname);
    for (const addr of addresses) {
      if (isPrivateIPv4(addr)) {
        return `URL "${url}" resolves to a private IP address (${addr}) — request blocked (SSRF protection).`;
      }
      if (isPrivateIPv6(addr)) {
        return `URL "${url}" resolves to a private IPv6 address (${addr}) — request blocked (SSRF protection).`;
      }
    }
  } catch {
    // DNS resolution failure — treat as a non-routable / unknown host and block.
    return `URL "${url}" could not be resolved — request blocked.`;
  }

  return null; // OK
}

/**
 * Run the full URL security pipeline synchronously:
 * sanitize → validate.
 *
 * Returns `{ cleanUrl, error }` where `error` is null on success.
 */
export function processUrl(raw: string): { cleanUrl: string; error: string | null } {
  const cleanUrl = sanitizeUrl(raw);
  const error = validateUrl(cleanUrl);
  return { cleanUrl, error };
}
