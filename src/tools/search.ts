import { z } from "zod";
import { search } from "duck-duck-scrape";
import { appConfig } from "../config";
import { logger } from "../logger";
import { backoffMs, isRateLimitError } from "../retry";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  query: z.string().describe("The search query"),
});

interface SearchOutputItem {
  title: string;
  link: string;
  snippet: string;
}

interface SearchCacheEntry {
  cachedAt: number;
  expiresAt: number;
  results: SearchOutputItem[];
}

const queryCache = new Map<string, SearchCacheEntry>();
let lastRequestAt = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeResults(rawResults: Array<{ title: string; url: string; description: string }>): SearchOutputItem[] {
  return rawResults
    .slice(0, appConfig.duckduckgoMaxResults)
    .map(({ title, url, description }) => ({ title, link: url, snippet: description }));
}

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

async function waitForRateLimitSlot(): Promise<void> {
  if (appConfig.duckduckgoMinDelayMs <= 0) return;

  const run = async () => {
    const elapsed = Date.now() - lastRequestAt;
    const waitMs = Math.max(0, appConfig.duckduckgoMinDelayMs - elapsed);
    if (waitMs > 0) {
      logger.debug({ tool: "search", waitMs }, "Applying DuckDuckGo rate-limit delay");
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
  };

  rateLimitQueue = rateLimitQueue.then(run, run);
  await rateLimitQueue;
}

async function searchWithRetry(query: string): Promise<{ results: SearchOutputItem[]; attempts: number }> {
  const maxRetries = Math.max(0, appConfig.duckduckgoRetryMax);
  const baseDelayMs = Math.max(0, appConfig.duckduckgoRetryBaseDelayMs);
  const rateLimitPenaltyMs = Math.max(0, appConfig.duckduckgoRateLimitPenaltyMs);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await waitForRateLimitSlot();
      const { results } = await search(query);
      return {
        results: normalizeResults(results as Array<{ title: string; url: string; description: string }>),
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      const retryable = isTransientSearchError(error);
      if (!retryable || attempt >= maxRetries) break;

      const delayMs = backoffMs(attempt, baseDelayMs) + (isRateLimitError(error) ? rateLimitPenaltyMs : 0);
      logger.warn(
        {
          tool: "search",
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

/** DuckDuckGo search tool — returns JSON array of { title, link, snippet } results. */
export const toolDefinition: ToolDefinition = {
  name: "search",
  description:
    "Search the web for information using DuckDuckGo. Returns a JSON array of results with title, link, and snippet. On failure, returns a JSON object with error details and an empty results array.",
  schema,
  permissions: "safe",
  execute: async ({ query }: { query: string }) => {
    const startedAt = Date.now();
    logger.debug({ tool: "search", query }, "DuckDuckGo search invoked");

    const cached = getCachedEntry(query);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug(
        {
          tool: "search",
          query,
          cacheHit: true,
          resultCount: cached.results.length,
          elapsedMs: Date.now() - startedAt,
        },
        "DuckDuckGo search cache hit"
      );
      return JSON.stringify(cached.results);
    }

    try {
      const { results, attempts } = await searchWithRetry(query);
      storeCachedEntry(query, results);
      logger.debug(
        {
          tool: "search",
          query,
          attempts,
          cacheHit: false,
          resultCount: results.length,
          elapsedMs: Date.now() - startedAt,
        },
        "DuckDuckGo search completed"
      );
      return JSON.stringify(results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached && appConfig.duckduckgoServeStaleOnError) {
        logger.warn(
          {
            tool: "search",
            query,
            cacheHit: true,
            staleCacheServed: true,
            resultCount: cached.results.length,
            elapsedMs: Date.now() - startedAt,
            error: message,
          },
          "DuckDuckGo search failed; serving stale cached results"
        );
        return JSON.stringify(cached.results);
      }

      logger.warn(
        {
          tool: "search",
          query,
          cacheHit: false,
          elapsedMs: Date.now() - startedAt,
          error: message,
        },
        "DuckDuckGo search failed"
      );
      return JSON.stringify({
        error: message,
        query,
        results: [],
      });
    }
  },
};
