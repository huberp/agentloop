import { Tool } from "@langchain/core/tools";

export const tools: Tool[] = [
  {
    name: "search",
    description: "Search the web for information",
    func: async (query: string) => {
      // Implement web search logic or use an API
      return `Search results for: ${query}`;
    },
  },
  {
    name: "calculate",
    description: "Perform calculations",
    func: async (expression: string) => {
      return `Result of ${expression}: ${eval(expression)}`;
    },
  },
];