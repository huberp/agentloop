/**
 * Integration tests for src/tools/web-fetch.ts
 * Network layer (fetch) and DNS are mocked; no real HTTP requests are made.
 */

import * as dns from "dns";

// ---------------------------------------------------------------------------
// Mock dns.promises before any imports that use it
// ---------------------------------------------------------------------------
jest.mock("dns", () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

const mockResolve4 = dns.promises.resolve4 as jest.Mock;
const mockResolve6 = dns.promises.resolve6 as jest.Mock;

// Set up DNS mocks to return public IPs by default (safe host)
function allowAllDns() {
  mockResolve4.mockResolvedValue(["93.184.216.34"]);
  mockResolve6.mockRejectedValue(new Error("ENODATA"));
}

// Make DNS resolve to a private IP (triggers SSRF block)
function blockDns() {
  mockResolve4.mockResolvedValue(["127.0.0.1"]);
  mockResolve6.mockRejectedValue(new Error("ENODATA"));
}

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article>
    <h1>Hello World</h1>
    <p>This is a test article with enough content to be interesting.</p>
    <p>It has multiple paragraphs to exercise the extraction pipeline.</p>
  </article>
  <footer>Footer text</footer>
  <script>console.log("tracking")</script>
</body>
</html>`;

function mockFetchSuccess(html = SAMPLE_HTML) {
  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(html);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
}

function mockFetchError(message = "connection refused") {
  global.fetch = jest.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Import the tool after mocks are set up
// ---------------------------------------------------------------------------
import { toolDefinition } from "../tools/web-fetch";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseResult(raw: string): Record<string, unknown> {
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("web_fetch tool — metadata", () => {
  it("has the correct name", () => {
    expect(toolDefinition.name).toBe("web_fetch");
  });

  it("has permissions 'cautious'", () => {
    expect(toolDefinition.permissions).toBe("cautious");
  });

  it("schema accepts a valid URL", () => {
    const parsed = toolDefinition.schema.parse({ url: "https://example.com" });
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.extractMode).toBe("readability");
  });

  it("schema rejects an invalid URL", () => {
    expect(() => toolDefinition.schema.parse({ url: "not-a-url" })).toThrow();
  });

  it("schema accepts extractMode: raw", () => {
    const parsed = toolDefinition.schema.parse({ url: "https://example.com", extractMode: "raw" });
    expect(parsed.extractMode).toBe("raw");
  });
});

describe("web_fetch tool — full pipeline (mocked fetch)", () => {
  beforeEach(() => {
    allowAllDns();
    mockFetchSuccess();
    // Reset config overrides
    (appConfig as Record<string, unknown>).webAllowHttp = false;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    (appConfig as Record<string, unknown>).webMaxContentChars = 20000;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("strips tracking params and returns clean JSON result", async () => {
    const raw = await toolDefinition.execute({
      url: "https://example.com/article?utm_source=twitter&fbclid=abc",
    });
    const result = parseResult(raw);
    expect(result.url).toBe("https://example.com/article");
    expect(result.title).toBeDefined();
    expect(typeof result.markdown).toBe("string");
    expect(result.truncated).toBe(false);
    expect(result.originalLength).toBeGreaterThan(0);
  });

  it("returns markdown content (no raw HTML in output)", async () => {
    const raw = await toolDefinition.execute({ url: "https://example.com" });
    const result = parseResult(raw);
    const markdown = result.markdown as string;
    // Should not contain raw HTML tags
    expect(markdown).not.toMatch(/<html|<head|<body|<nav|<footer/i);
    // Should contain the article text
    expect(markdown).toContain("Hello World");
  });

  it("falls back to raw body when Readability returns null", async () => {
    // Minimal HTML with no article structure — Readability may return null
    const minimalHtml = `<html><head><title>Min</title></head><body><p>Hi</p></body></html>`;
    mockFetchSuccess(minimalHtml);
    const raw = await toolDefinition.execute({ url: "https://example.com" });
    const result = parseResult(raw);
    expect(result.markdown).toBeDefined();
    // Should contain the body content
    expect((result.markdown as string).length).toBeGreaterThan(0);
  });

  it("extractMode: raw skips Readability and converts full body", async () => {
    const raw = await toolDefinition.execute({
      url: "https://example.com",
      extractMode: "raw",
    });
    const result = parseResult(raw);
    expect(result.markdown).toBeDefined();
    // Raw mode should still contain the article text
    expect(result.markdown as string).toContain("Hello World");
  });

  it("truncates content exceeding WEB_MAX_CONTENT_CHARS", async () => {
    // Generate long HTML content
    const longParagraph = "<p>" + "a ".repeat(5000) + "</p>";
    const longHtml = `<html><head><title>Long</title></head><body><article>${longParagraph}</article></body></html>`;
    mockFetchSuccess(longHtml);
    (appConfig as Record<string, unknown>).webMaxContentChars = 100;

    const raw = await toolDefinition.execute({ url: "https://example.com" });
    const result = parseResult(raw);
    expect(result.truncated).toBe(true);
    expect((result.markdown as string).length).toBeLessThan(200); // truncated + notice
    expect(result.markdown as string).toContain("[Content truncated at 100 characters]");
  });
});

describe("web_fetch tool — security blocks (return error JSON, never throw)", () => {
  beforeEach(() => {
    (appConfig as Record<string, unknown>).webAllowHttp = false;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    // Reset the fetch mock so call counts start at 0 for each test
    global.fetch = jest.fn();
  });

  it("blocks http:// URL when WEB_ALLOW_HTTP is false", async () => {
    const raw = await toolDefinition.execute({ url: "http://example.com" });
    const result = parseResult(raw);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(result.url).toBeDefined();
    // Must not have made a network call
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks a URL pointing to localhost (built-in blocklist)", async () => {
    const raw = await toolDefinition.execute({ url: "https://localhost/admin" });
    const result = parseResult(raw);
    expect(result.error).toBeDefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks a URL pointing to the AWS metadata endpoint (169.254.169.254)", async () => {
    const raw = await toolDefinition.execute({ url: "https://169.254.169.254/latest/meta-data" });
    const result = parseResult(raw);
    expect(result.error).toBeDefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks a domain resolving to a private IP (SSRF protection)", async () => {
    blockDns();
    const raw = await toolDefinition.execute({ url: "https://internal.example.com" });
    const result = parseResult(raw);
    expect(result.error).toBeDefined();
    // cleanUrl from sanitizeUrl — tidy-url preserves the URL without adding a trailing slash
    expect(result.url).toBe("https://internal.example.com");
  });

  it("blocks a user-configured blocklisted domain", async () => {
    (appConfig as Record<string, unknown>).webDomainBlocklist = ["blocked-site.com"];
    allowAllDns();
    const raw = await toolDefinition.execute({ url: "https://blocked-site.com/page" });
    const result = parseResult(raw);
    expect(result.error).toBeDefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks a domain not in the allowlist when allowlist is set", async () => {
    (appConfig as Record<string, unknown>).webDomainAllowlist = ["allowed.com"];
    allowAllDns();
    const raw = await toolDefinition.execute({ url: "https://notallowed.com/page" });
    const result = parseResult(raw);
    expect(result.error).toBeDefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("web_fetch tool — fetch errors (return error JSON, never throw)", () => {
  beforeEach(() => {
    allowAllDns();
    (appConfig as Record<string, unknown>).webAllowHttp = false;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
  });

  it("returns error JSON on network failure (never throws)", async () => {
    mockFetchError("connection refused");
    const raw = await toolDefinition.execute({ url: "https://example.com" });
    const result = parseResult(raw);
    expect(result.error).toBeDefined();
    expect((result.error as string).toLowerCase()).toContain("fetch failed");
  });
});
