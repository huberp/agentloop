import { z } from "zod";
import { evaluate } from "mathjs";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  expression: z.string().describe("A mathematical expression to evaluate, e.g. '2 + 3 * 4'"),
});

/**
 * Safe calculator tool powered by mathjs.
 * Replaces the previous eval()-based implementation.
 */
export const toolDefinition: ToolDefinition = {
  name: "calculate",
  description: "Perform safe mathematical calculations",
  schema,
  permissions: "safe",
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = evaluate(expression);
      return `Result of ${expression}: ${result}`;
    } catch (error) {
      return `Error calculating "${expression}": ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
