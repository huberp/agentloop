import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { appConfig } from "../config";
import { processUrl } from "./web-utils";
import { logger } from "../logger";

const schema = z.object({
  query: z.string().describe("Search query"),
  maxResults: z.number().int().min(1).max(20).optional().default(5).describe("Maximum number of results to return (default: 5)"),
});

/** A single search result entry. */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Call the Brave Search API and return structured results. */
async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": appConfig.braveApiKey,
    },
    signal: AbortSignal.timeout(appConfig.webFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webResults: any[] = data?.web?.results ?? [];

  return webResults.slice(0, maxResults).map((r) => {
    const { cleanUrl } = processUrl(r.url ?? "");
    return {
      title: r.title ?? "",
      url: cleanUrl,
      snippet: r.description ?? "",
    };
  });
}

/** Call the Tavily Search API and return structured results. */
async function searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: appConfig.tavilyApiKey,
      query,
      max_results: maxResults,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(appConfig.webFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Tavily Search API error: ${response.status} ${response.statusText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = data?.results ?? [];

  return results.slice(0, maxResults).map((r) => {
    const { cleanUrl } = processUrl(r.url ?? "");
    return {
      title: r.title ?? "",
      url: cleanUrl,
      snippet: r.content ?? "",
    };
  });
}

export const toolDefinition: ToolDefinition = {
  name: "web-search",
  description:
    "Search the web and return a list of relevant results (title, URL, snippet). " +
    "URLs in results have tracking parameters removed. " +
    "Requires WEB_SEARCH_PROVIDER to be configured (brave or tavily).",
  schema,
  permissions: "cautious",
  execute: async ({ query, maxResults = 5 }: { query: string; maxResults?: number }): Promise<string> => {
    const provider = appConfig.webSearchProvider;

    if (provider === "none") {
      return JSON.stringify({
        error:
          "Web search is disabled. Set WEB_SEARCH_PROVIDER=brave or WEB_SEARCH_PROVIDER=tavily " +
          "and configure the corresponding API key (BRAVE_API_KEY or TAVILY_API_KEY) to enable it.",
      });
    }

    logger.info({ tool: "web-search", provider, query, maxResults }, "web-search invoked");

    try {
      let results: SearchResult[];
      if (provider === "brave") {
        if (!appConfig.braveApiKey) {
          return JSON.stringify({ error: "BRAVE_API_KEY is not configured." });
        }
        results = await searchBrave(query, maxResults);
      } else if (provider === "tavily") {
        if (!appConfig.tavilyApiKey) {
          return JSON.stringify({ error: "TAVILY_API_KEY is not configured." });
        }
        results = await searchTavily(query, maxResults);
      } else {
        return JSON.stringify({ error: `Unknown search provider: "${provider}".` });
      }

      logger.info({ tool: "web-search", resultCount: results.length }, "web-search completed");
      return JSON.stringify({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ tool: "web-search", error: message }, "web-search failed");
      return JSON.stringify({ error: message });
    }
  },
};
