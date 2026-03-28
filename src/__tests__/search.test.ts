// Mock duck-duck-scrape before importing the tool so we can control its output
const mockSearchResults = {
  noResults: false,
  vqd: "test-vqd",
  results: [
    {
      hostname: "example.com",
      url: "https://example.com",
      title: "Example Result",
      description: "An example snippet.",
      rawDescription: "An example snippet.",
      icon: "",
    },
  ],
};

const mockDdgSearch = jest.fn().mockResolvedValue(mockSearchResults);

jest.mock("duck-duck-scrape", () => ({
  search: mockDdgSearch,
}));

import { toolDefinition } from "../tools/search";
import { appConfig } from "../config";

const originalSearchConfig = {
  webSearchProvider: appConfig.webSearchProvider,
  minDelayMs: appConfig.duckduckgoMinDelayMs,
  retryMax: appConfig.duckduckgoRetryMax,
  retryBaseDelayMs: appConfig.duckduckgoRetryBaseDelayMs,
  rateLimitPenaltyMs: appConfig.duckduckgoRateLimitPenaltyMs,
  cacheTtlMs: appConfig.duckduckgoCacheTtlMs,
  cacheMaxEntries: appConfig.duckduckgoCacheMaxEntries,
  serveStaleOnError: appConfig.duckduckgoServeStaleOnError,
  tavilyApiKey: appConfig.tavilyApiKey,
  tavilyMaxResults: appConfig.tavilyMaxResults,
  langsearchApiKey: appConfig.langsearchApiKey,
  langsearchMaxResults: appConfig.langsearchMaxResults,
};

