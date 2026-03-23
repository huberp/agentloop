import { z } from "zod";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  query: z.string().describe("The search query"),
});

/** Mock search tool — placeholder for a real web-search integration. */
export const toolDefinition: ToolDefinition = {
  name: "search",
  description: "Search the web for information",
  schema,
  permissions: "safe",
  execute: async ({ query }: { query: string }) => {
    return `Search results for: ${query}`;
  },
};
