import { z } from "zod";
import { search } from "duck-duck-scrape";
import { appConfig } from "../config";
import { logger } from "../logger";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  query: z.string().describe("The search query"),
});

/** DuckDuckGo search tool — returns JSON array of { title, link, snippet } results. */
export const toolDefinition: ToolDefinition = {
  name: "search",
  description:
    "Search the web for information using DuckDuckGo. Returns a JSON array of results with title, link, and snippet.",
  schema,
  permissions: "safe",
  execute: async ({ query }: { query: string }) => {
    logger.debug({ tool: "search", query }, "DuckDuckGo search invoked");
    const { results } = await search(query);
    // Return only the fields advertised in the tool description: title, link, snippet
    const output = JSON.stringify(
      results
        .slice(0, appConfig.duckduckgoMaxResults)
        .map(({ title, url, description }) => ({ title, link: url, snippet: description }))
    );
    logger.debug({ tool: "search", query, output }, "DuckDuckGo search completed");
    return output;
  },
};