describe("search tool — toolDefinition metadata", () => {
  it("has name 'search'", () => {
    expect(toolDefinition.name).toBe("search");
  });

  it("has permissions 'safe'", () => {
    expect(toolDefinition.permissions).toBe("safe");
  });

  it("has a description mentioning web search", () => {
    expect(toolDefinition.description).toMatch(/search the web/i);
  });

  it("has a description mentioning WEB_SEARCH_PROVIDER", () => {
    expect(toolDefinition.description).toMatch(/WEB_SEARCH_PROVIDER/);
  });

  it("schema accepts a query string", () => {
    const parsed = toolDefinition.schema.parse({ query: "TypeScript tips" });
    expect(parsed).toEqual({ query: "TypeScript tips" });
  });

  it("schema rejects input without a query", () => {
    expect(() => toolDefinition.schema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DuckDuckGo provider
// ---------------------------------------------------------------------------

describe("search tool — duckduckgo provider", () => {
  beforeEach(() => {
    mockDdgSearch.mockClear();
    mockDdgSearch.mockResolvedValue(mockSearchResults);
    appConfig.webSearchProvider = "duckduckgo";
    appConfig.duckduckgoMinDelayMs = 0;
    appConfig.duckduckgoRetryMax = 2;
    appConfig.duckduckgoRetryBaseDelayMs = 0;
    appConfig.duckduckgoRateLimitPenaltyMs = 0;
    appConfig.duckduckgoCacheTtlMs = 300_000;
    appConfig.duckduckgoCacheMaxEntries = 128;
    appConfig.duckduckgoServeStaleOnError = true;
  });

  afterAll(() => {
    appConfig.webSearchProvider = originalSearchConfig.webSearchProvider;
    appConfig.duckduckgoMinDelayMs = originalSearchConfig.minDelayMs;
    appConfig.duckduckgoRetryMax = originalSearchConfig.retryMax;
    appConfig.duckduckgoRetryBaseDelayMs = originalSearchConfig.retryBaseDelayMs;
    appConfig.duckduckgoRateLimitPenaltyMs = originalSearchConfig.rateLimitPenaltyMs;
    appConfig.duckduckgoCacheTtlMs = originalSearchConfig.cacheTtlMs;
    appConfig.duckduckgoCacheMaxEntries = originalSearchConfig.cacheMaxEntries;
    appConfig.duckduckgoServeStaleOnError = originalSearchConfig.serveStaleOnError;
  });

  it("calls duck-duck-scrape search() with the provided query string", async () => {
    await toolDefinition.execute({ query: "OpenAI news" });
    expect(mockDdgSearch).toHaveBeenCalledWith("OpenAI news");
  });

  it("returns a JSON array with title, link and snippet fields", async () => {
    const result = await toolDefinition.execute({ query: "TypeScript" });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      title: "Example Result",
      link: "https://example.com",
      snippet: "An example snippet.",
    });
  });

  it("slices results to duckduckgoMaxResults", async () => {
    const manyResults = Array.from({ length: 20 }, (_, i) => ({
      hostname: "example.com",
      url: `https://example.com/${i}`,
      title: `Result ${i}`,
      description: `Snippet ${i}`,
      rawDescription: `Snippet ${i}`,
      icon: "",
    }));
    mockDdgSearch.mockResolvedValueOnce({ noResults: false, vqd: "vqd", results: manyResults });

    const result = await toolDefinition.execute({ query: "many results" });
    const parsed = JSON.parse(result) as unknown[];
    expect(parsed.length).toBe(appConfig.duckduckgoMaxResults);
  });

  it("returns a structured error payload when duck-duck-scrape fails", async () => {
    appConfig.duckduckgoRetryMax = 0;
    mockDdgSearch.mockRejectedValueOnce(new Error("network error"));
    const result = await toolDefinition.execute({ query: "fail" });
    const parsed = JSON.parse(result) as { error: string; query: string; results: unknown[] };

    expect(parsed.error).toMatch(/network error/i);
    expect(parsed.query).toBe("fail");
    expect(parsed.results).toEqual([]);
  });

  it("retries transient failures and succeeds", async () => {
    mockDdgSearch
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockResolvedValueOnce(mockSearchResults);

    const result = await toolDefinition.execute({ query: "retry case" });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;

    expect(mockDdgSearch).toHaveBeenCalledTimes(2);
    expect(parsed[0]).toMatchObject({ title: "Example Result" });
  });

  it("uses cache for repeated identical queries within ttl", async () => {
    const query = "cache behavior query ddg";
    const first = await toolDefinition.execute({ query });
    const second = await toolDefinition.execute({ query });

    expect(JSON.parse(first)).toEqual(JSON.parse(second));
    expect(mockDdgSearch).toHaveBeenCalledTimes(1);
  });

  it("serves stale cache when upstream fails and stale-on-error is enabled", async () => {
    const query = "stale cache query ddg";
    appConfig.duckduckgoCacheTtlMs = 1;

    await toolDefinition.execute({ query });
    await new Promise((resolve) => setTimeout(resolve, 5));

    mockDdgSearch.mockRejectedValueOnce(new Error("upstream timeout"));
    const result = await toolDefinition.execute({ query });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;

    expect(parsed[0]).toMatchObject({ title: "Example Result" });
  });

  it("enforces minimum delay between consecutive outbound requests", async () => {
    appConfig.duckduckgoMinDelayMs = 25;
    appConfig.duckduckgoCacheTtlMs = 0;
    const callTimes: number[] = [];

    mockDdgSearch.mockImplementation(async () => {
      callTimes.push(Date.now());
      return mockSearchResults;
    });

    await toolDefinition.execute({ query: "delay-case-1" });
    await toolDefinition.execute({ query: "delay-case-2" });

    expect(callTimes.length).toBe(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Tavily provider
// ---------------------------------------------------------------------------

const tavilySuccessResponse = {
  results: [
    { title: "Tavily Result", url: "https://tavily.com/result", content: "Tavily snippet." },
  ],
};

describe("search tool — tavily provider", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    appConfig.webSearchProvider = "tavily";
    appConfig.tavilyApiKey = "test-tavily-key";
    appConfig.tavilyMaxResults = 5;
    appConfig.duckduckgoCacheTtlMs = 300_000;
    appConfig.duckduckgoCacheMaxEntries = 128;
    appConfig.duckduckgoServeStaleOnError = false;

    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => tavilySuccessResponse,
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  afterAll(() => {
    appConfig.webSearchProvider = originalSearchConfig.webSearchProvider;
    appConfig.tavilyApiKey = originalSearchConfig.tavilyApiKey;
    appConfig.tavilyMaxResults = originalSearchConfig.tavilyMaxResults;
    appConfig.duckduckgoCacheTtlMs = originalSearchConfig.cacheTtlMs;
    appConfig.duckduckgoCacheMaxEntries = originalSearchConfig.cacheMaxEntries;
    appConfig.duckduckgoServeStaleOnError = originalSearchConfig.serveStaleOnError;
  });

  it("calls the Tavily API endpoint with query and api_key", async () => {
    await toolDefinition.execute({ query: "tavily test" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    const callBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(callBody.query).toBe("tavily test");
    expect(callBody.api_key).toBe("test-tavily-key");
    expect(callBody.max_results).toBe(5);
  });

  it("returns a JSON array with title, link and snippet fields", async () => {
    const result = await toolDefinition.execute({ query: "tavily results" });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      title: "Tavily Result",
      link: "https://tavily.com/result",
      snippet: "Tavily snippet.",
    });
  });

  it("returns a structured error payload when the API key is missing", async () => {
    appConfig.tavilyApiKey = "";
    fetchSpy.mockRestore();

    const result = await toolDefinition.execute({ query: "no key" });
    const parsed = JSON.parse(result) as { error: string; query: string; results: unknown[] };

    expect(parsed.error).toMatch(/TAVILY_API_KEY/i);
    expect(parsed.results).toEqual([]);
  });

  it("returns a structured error payload when the API returns a non-OK status", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({}),
    } as Response);

    const result = await toolDefinition.execute({ query: "bad key" });
    const parsed = JSON.parse(result) as { error: string; query: string; results: unknown[] };

    expect(parsed.error).toMatch(/401/);
    expect(parsed.results).toEqual([]);
  });

  it("caches repeated identical queries", async () => {
    const query = "tavily cache query";
    await toolDefinition.execute({ query });
    await toolDefinition.execute({ query });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// LangSearch provider
// ---------------------------------------------------------------------------

const langsearchSuccessResponse = {
  code: 200,
  webPages: {
    value: [
      { name: "LangSearch Result", url: "https://langsearch.com/result", snippet: "LangSearch snippet." },
    ],
  },
};

describe("search tool — langsearch provider", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    appConfig.webSearchProvider = "langsearch";
    appConfig.langsearchApiKey = "test-langsearch-key";
    appConfig.langsearchMaxResults = 5;
    appConfig.duckduckgoCacheTtlMs = 300_000;
    appConfig.duckduckgoCacheMaxEntries = 128;
    appConfig.duckduckgoServeStaleOnError = false;

    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => langsearchSuccessResponse,
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  afterAll(() => {
    appConfig.webSearchProvider = originalSearchConfig.webSearchProvider;
    appConfig.langsearchApiKey = originalSearchConfig.langsearchApiKey;
    appConfig.langsearchMaxResults = originalSearchConfig.langsearchMaxResults;
    appConfig.duckduckgoCacheTtlMs = originalSearchConfig.cacheTtlMs;
    appConfig.duckduckgoCacheMaxEntries = originalSearchConfig.cacheMaxEntries;
    appConfig.duckduckgoServeStaleOnError = originalSearchConfig.serveStaleOnError;
  });

  it("calls the LangSearch API endpoint with Bearer auth and query", async () => {
    await toolDefinition.execute({ query: "langsearch test" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.langsearch.com/v1/web-search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-langsearch-key",
          "Content-Type": "application/json",
        }),
      })
    );

    const callBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(callBody.query).toBe("langsearch test");
    expect(callBody.count).toBe(5);
  });

  it("returns a JSON array with title, link and snippet fields", async () => {
    const result = await toolDefinition.execute({ query: "langsearch results" });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      title: "LangSearch Result",
      link: "https://langsearch.com/result",
      snippet: "LangSearch snippet.",
    });
  });

  it("returns a structured error payload when the API key is missing", async () => {
    appConfig.langsearchApiKey = "";
    fetchSpy.mockRestore();

    const result = await toolDefinition.execute({ query: "no key" });
    const parsed = JSON.parse(result) as { error: string; query: string; results: unknown[] };

    expect(parsed.error).toMatch(/LANGSEARCH_API_KEY/i);
    expect(parsed.results).toEqual([]);
  });

  it("returns a structured error payload when the API returns a non-OK status", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    } as Response);

    const result = await toolDefinition.execute({ query: "bad key" });
    const parsed = JSON.parse(result) as { error: string; query: string; results: unknown[] };

    expect(parsed.error).toMatch(/403/);
    expect(parsed.results).toEqual([]);
  });

  it("caches repeated identical queries", async () => {
    const query = "langsearch cache query";
    await toolDefinition.execute({ query });
    await toolDefinition.execute({ query });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// None provider
// ---------------------------------------------------------------------------

describe("search tool — none provider", () => {
  beforeEach(() => {
    mockDdgSearch.mockClear();
    appConfig.webSearchProvider = "none";
    appConfig.duckduckgoCacheTtlMs = 0;
  });

  afterAll(() => {
    appConfig.webSearchProvider = originalSearchConfig.webSearchProvider;
    appConfig.duckduckgoCacheTtlMs = originalSearchConfig.cacheTtlMs;
  });

  it("returns an empty JSON array without making any network calls", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const result = await toolDefinition.execute({ query: "anything" });
    const parsed = JSON.parse(result) as unknown[];

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDdgSearch).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

describe("search tool — provider selection", () => {
  afterEach(() => {
    appConfig.webSearchProvider = originalSearchConfig.webSearchProvider;
    appConfig.tavilyApiKey = originalSearchConfig.tavilyApiKey;
    appConfig.langsearchApiKey = originalSearchConfig.langsearchApiKey;
    appConfig.duckduckgoCacheTtlMs = 0;
  });

  it("routes to DuckDuckGo when WEB_SEARCH_PROVIDER=duckduckgo", async () => {
    mockDdgSearch.mockClear();
    mockDdgSearch.mockResolvedValue(mockSearchResults);
    appConfig.webSearchProvider = "duckduckgo";
    appConfig.duckduckgoMinDelayMs = 0;
    appConfig.duckduckgoRetryMax = 0;

    await toolDefinition.execute({ query: "provider routing ddg" });

    expect(mockDdgSearch).toHaveBeenCalled();
  });

  it("routes to Tavily when WEB_SEARCH_PROVIDER=tavily", async () => {
    appConfig.webSearchProvider = "tavily";
    appConfig.tavilyApiKey = "key";

    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);

    await toolDefinition.execute({ query: "provider routing tavily" });

    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("tavily"), expect.any(Object));
    fetchSpy.mockRestore();
  });

  it("routes to LangSearch when WEB_SEARCH_PROVIDER=langsearch", async () => {
    appConfig.webSearchProvider = "langsearch";
    appConfig.langsearchApiKey = "key";

    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ webPages: { value: [] } }),
    } as Response);

    await toolDefinition.execute({ query: "provider routing langsearch" });

    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("langsearch"), expect.any(Object));
    fetchSpy.mockRestore();
  });

  it("returns empty results when WEB_SEARCH_PROVIDER=none", async () => {
    appConfig.webSearchProvider = "none";

    const result = await toolDefinition.execute({ query: "provider routing none" });
    const parsed = JSON.parse(result) as unknown[];

    expect(parsed).toHaveLength(0);
  });
});
