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

  it("propagates errors thrown by duck-duck-scrape search()", async () => {
    mockSearch.mockRejectedValueOnce(new Error("network error"));
    await expect(toolDefinition.execute({ query: "fail" })).rejects.toThrow("network error");
  });
});
