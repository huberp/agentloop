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

const mockSearch = jest.fn().mockResolvedValue(mockSearchResults);

jest.mock("duck-duck-scrape", () => ({
  search: mockSearch,
}));

import { toolDefinition } from "../tools/search";
import { appConfig } from "../config";

const originalSearchConfig = {
  minDelayMs: appConfig.duckduckgoMinDelayMs,
  retryMax: appConfig.duckduckgoRetryMax,
  retryBaseDelayMs: appConfig.duckduckgoRetryBaseDelayMs,
  rateLimitPenaltyMs: appConfig.duckduckgoRateLimitPenaltyMs,
  cacheTtlMs: appConfig.duckduckgoCacheTtlMs,
  cacheMaxEntries: appConfig.duckduckgoCacheMaxEntries,
  serveStaleOnError: appConfig.duckduckgoServeStaleOnError,
};

describe("search tool — toolDefinition metadata", () => {
  it("has name 'search'", () => {
    expect(toolDefinition.name).toBe("search");
  });

  it("has permissions 'safe'", () => {
    expect(toolDefinition.permissions).toBe("safe");
  });

  it("has a description mentioning DuckDuckGo", () => {
    expect(toolDefinition.description).toMatch(/DuckDuckGo/i);
  });

  it("schema accepts a query string", () => {
    const parsed = toolDefinition.schema.parse({ query: "TypeScript tips" });
    expect(parsed).toEqual({ query: "TypeScript tips" });
  });

  it("schema rejects input without a query", () => {
    expect(() => toolDefinition.schema.parse({})).toThrow();
  });
});

describe("search tool — execute", () => {
  beforeEach(() => {
    mockSearch.mockClear();
    mockSearch.mockResolvedValue(mockSearchResults);
    appConfig.duckduckgoMinDelayMs = 0;
    appConfig.duckduckgoRetryMax = 2;
    appConfig.duckduckgoRetryBaseDelayMs = 0;
    appConfig.duckduckgoRateLimitPenaltyMs = 0;
    appConfig.duckduckgoCacheTtlMs = 300_000;
    appConfig.duckduckgoCacheMaxEntries = 128;
    appConfig.duckduckgoServeStaleOnError = true;
  });

  afterAll(() => {
    appConfig.duckduckgoMinDelayMs = originalSearchConfig.minDelayMs;
    appConfig.duckduckgoRetryMax = originalSearchConfig.retryMax;
    appConfig.duckduckgoRetryBaseDelayMs = originalSearchConfig.retryBaseDelayMs;
    appConfig.duckduckgoRateLimitPenaltyMs = originalSearchConfig.rateLimitPenaltyMs;
    appConfig.duckduckgoCacheTtlMs = originalSearchConfig.cacheTtlMs;
    appConfig.duckduckgoCacheMaxEntries = originalSearchConfig.cacheMaxEntries;
    appConfig.duckduckgoServeStaleOnError = originalSearchConfig.serveStaleOnError;
  });

  it("calls search() with the provided query string", async () => {
    await toolDefinition.execute({ query: "OpenAI news" });
    expect(mockSearch).toHaveBeenCalledWith("OpenAI news");
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
    mockSearch.mockResolvedValueOnce({ noResults: false, vqd: "vqd", results: manyResults });

    const result = await toolDefinition.execute({ query: "many results" });
    const parsed = JSON.parse(result) as unknown[];
    expect(parsed.length).toBe(appConfig.duckduckgoMaxResults);
  });

  it("returns a structured error payload when duck-duck-scrape fails", async () => {
    appConfig.duckduckgoRetryMax = 0;
    mockSearch.mockRejectedValueOnce(new Error("network error"));
    const result = await toolDefinition.execute({ query: "fail" });
    const parsed = JSON.parse(result) as { error: string; query: string; results: unknown[] };

    expect(parsed.error).toMatch(/network error/i);
    expect(parsed.query).toBe("fail");
    expect(parsed.results).toEqual([]);
  });

  it("retries transient failures and succeeds", async () => {
    mockSearch
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockResolvedValueOnce(mockSearchResults);

    const result = await toolDefinition.execute({ query: "retry case" });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(parsed[0]).toMatchObject({ title: "Example Result" });
  });

  it("uses cache for repeated identical queries within ttl", async () => {
    const query = "cache behavior query";
    const first = await toolDefinition.execute({ query });
    const second = await toolDefinition.execute({ query });

    expect(JSON.parse(first)).toEqual(JSON.parse(second));
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it("serves stale cache when upstream fails and stale-on-error is enabled", async () => {
    const query = "stale cache query";
    appConfig.duckduckgoCacheTtlMs = 1;

    await toolDefinition.execute({ query });
    await new Promise((resolve) => setTimeout(resolve, 5));

    mockSearch.mockRejectedValueOnce(new Error("upstream timeout"));
    const result = await toolDefinition.execute({ query });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;

    expect(parsed[0]).toMatchObject({ title: "Example Result" });
  });

  it("enforces minimum delay between consecutive outbound requests", async () => {
    appConfig.duckduckgoMinDelayMs = 25;
    appConfig.duckduckgoCacheTtlMs = 0;
    const callTimes: number[] = [];

    mockSearch.mockImplementation(async () => {
      callTimes.push(Date.now());
      return mockSearchResults;
    });

    await toolDefinition.execute({ query: "delay-case-1" });
    await toolDefinition.execute({ query: "delay-case-2" });

    expect(callTimes.length).toBe(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(20);
  });
});
