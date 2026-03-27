import * as dns from "dns";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { TidyURL } from "tidy-url";

// ---------------------------------------------------------------------------
// URL Sanitization
// ---------------------------------------------------------------------------

/** Strip tracking query parameters (utm_*, fbclid, gclid, etc.) using tidy-url. */
export function sanitizeUrl(url: string): string {
  const result = TidyURL.clean(url);
  return result.url;
}

/**
 * Check that the URL uses an allowed protocol.
 * HTTPS is always permitted; HTTP is opt-in via `allowHttp`.
 * All other protocols (ftp:, file:, data:, javascript:, …) are always rejected.
 */
export function checkProtocol(url: string, allowHttp: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err: any) {
    throw new Error(`Invalid URL: ${url} (${err?.message ?? String(err)})`);
  }
  const proto = parsed.protocol;
  if (proto === "https:") return;
  if (proto === "http:" && allowHttp) return;
  if (proto === "http:") {
    throw new Error(`Protocol http: is not allowed. Set WEB_ALLOW_HTTP=true to enable.`);
  }
  throw new Error(`Protocol ${proto} is not allowed. Only https: (and optionally http:) are permitted.`);
}

/** Built-in blocklist — always enforced, cannot be overridden by config. */
const BUILTIN_BLOCKLIST = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "metadata.google.internal",
  "169.254.169.254",
];

/**
 * Returns true when `hostname` matches the given blocklist entry.
 * Supports exact matches and suffix matches (e.g. "evil.com" blocks "www.evil.com").
 */
function hostnameMatches(hostname: string, entry: string): boolean {
  const h = hostname.toLowerCase();
  const e = entry.toLowerCase();
  return h === e || h.endsWith(`.${e}`);
}

/**
 * Check that the hostname is not on the combined blocklist.
 * The built-in blocklist is always merged with the user-supplied list.
 */
export function checkBlocklist(hostname: string, userBlocklist: string[]): void {
  const combined = [...BUILTIN_BLOCKLIST, ...userBlocklist];
  for (const entry of combined) {
    if (hostnameMatches(hostname, entry)) {
      throw new Error(`Domain "${hostname}" is blocked.`);
    }
  }
}

/**
 * When the allowlist is non-empty, reject any hostname not on it.
 * Supports suffix matching (same as blocklist).
 * No-op when the allowlist is empty (all hostnames are permitted).
 */
export function checkAllowlist(hostname: string, allowlist: string[]): void {
  if (allowlist.length === 0) return;
  const allowed = allowlist.some((entry) => hostnameMatches(hostname, entry));
  if (!allowed) {
    throw new Error(`Domain "${hostname}" is not in the domain allowlist.`);
  }
}

// ---------------------------------------------------------------------------
// SSRF Protection
// ---------------------------------------------------------------------------

/** Returns true if the IPv4 address (dotted-decimal) falls within a private/reserved range. */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — RFC 1918
  if (a === 10) return true;
  // 172.16.0.0/12 — RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC 1918
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local / AWS metadata
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — "This" network
  if (a === 0) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Returns true if the IPv6 address falls within a private/reserved range. */
function isPrivateIpv6(ip: string): boolean {
  // Normalize: remove brackets if present (e.g. [::1])
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
  // ::1/128 — loopback
  if (addr === "::1") return true;
  // fc00::/7 — unique local (fc00:: to fdff::)
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;
  return false;
}

/**
 * Resolve the hostname via DNS and reject if any returned IP is private/reserved.
 * Also rejects when the hostname itself is a private IP literal.
 */
