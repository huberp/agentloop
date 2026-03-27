/**
 * Unit tests for src/tools/web-utils.ts
 * No real network calls — DNS and fetch are mocked.
 */

import * as dns from "dns";
import * as fs from "fs/promises";
import * as path from "path";

// ---------------------------------------------------------------------------
// Mock dns.promises before importing web-utils
// ---------------------------------------------------------------------------
jest.mock("dns", () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

const mockResolve4 = dns.promises.resolve4 as jest.Mock;
const mockResolve6 = dns.promises.resolve6 as jest.Mock;

import {
  sanitizeUrl,
  checkProtocol,
  checkBlocklist,
  checkAllowlist,
  checkSsrf,
  fetchWithLimits,
  extractReadable,
  extractBodyHtml,
  extractTitle,
  htmlToMarkdown,
  truncateAtWordBoundary,
} from "../../src/tools/web-utils";

// ---------------------------------------------------------------------------
// (a) URL sanitization
// ---------------------------------------------------------------------------
describe("sanitizeUrl", () => {
  it("strips utm_source and fbclid from a URL", () => {
    const result = sanitizeUrl("https://example.com/page?utm_source=twitter&fbclid=abc123");
    expect(result).toBe("https://example.com/page");
  });

  it("preserves non-tracking query parameters while removing utm_medium", () => {
    const result = sanitizeUrl("https://example.com/page?id=42&utm_medium=social");
    expect(result).toBe("https://example.com/page?id=42");
  });

  it("strips gclid tracking parameter", () => {
    const result = sanitizeUrl("https://example.com/page?gclid=xyz&id=42");
    const parsed = new URL(result);
    // gclid should be removed, id should remain
    expect(parsed.searchParams.has("gclid")).toBe(false);
    expect(parsed.searchParams.get("id")).toBe("42");
  });

  it("returns the URL unchanged when there are no tracking parameters", () => {
    const result = sanitizeUrl("https://example.com/page?id=42&sort=asc");
    expect(result).toBe("https://example.com/page?id=42&sort=asc");
  });
});

// ---------------------------------------------------------------------------
// (b) Protocol enforcement
// ---------------------------------------------------------------------------
describe("checkProtocol", () => {
  it("allows https: URLs", () => {
    expect(() => checkProtocol("https://example.com", false)).not.toThrow();
  });

  it("rejects http: when allowHttp is false", () => {
    expect(() => checkProtocol("http://example.com", false)).toThrow(/http:/);
  });

  it("allows http: when allowHttp is true", () => {
    expect(() => checkProtocol("http://example.com", true)).not.toThrow();
  });

  it("always rejects ftp: even when allowHttp is true", () => {
    expect(() => checkProtocol("ftp://example.com", true)).toThrow();
  });

  it("always rejects file: URLs", () => {
    expect(() => checkProtocol("file:///etc/passwd", false)).toThrow();
  });

  it("always rejects javascript: URLs", () => {
    expect(() => checkProtocol("javascript:alert(1)", false)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// (c) Domain blocklist
// ---------------------------------------------------------------------------
describe("checkBlocklist", () => {
  it("blocks 'localhost' (built-in)", () => {
    expect(() => checkBlocklist("localhost", [])).toThrow(/blocked/i);
  });

  it("blocks '169.254.169.254' (built-in — AWS metadata)", () => {
    expect(() => checkBlocklist("169.254.169.254", [])).toThrow(/blocked/i);
  });

  it("blocks 'metadata.google.internal' (built-in — GCP metadata)", () => {
    expect(() => checkBlocklist("metadata.google.internal", [])).toThrow(/blocked/i);
  });

  it("blocks a user-configured domain (exact match)", () => {
    expect(() => checkBlocklist("evil.com", ["evil.com"])).toThrow(/blocked/i);
  });

  it("blocks a subdomain of a user-configured domain (suffix match)", () => {
    expect(() => checkBlocklist("sub.evil.com", ["evil.com"])).toThrow(/blocked/i);
  });

  it("allows a domain not on the blocklist", () => {
    expect(() => checkBlocklist("example.com", ["evil.com"])).not.toThrow();
  });

  it("does NOT block 'notevil.com' when only 'evil.com' is listed (no false suffix match)", () => {
    expect(() => checkBlocklist("notevil.com", ["evil.com"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (d) Domain allowlist
// ---------------------------------------------------------------------------
describe("checkAllowlist", () => {
  it("allows a listed domain", () => {
    expect(() =>
      checkAllowlist("docs.python.org", ["docs.python.org", "developer.mozilla.org"])
    ).not.toThrow();
  });

  it("rejects a domain not in the allowlist when allowlist is non-empty", () => {
    expect(() => checkAllowlist("evil.com", ["docs.python.org"])).toThrow(/allowlist/i);
  });

  it("permits any domain when the allowlist is empty", () => {
    expect(() => checkAllowlist("anything.com", [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (e) SSRF protection
// ---------------------------------------------------------------------------
describe("checkSsrf", () => {
  beforeEach(() => {
    mockResolve4.mockReset();
    mockResolve6.mockReset();
  });

  it("throws for hostname resolving to 127.0.0.1 (loopback)", async () => {
    mockResolve4.mockResolvedValueOnce(["127.0.0.1"]);
    mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
    await expect(checkSsrf("local.test")).rejects.toThrow(/SSRF/);
  });

  it("throws for hostname resolving to 10.0.0.1 (RFC 1918)", async () => {
    mockResolve4.mockResolvedValueOnce(["10.0.0.1"]);
    mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
    await expect(checkSsrf("internal.test")).rejects.toThrow(/SSRF/);
  });

  it("throws for hostname resolving to 172.16.0.1 (RFC 1918)", async () => {
    mockResolve4.mockResolvedValueOnce(["172.16.0.1"]);
    mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
    await expect(checkSsrf("internal2.test")).rejects.toThrow(/SSRF/);
  });

  it("throws for hostname resolving to 192.168.1.1 (RFC 1918)", async () => {
    mockResolve4.mockResolvedValueOnce(["192.168.1.1"]);
    mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
    await expect(checkSsrf("router.test")).rejects.toThrow(/SSRF/);
  });

  it("throws for hostname resolving to 169.254.169.254 (link-local)", async () => {
    mockResolve4.mockResolvedValueOnce(["169.254.169.254"]);
    mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
    await expect(checkSsrf("aws.metadata.test")).rejects.toThrow(/SSRF/);
  });

  it("allows a hostname resolving to a public IP", async () => {
    mockResolve4.mockResolvedValueOnce(["93.184.216.34"]);
    mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
    await expect(checkSsrf("example.com")).resolves.not.toThrow();
  });

  it("throws for the IPv4 literal 127.0.0.1 (no DNS needed)", async () => {
    await expect(checkSsrf("127.0.0.1")).rejects.toThrow(/SSRF/);
  });

  it("throws for hostname resolving to ::1 (IPv6 loopback)", async () => {
    mockResolve4.mockRejectedValueOnce(new Error("ENODATA"));
    mockResolve6.mockResolvedValueOnce(["::1"]);
    await expect(checkSsrf("ipv6local.test")).rejects.toThrow(/SSRF/);
  });

  it("throws for hostname resolving to fc00::1 (IPv6 unique-local)", async () => {
    mockResolve4.mockRejectedValueOnce(new Error("ENODATA"));
    mockResolve6.mockResolvedValueOnce(["fc00::1"]);
    await expect(checkSsrf("ipv6ula.test")).rejects.toThrow(/SSRF/);
  });
});

// ---------------------------------------------------------------------------
// (f) Content extraction (fixture HTML)
// ---------------------------------------------------------------------------
describe("content extraction", () => {
  let fixtureHtml: string;

  beforeAll(async () => {
    const fixturePath = path.join(__dirname, "../../tests/fixtures/sample-article.html");
    fixtureHtml = await fs.readFile(fixturePath, "utf-8");
  });

  it("extractReadable returns a result with article content", () => {
    const result = extractReadable(fixtureHtml, "https://example.com");
    expect(result).not.toBeNull();
    // Readability may use page <title> or article heading as title
    expect(result!.title).toBeTruthy();
    // Content should contain article text
    expect(result!.content).toContain("Generics allow");
  });

  it("extractBodyHtml returns full body HTML including nav and footer", () => {
    const body = extractBodyHtml(fixtureHtml);
    expect(body).toContain("Home");
    expect(body).toContain("Example Blog");
    expect(body).toContain("Generics allow");
  });

  it("htmlToMarkdown converts h1, p, and code blocks correctly", () => {
    const html = "<h1>Title</h1><p>Text</p><pre><code>const x = 1;</code></pre>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Title");
    expect(md).toContain("Text");
    expect(md).toContain("const x = 1;");
  });

  it("htmlToMarkdown strips <script> and <style> elements", () => {
    const html = "<p>Content</p><script>alert('bad')</script><style>.x{}</style>";
    const md = htmlToMarkdown(html);
    expect(md).not.toContain("alert");
    expect(md).not.toContain(".x{}");
    expect(md).toContain("Content");
  });

  it("extractTitle returns the page title", () => {
    const title = extractTitle(fixtureHtml);
    expect(title).toBe("Sample Article");
  });
});

// ---------------------------------------------------------------------------
// (g) Truncation
// ---------------------------------------------------------------------------
describe("truncateAtWordBoundary", () => {
  it("truncates at word boundary and appends notice", () => {
    const result = truncateAtWordBoundary("hello world foo bar", 11);
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/^hello world/);
    expect(result.text).toContain("[Content truncated at 11 characters]");
  });

  it("returns the original text unchanged when within limit", () => {
    const result = truncateAtWordBoundary("short", 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("short");
  });

  it("does not break in the middle of a word", () => {
    const result = truncateAtWordBoundary("hello world foo bar", 13);
    // maxChars=13: "hello world f" — must cut back to last space, so truncated text starts "hello world"
    const truncatedPart = result.text.split("\n\n")[0];
    expect(truncatedPart).toBe("hello world");
    expect(result.truncated).toBe(true);
  });

  it("handles exact length gracefully (no truncation)", () => {
    const text = "hello";
    const result = truncateAtWordBoundary(text, 5);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// (h) fetchWithLimits (mock global fetch)
// ---------------------------------------------------------------------------
describe("fetchWithLimits", () => {
  const defaultConfig = { timeoutMs: 5000, userAgent: "TestAgent/1.0", maxBytes: 1048576 };

  function makeStream(text: string) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  function mockFetch(options: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    contentType?: string;
    contentLength?: string | null;
    body?: string;
  }) {
    const {
      ok = true,
      status = 200,
      statusText = "OK",
      contentType = "text/html; charset=utf-8",
      contentLength = null,
      body = "<html><body>Hello</body></html>",
    } = options;

    const headers = new Headers();
    headers.set("content-type", contentType);
    if (contentLength !== null) headers.set("content-length", contentLength);

    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status,
      statusText,
      headers,
      body: makeStream(body),
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns HTML body on a successful response", async () => {
    mockFetch({ body: "<html><body>Hello World</body></html>" });
    const result = await fetchWithLimits("https://example.com", defaultConfig);
    expect(result).toContain("Hello World");
  });

  it("throws when content-length exceeds maxBytes", async () => {
    mockFetch({ contentLength: "99999999" });
    await expect(
      fetchWithLimits("https://example.com", { ...defaultConfig, maxBytes: 100 })
    ).rejects.toThrow(/exceeds the limit/);
  });

  it("throws when content-type is not HTML (application/json)", async () => {
    mockFetch({ contentType: "application/json" });
    await expect(fetchWithLimits("https://example.com", defaultConfig)).rejects.toThrow(
      /Unsupported content type/
    );
  });

  it("throws when content-type is an image", async () => {
    mockFetch({ contentType: "image/png" });
    await expect(fetchWithLimits("https://example.com", defaultConfig)).rejects.toThrow(
      /Unsupported content type/
    );
  });

  it("throws on HTTP 404", async () => {
    mockFetch({ ok: false, status: 404, statusText: "Not Found" });
    await expect(fetchWithLimits("https://example.com", defaultConfig)).rejects.toThrow("HTTP 404");
  });

  it("throws on HTTP 500", async () => {
    mockFetch({ ok: false, status: 500, statusText: "Internal Server Error" });
    await expect(fetchWithLimits("https://example.com", defaultConfig)).rejects.toThrow("HTTP 500");
  });

  it("throws on timeout (AbortError)", async () => {
    global.fetch = jest.fn().mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            (err as any).name = "AbortError";
            reject(err);
          });
        })
    );
    await expect(
      fetchWithLimits("https://example.com", { ...defaultConfig, timeoutMs: 10 })
    ).rejects.toThrow(/timed out/);
  });
});
