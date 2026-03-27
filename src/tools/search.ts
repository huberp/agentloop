import { z } from "zod";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
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
    const searcher = new DuckDuckGoSearch({ maxResults: appConfig.duckduckgoMaxResults });
    const result = await searcher._call(query);
    logger.debug({ tool: "search", query, result }, "DuckDuckGo search completed");
    return result;
  },
};
