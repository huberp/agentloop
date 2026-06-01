import { z } from "zod";
import { search as duckDuckSearch } from "duck-duck-scrape";
import { appConfig } from "../config";
import { logger } from "../logger";
import { backoffMs, isRateLimitError } from "../retry";
import { analyzeWorkspace } from "../workspace";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  query: z.string().describe("The search query"),
});

/** Canonical result item returned by every search provider. */
export interface SearchOutputItem {
  title: string;
  link: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Shared in-memory cache (provider-agnostic)
// ---------------------------------------------------------------------------

interface SearchCacheEntry {
  cachedAt: number;
  expiresAt: number;
  results: SearchOutputItem[];
}

const queryCache = new Map<string, SearchCacheEntry>();
const workspaceLanguageCache = new Map<string, string>();

function pruneCache(): void {
  while (queryCache.size > appConfig.duckduckgoCacheMaxEntries) {
    const oldestKey = queryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    queryCache.delete(oldestKey);
  }
}

function getCachedEntry(query: string): SearchCacheEntry | undefined {
  const entry = queryCache.get(query);
  if (!entry) return undefined;
  // Touch key for basic LRU behavior.
  queryCache.delete(query);
  queryCache.set(query, entry);
  return entry;
}

function storeCachedEntry(query: string, results: SearchOutputItem[]): void {
  if (appConfig.duckduckgoCacheTtlMs <= 0 || appConfig.duckduckgoCacheMaxEntries <= 0) return;
  const now = Date.now();
  queryCache.set(query, {
    cachedAt: now,
    expiresAt: now + appConfig.duckduckgoCacheTtlMs,
    results,
  });
  pruneCache();
}

function explicitlyRequestsPython(text: string): boolean {
  return /\b(python|pip|pytest|requirements\.txt|pyproject\.toml|app\.py)\b/i.test(text);
}

function isNodeTsLanguage(language: string): boolean {
  return /^(node|typescript|javascript|ts|js)$/i.test(language.trim());
}

function alreadyConstrainedToTsJs(query: string): boolean {
  return /\b(typescript|javascript|node(?:\.js)?|nodejs)\b/i.test(query);
}

async function detectWorkspaceLanguage(): Promise<string> {
  const root = appConfig.workspaceRoot;
  const cached = workspaceLanguageCache.get(root);
  if (cached) return cached;
  try {
    const info = await analyzeWorkspace(root);
    const language = info.language ?? "unknown";
    workspaceLanguageCache.set(root, language);
    return language;
  } catch {
    return "unknown";
  }
}

async function shapeQuery(query: string): Promise<{ effectiveQuery: string; pythonRequested: boolean; preferTsJs: boolean }> {
  const pythonRequested = explicitlyRequestsPython(query);
  const workspaceLanguage = await detectWorkspaceLanguage();
  const preferTsJs = isNodeTsLanguage(workspaceLanguage) && !pythonRequested;
  if (
    appConfig.webSearchProvider !== "none" &&
    preferTsJs &&
    !alreadyConstrainedToTsJs(query)
  ) {
    return {
      effectiveQuery: `${query} (TypeScript OR JavaScript OR Node.js)`,
      pythonRequested,
      preferTsJs,
    };
  }
  return { effectiveQuery: query, pythonRequested, preferTsJs };
}

function rerankResults(
  results: SearchOutputItem[],
  options: { preferTsJs: boolean; pythonRequested: boolean },
): SearchOutputItem[] {
  if (!options.preferTsJs) return results;

  const tsRegex = /\b(typescript|javascript|node(?:\.js)?|npm|pnpm|yarn|sdk)\b/i;
  const pyRegex = /\b(python|pip|pytest|app\.py|requirements\.txt)\b/i;
  const scored = results.map((item, index) => {
    const text = `${item.title} ${item.snippet} ${item.link}`;
    let score = 0;
    if (tsRegex.test(text)) score += 2;
    if (!options.pythonRequested && pyRegex.test(text)) score -= 2;
    return { item, index, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });
  return scored.map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// DuckDuckGo provider
// ---------------------------------------------------------------------------

let lastDdgRequestAt = 0;
let ddgRateLimitQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDdgResults(
  rawResults: Array<{ title: string; url: string; description: string }>
): SearchOutputItem[] {
  return rawResults
    .slice(0, appConfig.duckduckgoMaxResults)
    .map(({ title, url, description }) => ({ title, link: url, snippet: description }));
}

function isTransientSearchError(error: unknown): boolean {
  if (isRateLimitError(error)) return true;
  if (typeof error !== "object" || error === null) return false;

  const e = error as Record<string, unknown>;
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (status !== undefined && status >= 500) return true;

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("econnreset") ||
    message.includes("eai_again") ||
    message.includes("rate limit")
  );
}

async function waitForDdgRateLimitSlot(): Promise<void> {
  if (appConfig.duckduckgoMinDelayMs <= 0) return;

  const run = async () => {
    const elapsed = Date.now() - lastDdgRequestAt;
    const waitMs = Math.max(0, appConfig.duckduckgoMinDelayMs - elapsed);
    if (waitMs > 0) {
      logger.debug({ tool: "search", provider: "duckduckgo", waitMs }, "Applying DuckDuckGo rate-limit delay");
      await sleep(waitMs);
    }
    lastDdgRequestAt = Date.now();
  };

  ddgRateLimitQueue = ddgRateLimitQueue.then(run, run);
  await ddgRateLimitQueue;
}

async function searchDuckDuckGo(query: string): Promise<SearchOutputItem[]> {
  const maxRetries = Math.max(0, appConfig.duckduckgoRetryMax);
  const baseDelayMs = Math.max(0, appConfig.duckduckgoRetryBaseDelayMs);
  const rateLimitPenaltyMs = Math.max(0, appConfig.duckduckgoRateLimitPenaltyMs);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await waitForDdgRateLimitSlot();
      const { results } = await duckDuckSearch(query);
      return normalizeDdgResults(results as Array<{ title: string; url: string; description: string }>);
    } catch (error) {
      lastError = error;
      const retryable = isTransientSearchError(error);
      if (!retryable || attempt >= maxRetries) break;

      const delayMs = backoffMs(attempt, baseDelayMs) + (isRateLimitError(error) ? rateLimitPenaltyMs : 0);
      logger.warn(
        {
          tool: "search",
          provider: "duckduckgo",
          query,
          attempt: attempt + 1,
          maxRetries,
          retryable,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        },
        "DuckDuckGo search failed; retrying"
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Tavily provider  (https://docs.tavily.com)
// ---------------------------------------------------------------------------

interface TavilySearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

async function searchTavily(query: string): Promise<SearchOutputItem[]> {
  const apiKey = appConfig.tavilyApiKey;
  if (!apiKey) {
    throw new Error("Tavily API key is not configured. Set TAVILY_API_KEY in your environment.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: appConfig.tavilyMaxResults,
      search_depth: "basic",
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as TavilySearchResponse;
  return (data.results ?? []).map(({ title, url, content }) => ({
    title,
    link: url,
    snippet: content,
  }));
}

// ---------------------------------------------------------------------------
// LangSearch provider  (https://langsearch.com)
// ---------------------------------------------------------------------------

interface LangSearchResponse {
  code?: number;
  webPages?: {
    value: Array<{
      name: string;
      url: string;
      snippet: string;
    }>;
  };
}

async function searchLangSearch(query: string): Promise<SearchOutputItem[]> {
  const apiKey = appConfig.langsearchApiKey;
  if (!apiKey) {
    throw new Error("LangSearch API key is not configured. Set LANGSEARCH_API_KEY in your environment.");
  }

  const response = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      count: appConfig.langsearchMaxResults,
      freshness: "noLimit",
      summary: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`LangSearch API error: HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as LangSearchResponse;
  return (data.webPages?.value ?? []).map(({ name, url, snippet }) => ({
    title: name,
    link: url,
    snippet,
  }));
}

// ---------------------------------------------------------------------------
// Provider dispatch
// ---------------------------------------------------------------------------

/** Execute the configured search provider for the given query. */
async function runSearch(query: string): Promise<SearchOutputItem[]> {
  const provider = appConfig.webSearchProvider;

  switch (provider) {
    case "tavily":
      return searchTavily(query);

    case "langsearch":
      return searchLangSearch(query);

    case "none":
      logger.debug({ tool: "search", provider: "none", query }, "Search provider is 'none'; returning empty results");
      return [];

    default:
      // "duckduckgo" (and any unrecognised value falls back to DDG)
      return searchDuckDuckGo(query);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/** Multi-provider web search tool — returns JSON array of { title, link, snippet }. */
export const toolDefinition: ToolDefinition = {
  name: "search",
  description:
    "Search the web for information. Returns a JSON array of results with title, link, and snippet fields. " +
    "The active provider is controlled by WEB_SEARCH_PROVIDER (duckduckgo | tavily | langsearch | none). " +
    "On failure, returns a JSON object with error details and an empty results array.",
  schema,
  permissions: "safe",
  execute: async ({ query }: { query: string }) => {
    const provider = appConfig.webSearchProvider;
    const startedAt = Date.now();
    const { effectiveQuery, pythonRequested, preferTsJs } = await shapeQuery(query);
    const cacheKey = effectiveQuery;
    logger.debug({ tool: "search", provider, query, effectiveQuery }, "Search invoked");

    const cached = getCachedEntry(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug(
        {
          tool: "search",
          provider,
          query,
          effectiveQuery,
          cacheHit: true,
          resultCount: cached.results.length,
          elapsedMs: Date.now() - startedAt,
        },
        "Search cache hit"
      );
      return JSON.stringify(cached.results);
    }

    try {
      const rawResults = await runSearch(effectiveQuery);
      const results = rerankResults(rawResults, { preferTsJs, pythonRequested });
      storeCachedEntry(cacheKey, results);
      logger.debug(
        {
          tool: "search",
          provider,
          query,
          effectiveQuery,
          cacheHit: false,
          resultCount: results.length,
          elapsedMs: Date.now() - startedAt,
        },
        "Search completed"
      );
      return JSON.stringify(results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached && appConfig.duckduckgoServeStaleOnError) {
        logger.warn(
          {
            tool: "search",
            provider,
            query,
            effectiveQuery,
            cacheHit: true,
            staleCacheServed: true,
            resultCount: cached.results.length,
            elapsedMs: Date.now() - startedAt,
            error: message,
          },
          "Search failed; serving stale cached results"
        );
        return JSON.stringify(cached.results);
      }

      logger.warn(
        {
          tool: "search",
          provider,
          query,
          effectiveQuery,
          cacheHit: false,
          elapsedMs: Date.now() - startedAt,
          error: message,
        },
        "Search failed"
      );
      return JSON.stringify({
        error: message,
        query,
        results: [],
      });
    }
  },
};
