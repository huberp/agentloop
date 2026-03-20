import { tool } from "@langchain/core/tools";

const searchTool = tool(
  async (query: string) => {
    return `Search results for: ${query}`;
  },
  {
    name: "search",
    description: "Search the web for information",
  }
);

const calculateTool = tool(
  async (expression: string) => {
    // NOTE: Keep this as a simple demo calculator. Do not use eval in production.
    try {
      return `Result of ${expression}: ${eval(expression)}`;
    } catch (error) {
      return `Error calculating ${expression}: ${error}`;
    }
  },
  {
    name: "calculate",
    description: "Perform calculations",
  }
);

export const tools = [searchTool, calculateTool];