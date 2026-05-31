import { prepareToolArgs, validatePreparedToolArgs } from "../tools/arg-repair";
import { toolDefinition as shellTool } from "../tools/shell";
import { z } from "zod";
import type { ToolDefinition } from "../tools/registry";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({ input: z.string() }),
    execute: async ({ input }: { input: string }) => input,
  };
}

describe("tool arg repair", () => {
  test("normalizes shell array args into command string object", () => {
    const prepared = prepareToolArgs("shell", ["npm", "run", "build"]);
    expect(prepared).toEqual({ command: "npm run build" });
  });

  test("normalizes shell command array field while preserving other fields", () => {
    const prepared = prepareToolArgs("shell", {
      command: ["npm", "run", "build"],
      cwd: ".",
    });
    expect(prepared).toEqual({ command: "npm run build", cwd: "." });
  });

  test("keeps non-shell args unchanged", () => {
    const raw = { input: "hello" };
    expect(prepareToolArgs("search", raw)).toBe(raw);
  });

  test("produces structured error payload for invalid shell args", () => {
    const prepared = prepareToolArgs("shell", { command: 42 });
    try {
      validatePreparedToolArgs(shellTool, prepared, { command: 42 });
      throw new Error("Expected validatePreparedToolArgs to throw");
    } catch (error) {
      const payload = JSON.parse((error as Error).message) as {
        status: string;
        reason: string;
        retryable: boolean;
        expected: { command: string };
        example: { command: string };
      };
      expect(payload.status).toBe("invalid_input");
      expect(payload.reason).toBe("Invalid shell tool input");
      expect(payload.retryable).toBe(true);
      expect(payload.expected).toEqual({ command: "string" });
      expect(payload.example).toEqual({ command: "npm run build" });
    }
  });

  test("validates non-shell args against provided schema", () => {
    const def = makeTool("search");
    expect(() => validatePreparedToolArgs(def, { input: "ok" }, { input: "ok" })).not.toThrow();
    expect(() => validatePreparedToolArgs(def, { input: 1 }, { input: 1 })).toThrow(
      /Invalid arguments for tool 'search'/
    );
  });
});
