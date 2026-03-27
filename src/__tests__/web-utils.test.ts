/**
 * Tests for src/tools/web-utils.ts
 *
 * All tests are purely synchronous / use mocked DNS — no real network calls.
 */
import { sanitizeUrl, validateUrl, checkSsrf, processUrl } from "../tools/web-utils";
import { appConfig } from "../config";

// Mock dns/promises at the module level to allow jest.spyOn overrides
jest.mock("dns/promises", () => ({
  resolve: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dnsMock = require("dns/promises") as { resolve: jest.Mock };

// ---------------------------------------------------------------------------
// (a) URL sanitization — tracking-parameter stripping
// ---------------------------------------------------------------------------
describe("web-utils — (a) URL sanitization", () => {
  it("strips utm_source parameter", () => {
    const cleaned = sanitizeUrl("https://example.com/article?utm_source=twitter");
    expect(cleaned).toBe("https://example.com/article");
  });

  it("strips utm_medium and utm_campaign", () => {
    const cleaned = sanitizeUrl("https://example.com/page?id=42&utm_medium=email&utm_campaign=newsletter");
    const parsed = new URL(cleaned);
    expect(parsed.searchParams.has("utm_medium")).toBe(false);
    expect(parsed.searchParams.has("utm_campaign")).toBe(false);
    expect(parsed.searchParams.get("id")).toBe("42"); // legitimate param preserved
  });

  it("strips fbclid parameter", () => {
    const cleaned = sanitizeUrl("https://example.com/post?fbclid=abc123");
    expect(cleaned).toBe("https://example.com/post");
  });

  it("strips gclid parameter", () => {
    const cleaned = sanitizeUrl("https://example.com/landing?gclid=xyz789");
    expect(cleaned).toBe("https://example.com/landing");
  });

  it("returns the URL unchanged when there are no tracking params", () => {
    const url = "https://example.com/docs/api?version=2&lang=en";
    const cleaned = sanitizeUrl(url);
    // The URL may be normalised (e.g. trailing slash) but params should be intact
    const parsed = new URL(cleaned);
    expect(parsed.searchParams.get("version")).toBe("2");
    expect(parsed.searchParams.get("lang")).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// (b) Blocklisted domain rejection
// ---------------------------------------------------------------------------
describe("web-utils — (b) domain blocklist", () => {
  it("rejects the built-in localhost entry", () => {
    const err = validateUrl("http://localhost:3000/api");
    expect(err).not.toBeNull();
    expect(err).toMatch(/blocklist/i);
  });

  it("rejects a user-configured blocked domain", () => {
    const original = appConfig.webDomainBlocklist;
    (appConfig as Record<string, unknown>).webDomainBlocklist = ["evil.example.com"];
    try {
      const err = validateUrl("https://evil.example.com/payload");
      expect(err).not.toBeNull();
      expect(err).toMatch(/blocklist/i);
    } finally {
      (appConfig as Record<string, unknown>).webDomainBlocklist = original;
    }
  });

  it("rejects a subdomain of a blocked domain", () => {
    const original = appConfig.webDomainBlocklist;
    (appConfig as Record<string, unknown>).webDomainBlocklist = ["badactor.net"];
    try {
      const err = validateUrl("https://sub.badactor.net/path");
      expect(err).not.toBeNull();
      expect(err).toMatch(/blocklist/i);
    } finally {
      (appConfig as Record<string, unknown>).webDomainBlocklist = original;
    }
  });

  it("allows a domain not on any blocklist", () => {
    const origBlocklist = appConfig.webDomainBlocklist;
    const origAllowlist = appConfig.webDomainAllowlist;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    try {
      const err = validateUrl("https://example.com/page");
      expect(err).toBeNull();
    } finally {
      (appConfig as Record<string, unknown>).webDomainBlocklist = origBlocklist;
      (appConfig as Record<string, unknown>).webDomainAllowlist = origAllowlist;
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Allowlist-only mode
// ---------------------------------------------------------------------------
describe("web-utils — (c) domain allowlist", () => {
  beforeEach(() => {
    (appConfig as Record<string, unknown>).webDomainAllowlist = ["trusted.example.com"];
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
  });

  afterEach(() => {
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
  });

  it("rejects a domain not on the allowlist", () => {
    const err = validateUrl("https://notlisted.example.com/page");
    expect(err).not.toBeNull();
    expect(err).toMatch(/allowlist/i);
  });

  it("permits the exact allowlisted domain", () => {
    const err = validateUrl("https://trusted.example.com/page");
    expect(err).toBeNull();
  });

  it("permits a subdomain of an allowlisted domain", () => {
    const err = validateUrl("https://api.trusted.example.com/v1/data");
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) Private IP / SSRF protection
// ---------------------------------------------------------------------------
describe("web-utils — (d) SSRF protection", () => {
  beforeEach(() => {
    // Default: DNS resolution fails (simulates non-existent host) unless overridden per-test
    dnsMock.resolve.mockRejectedValue(new Error("ENOTFOUND"));
  });
  it("rejects 169.254.169.254 (AWS metadata endpoint) by IP literal", async () => {
    const err = await checkSsrf("http://169.254.169.254/latest/meta-data/");
    expect(err).not.toBeNull();
    expect(err).toMatch(/private|SSRF/i);
  });

  it("rejects 127.0.0.1 loopback by IP literal", async () => {
    const err = await checkSsrf("http://127.0.0.1:8080/");
    expect(err).not.toBeNull();
    expect(err).toMatch(/private|SSRF/i);
  });

  it("rejects 10.0.0.1 private IP by IP literal", async () => {
    const err = await checkSsrf("https://10.0.0.1/admin");
    expect(err).not.toBeNull();
    expect(err).toMatch(/private|SSRF/i);
  });

  it("rejects 192.168.1.1 private IP by IP literal", async () => {
    const err = await checkSsrf("https://192.168.1.1/");
    expect(err).not.toBeNull();
    expect(err).toMatch(/private|SSRF/i);
  });

  it("rejects 172.16.0.1 private IP by IP literal", async () => {
    const err = await checkSsrf("https://172.16.0.1/");
    expect(err).not.toBeNull();
    expect(err).toMatch(/private|SSRF/i);
  });

  it("rejects ::1 IPv6 loopback", async () => {
    const err = await checkSsrf("http://[::1]:3000/");
    expect(err).not.toBeNull();
    expect(err).toMatch(/private|SSRF/i);
  });

  it("rejects hostname that DNS-resolves to a private address", async () => {
    dnsMock.resolve.mockResolvedValueOnce(["192.168.50.1"]);
    const err = await checkSsrf("https://internal-service.example.com/");
    expect(err).not.toBeNull();
    expect(err).toMatch(/private|SSRF/i);
  });

  it("passes a public IP address", async () => {
    const err = await checkSsrf("https://93.184.216.34/"); // example.com's IP
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (e) Protocol enforcement
// ---------------------------------------------------------------------------
describe("web-utils — (e) protocol enforcement", () => {
  it("rejects http:// when WEB_ALLOW_HTTP=false", () => {
    const origAllow = appConfig.webAllowHttp;
    const origBlocklist = appConfig.webDomainBlocklist;
    const origAllowlist = appConfig.webDomainAllowlist;
    (appConfig as Record<string, unknown>).webAllowHttp = false;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    try {
      const err = validateUrl("http://example.com/page");
      expect(err).not.toBeNull();
      expect(err).toMatch(/http/i);
    } finally {
      (appConfig as Record<string, unknown>).webAllowHttp = origAllow;
      (appConfig as Record<string, unknown>).webDomainBlocklist = origBlocklist;
      (appConfig as Record<string, unknown>).webDomainAllowlist = origAllowlist;
    }
  });

  it("allows http:// when WEB_ALLOW_HTTP=true", () => {
    const origAllow = appConfig.webAllowHttp;
    const origBlocklist = appConfig.webDomainBlocklist;
    const origAllowlist = appConfig.webDomainAllowlist;
    (appConfig as Record<string, unknown>).webAllowHttp = true;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    try {
      const err = validateUrl("http://example.com/page");
      expect(err).toBeNull();
    } finally {
      (appConfig as Record<string, unknown>).webAllowHttp = origAllow;
      (appConfig as Record<string, unknown>).webDomainBlocklist = origBlocklist;
      (appConfig as Record<string, unknown>).webDomainAllowlist = origAllowlist;
    }
  });

  it("rejects ftp:// regardless of HTTP setting", () => {
    const err = validateUrl("ftp://example.com/file.tar.gz");
    expect(err).not.toBeNull();
    expect(err).toMatch(/protocol/i);
  });

  it("allows https:// by default", () => {
    const origBlocklist = appConfig.webDomainBlocklist;
    const origAllowlist = appConfig.webDomainAllowlist;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    try {
      const err = validateUrl("https://example.com/secure");
      expect(err).toBeNull();
    } finally {
      (appConfig as Record<string, unknown>).webDomainBlocklist = origBlocklist;
      (appConfig as Record<string, unknown>).webDomainAllowlist = origAllowlist;
    }
  });
});

// ---------------------------------------------------------------------------
// processUrl — combined pipeline
// ---------------------------------------------------------------------------
describe("web-utils — processUrl combined pipeline", () => {
  it("returns cleanUrl and null error for a valid https URL", () => {
    const origBlocklist = appConfig.webDomainBlocklist;
    const origAllowlist = appConfig.webDomainAllowlist;
    (appConfig as Record<string, unknown>).webDomainBlocklist = [];
    (appConfig as Record<string, unknown>).webDomainAllowlist = [];
    try {
      const { cleanUrl, error } = processUrl("https://example.com/article?utm_source=gh");
      expect(error).toBeNull();
      expect(cleanUrl).toBe("https://example.com/article");
    } finally {
      (appConfig as Record<string, unknown>).webDomainBlocklist = origBlocklist;
      (appConfig as Record<string, unknown>).webDomainAllowlist = origAllowlist;
    }
  });

  it("returns error for a localhost URL", () => {
    const { error } = processUrl("http://localhost/admin");
    expect(error).not.toBeNull();
    expect(error).toMatch(/blocklist/i);
  });
});