export async function checkSsrf(hostname: string): Promise<void> {
  // Reject private IPv4/IPv6 literals directly (no DNS lookup needed)
  if (isPrivateIpv4(hostname)) {
    throw new Error(`Direct IP access to private address "${hostname}" is not allowed (SSRF protection).`);
  }
  if (isPrivateIpv6(hostname)) {
    throw new Error(`Direct IP access to private address "${hostname}" is not allowed (SSRF protection).`);
  }

  // Resolve A (IPv4) and AAAA (IPv6) records
  const ipv4s = await dns.promises.resolve4(hostname).catch(() => [] as string[]);
  const ipv6s = await dns.promises.resolve6(hostname).catch(() => [] as string[]);

  for (const ip of ipv4s) {
    if (isPrivateIpv4(ip)) {
      throw new Error(`Hostname "${hostname}" resolves to private IP "${ip}" (SSRF protection).`);
    }
  }
  for (const ip of ipv6s) {
    if (isPrivateIpv6(ip)) {
      throw new Error(`Hostname "${hostname}" resolves to private IPv6 "${ip}" (SSRF protection).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch Helper
// ---------------------------------------------------------------------------

export interface FetchConfig {
  timeoutMs: number;
  userAgent: string;
  maxBytes: number;
}

/**
 * Fetch a URL with timeout, User-Agent, and response-size limits.
 * Returns the response body as a UTF-8 string.
 * Throws on HTTP errors, non-HTML content types, size limit exceeded, or timeout.
 */
export async function fetchWithLimits(url: string, config: FetchConfig): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": config.userAgent },
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${config.timeoutMs}ms`);
    }
    throw new Error(`Network error: ${err?.message ?? String(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // Validate content type before reading body
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new Error(
      `Unsupported content type "${contentType}". Only HTML pages (text/html, application/xhtml+xml) are supported.`
    );
  }

  // Reject early if content-length exceeds the limit
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (!isNaN(len) && len > config.maxBytes) {
      throw new Error(
        `Response size ${len} bytes exceeds the limit of ${config.maxBytes} bytes.`
      );
    }
  }

  // Read body incrementally and abort if size exceeds limit
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > config.maxBytes) {
        reader.cancel();
        throw new Error(`Response size exceeded the limit of ${config.maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(combined);
}

// ---------------------------------------------------------------------------
// Content Extraction
// ---------------------------------------------------------------------------

export interface ReadabilityResult {
  title: string;
  content: string;
  byline?: string;
  excerpt?: string;
}

/**
 * Extract main article content from HTML using Mozilla Readability.
 * Returns null if Readability cannot extract the content.
 */
export function extractReadable(html: string, url: string): ReadabilityResult | null {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article) return null;
  return {
    title: article.title ?? "",
    content: article.content ?? "",
    byline: article.byline ?? undefined,
    excerpt: article.excerpt ?? undefined,
  };
}

/** Fallback: return the full <body> innerHTML. */
export function extractBodyHtml(html: string): string {
  const dom = new JSDOM(html);
  return dom.window.document.body?.innerHTML ?? html;
}

/** Extract the page <title> from HTML. Returns null if not found. */
export function extractTitle(html: string): string | null {
  const dom = new JSDOM(html);
  const title = dom.window.document.title;
  return title || null;
}

// Elements to strip before Markdown conversion (noise, not content)
const STRIP_SELECTORS = ["script", "style", "nav", "footer", "iframe", "noscript"];

/**
 * Convert HTML to Markdown using Turndown.
 * Strips noise elements (scripts, nav, footer, etc.) before conversion.
 * Preserves code blocks, headings, links, lists, and tables.
 */
export function htmlToMarkdown(html: string): string {
  // Strip noise elements from HTML before conversion
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  for (const sel of STRIP_SELECTORS) {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  }
  const cleanedHtml = doc.body?.innerHTML ?? html;

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  return td.turndown(cleanedHtml);
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * Truncate Markdown at a word boundary.
 * If the text is within maxChars, returns it unchanged (truncated: false).
 * Otherwise finds the last space before maxChars and truncates there.
 */
export function truncateAtWordBoundary(text: string, maxChars: number): TruncateResult {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  // Find the last space at or before maxChars
  let cutIndex = maxChars;
  while (cutIndex > 0 && text[cutIndex] !== " " && text[cutIndex] !== "\n") {
    cutIndex--;
  }
  // Fallback: if no space found, hard-cut at maxChars
  if (cutIndex === 0) cutIndex = maxChars;
  const truncated = text.slice(0, cutIndex);
  return {
    text: `${truncated}\n\n[Content truncated at ${maxChars} characters]`,
    truncated: true,
  };
}
