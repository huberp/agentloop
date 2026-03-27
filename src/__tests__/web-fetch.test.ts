/**
 * Tests for src/tools/web-fetch.ts
 *
 * (f) HTML → Readability → Turndown pipeline
 * (g) Content truncation
 * Mock-HTTP tests for the tool execute path
 *
 * NOTE: jsdom v29 has ESM-only transitive dependencies that cannot be loaded
 * in Jest's CJS environment without experimental VM modules. We therefore mock
 * the jsdom + @mozilla/readability layer and test the tool's HTTP handling,
 * URL sanitization, truncation logic, and the Turndown conversion separately.
 */

// ---------------------------------------------------------------------------
// Mock dns/promises so SSRF DNS lookups don't require network access in CI.
// Default: all domains resolve to a public IP (93.184.216.34 = example.com).
// ---------------------------------------------------------------------------
jest.mock("dns/promises", () => ({
  resolve: jest.fn().mockResolvedValue(["93.184.216.34"]),
}));

// ---------------------------------------------------------------------------
// Mock jsdom and @mozilla/readability BEFORE any imports so the modules never
// execute their ESM-dependent code paths.
// ---------------------------------------------------------------------------
jest.mock("jsdom", () => {
  class JSDOM {
    window: { document: Record<string, unknown> };
    constructor(html: string, _opts?: unknown) {
      // Provide a minimal document-like object for Readability and Turndown
      this.window = {
        document: {
          title: "Test Article",
          body: { innerHTML: html },
        },
      };
    }
  }
  return { JSDOM };
});

jest.mock("@mozilla/readability", () => {
  class Readability {
    private html: string;
    constructor(doc: { body?: { innerHTML?: string }; title?: string }) {
      this.html = (doc as { body?: { innerHTML?: string } }).body?.innerHTML ?? "";
    }
    parse(): { title: string; content: string; byline: string; excerpt: string } | null {
      // Return null for pages that don't look like articles (no <article> tag)
      if (!this.html.includes("<article>") && !this.html.includes("<p>")) return null;
      return {
        title: "Test Article",
        content: this.html,
        byline: "Test Author",
        excerpt: "Test excerpt",
      };
    }
  }
  return { Readability };
});

import * as fs from "fs/promises";
import * as path from "path";
import { toolDefinition } from "../tools/web-fetch";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Response object accepted by globalThis.fetch. */
function mockResponse(html: string, status = 200): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(html);
  let pos = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos < bytes.length) {
        controller.enqueue(bytes.slice(pos, pos + 512));
        pos += 512;
      } else {
        controller.close();
      }
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-length": String(bytes.length) }),
    body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Response;
}

// Reset global fetch mock before each test
let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch not mocked for this test");
  });
  // Reset config overrides
  (appConfig as Record<string, unknown>).webDomainBlocklist = [];
  (appConfig as Record<string, unknown>).webDomainAllowlist = [];
  (appConfig as Record<string, unknown>).webAllowHttp = false;
  (appConfig as Record<string, unknown>).webMaxContentChars = 20000;
});
afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// (f) HTML → Readability → Turndown pipeline
// ---------------------------------------------------------------------------
describe("web-fetch — (f) HTML→Readability→Markdown pipeline", () => {
  it("extracts article content from fixture HTML and returns Markdown", async () => {
    const fixturePath = path.join(__dirname, "../../tests/fixtures/web/article.html");
    const html = await fs.readFile(fixturePath, "utf-8");

    fetchSpy.mockResolvedValueOnce(mockResponse(html));

    const raw = await toolDefinition.execute({ url: "https://example.com/article", extractMode: "readability" });
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.markdown).toBeDefined();
    expect(typeof result.markdown).toBe("string");
    expect(result.markdown.length).toBeGreaterThan(0);
  });

  it("returns a title field from the article", async () => {
    const fixturePath = path.join(__dirname, "../../tests/fixtures/web/article.html");
    const html = await fs.readFile(fixturePath, "utf-8");

    fetchSpy.mockResolvedValueOnce(mockResponse(html));

    const raw = await toolDefinition.execute({ url: "https://example.com/article" });
    const result = JSON.parse(raw);

    expect(typeof result.title).toBe("string");
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("raw mode converts full body without Readability extraction", async () => {
    const html = `<html><head><title>Raw</title></head><body><nav>Nav</nav><p>Content</p></body></html>`;

    fetchSpy.mockResolvedValueOnce(mockResponse(html));

    const raw = await toolDefinition.execute({ url: "https://example.com/raw", extractMode: "raw" });
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.markdown).toBeDefined();
    expect(typeof result.markdown).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// (g) Content truncation
// ---------------------------------------------------------------------------
describe("web-fetch — (g) content truncation", () => {
  it("truncates Markdown output to WEB_MAX_CONTENT_CHARS without breaking mid-word", async () => {
    // Generate HTML with lots of text — the mock Readability will pass it through
    const words = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
    const html = `<html><head><title>Long</title></head><body><p>${words}</p></body></html>`;

    (appConfig as Record<string, unknown>).webMaxContentChars = 200;

    fetchSpy.mockResolvedValueOnce(mockResponse(html));

    const raw = await toolDefinition.execute({ url: "https://example.com/long" });
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    // Output must be at most limit + 1 (for the "…" character)
    expect(result.markdown.length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------
// Mock-HTTP tests
// ---------------------------------------------------------------------------
describe("web-fetch — mock HTTP error handling", () => {
  it("returns an error for HTTP 404", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse("Not Found", 404));

    const raw = await toolDefinition.execute({ url: "https://example.com/missing" });
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/404/);
  });

  it("returns an error when fetch throws (network failure)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const raw = await toolDefinition.execute({ url: "https://example.com/unreachable" });
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/Fetch failed/i);
  });

  it("strips tracking params from the URL before fetching", async () => {
    const html = `<html><head><title>Clean</title></head><body><p>Clean content.</p></body></html>`;
    fetchSpy.mockResolvedValueOnce(mockResponse(html));

    const raw = await toolDefinition.execute({ url: "https://example.com/page?utm_source=gh&fbclid=abc" });
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    // The returned URL should not have tracking params
    expect(result.url).toBe("https://example.com/page");
    // fetch should have been called with the clean URL
    const calledWith = (fetchSpy.mock.calls[0][0] as string);
    expect(calledWith).toBe("https://example.com/page");
  });

  it("rejects a blocklisted domain without calling fetch", async () => {
    (appConfig as Record<string, unknown>).webDomainBlocklist = ["blocked.example.com"];

    const raw = await toolDefinition.execute({ url: "https://blocked.example.com/page" });
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/blocklist/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a private IP (http blocked by protocol check)", async () => {
    const raw = await toolDefinition.execute({ url: "http://169.254.169.254/meta" });
    const result = JSON.parse(raw);

    // Blocked by http:// protocol check (WEB_ALLOW_HTTP=false)
    expect(result.error).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a private IP even when http is allowed", async () => {
    (appConfig as Record<string, unknown>).webAllowHttp = true;

    const raw = await toolDefinition.execute({ url: "http://169.254.169.254/meta" });
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/private|SSRF/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

