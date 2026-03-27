// Mock DuckDuckGoSearch before importing the tool so we can control its output
jest.mock("@langchain/community/tools/duckduckgo_search", () => {
  return {
    DuckDuckGoSearch: jest.fn().mockImplementation(() => ({
      _call: jest.fn().mockResolvedValue(
        JSON.stringify([
          { title: "Example Result", link: "https://example.com", snippet: "An example snippet." },
        ])
      ),
    })),
  };
});

import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { toolDefinition } from "../tools/search";
import { appConfig } from "../config";

const MockDuckDuckGoSearch = DuckDuckGoSearch as jest.MockedClass<typeof DuckDuckGoSearch>;

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
    MockDuckDuckGoSearch.mockClear();
  });

  it("instantiates DuckDuckGoSearch with maxResults from appConfig", async () => {
    await toolDefinition.execute({ query: "test query" });
    expect(MockDuckDuckGoSearch).toHaveBeenCalledWith({
      maxResults: appConfig.duckduckgoMaxResults,
    });
  });

  it("calls _call with the provided query string", async () => {
    await toolDefinition.execute({ query: "OpenAI news" });

    const instance = MockDuckDuckGoSearch.mock.results[0]?.value as { _call: jest.Mock };
    expect(instance._call).toHaveBeenCalledWith("OpenAI news");
  });

  it("returns the JSON string produced by DuckDuckGoSearch", async () => {
    const result = await toolDefinition.execute({ query: "TypeScript" });
    const parsed = JSON.parse(result) as Array<{ title: string; link: string; snippet: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ title: "Example Result", link: "https://example.com" });
  });

  it("propagates errors thrown by DuckDuckGoSearch", async () => {
    MockDuckDuckGoSearch.mockImplementationOnce(() => ({
      _call: jest.fn().mockRejectedValue(new Error("network error")),
    }));
    await expect(toolDefinition.execute({ query: "fail" })).rejects.toThrow("network error");
  });
});
