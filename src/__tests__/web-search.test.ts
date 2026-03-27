/**
 * Tests for src/tools/web-search.ts
 *
 * (h) Search returns structured results (mock HTTP layer)
 * Provider=none returns a descriptive error
 */
import { toolDefinition } from "../tools/web-search";
import { appConfig } from "../config";

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch not mocked for this test");
  });
});
afterEach(() => {
  fetchSpy.mockRestore();
  (appConfig as Record<string, unknown>).webSearchProvider = "none";
  (appConfig as Record<string, unknown>).braveApiKey = "";
  (appConfig as Record<string, unknown>).tavilyApiKey = "";
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
describe("web-search — metadata", () => {
  it("has correct name and permission level", () => {
    expect(toolDefinition.name).toBe("web-search");
    expect(toolDefinition.permissions).toBe("cautious");
  });
});

// ---------------------------------------------------------------------------
// Provider = none (default)
// ---------------------------------------------------------------------------
describe("web-search — provider=none", () => {
  it("returns a descriptive error when WEB_SEARCH_PROVIDER=none", async () => {
    (appConfig as Record<string, unknown>).webSearchProvider = "none";

    const raw = await toolDefinition.execute({ query: "express.js middleware tutorial" });
    const result = JSON.parse(raw);

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/WEB_SEARCH_PROVIDER/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (h) Brave search — structured results
// ---------------------------------------------------------------------------
describe("web-search — (h) Brave search structured results", () => {
  beforeEach(() => {
    (appConfig as Record<string, unknown>).webSearchProvider = "brave";
    (appConfig as Record<string, unknown>).braveApiKey = "test-key";
  });

  it("returns results array with title, url, snippet", async () => {
    const mockPayload = {
      web: {
        results: [
          {
            title: "Express.js Guide",
            url: "https://expressjs.com/guide?utm_source=brave",
            description: "A comprehensive guide to Express.js middleware.",
          },
          {
            title: "Middleware Tutorial",
            url: "https://example.com/middleware",
            description: "Learn how to write Express middleware.",
          },
        ],
      },
    };

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockPayload,
    } as unknown as Response);

    const raw = await toolDefinition.execute({ query: "express.js middleware tutorial", maxResults: 5 });
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBe(2);

    const first = result.results[0];
    expect(first.title).toBe("Express.js Guide");
    expect(first.snippet).toBe("A comprehensive guide to Express.js middleware.");
    // Tracking param should be stripped from URL
    expect(first.url).toBe("https://expressjs.com/guide");
  });

  it("returns an error when the API responds with a non-200 status", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as unknown as Response);

    const raw = await toolDefinition.execute({ query: "test query" });
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/401/);
  });

  it("returns an error when BRAVE_API_KEY is not set", async () => {
    (appConfig as Record<string, unknown>).braveApiKey = "";

    const raw = await toolDefinition.execute({ query: "test query" });
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/BRAVE_API_KEY/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tavily search — structured results
// ---------------------------------------------------------------------------
describe("web-search — Tavily search structured results", () => {
  beforeEach(() => {
    (appConfig as Record<string, unknown>).webSearchProvider = "tavily";
    (appConfig as Record<string, unknown>).tavilyApiKey = "tavily-test-key";
  });

  it("returns results array with title, url, snippet", async () => {
    const mockPayload = {
      results: [
        {
          title: "TypeScript Handbook",
          url: "https://typescriptlang.org/docs?fbclid=xyz",
          content: "Official TypeScript documentation.",
        },
      ],
    };

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockPayload,
    } as unknown as Response);

    const raw = await toolDefinition.execute({ query: "typescript handbook", maxResults: 3 });
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.results.length).toBe(1);

    const first = result.results[0];
    expect(first.title).toBe("TypeScript Handbook");
    // fbclid should be stripped
    expect(first.url).toBe("https://typescriptlang.org/docs");
    expect(first.snippet).toBe("Official TypeScript documentation.");
  });

  it("returns an error when TAVILY_API_KEY is not set", async () => {
    (appConfig as Record<string, unknown>).tavilyApiKey = "";

    const raw = await toolDefinition.execute({ query: "test" });
    const result = JSON.parse(raw);

    expect(result.error).toMatch(/TAVILY_API_KEY/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
