import * as fs from "fs/promises";
import * as path from "path";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

/** Self-contained definition of a single agent tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod schema for input validation and LLM function-calling metadata. */
  schema: z.ZodTypeAny;
  /** Executes the tool with the parsed and validated arguments. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any) => Promise<string>;
  /** Permission level used by the security layer (Task 1.7). Defaults to "safe". */
  permissions?: "safe" | "cautious" | "dangerous";
  /** Per-tool timeout override in milliseconds (falls back to global TOOL_TIMEOUT_MS). */
  timeout?: number;
  /**
   * Optional: return the file path mutated by this tool given the call arguments.
   * Used by SubagentManager.runParallel to detect write conflicts across parallel subagents.
   */
  mutatesFile?: (args: Record<string, unknown>) => string | undefined;
}

/** Internal registry entry: holds the original definition and its LangChain wrapper. */
interface RegistryEntry {
  definition: ToolDefinition;
  langchainTool: StructuredToolInterface;
}

/**
 * Registry for agent tools.
 * Tools can be added manually via `register()` or auto-discovered
 * from a directory with `loadFromDirectory()`.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  /**
   * Register a tool.
   * @throws if a tool with the same name is already registered.
   */
  register(definition: ToolDefinition): void {
    if (this.entries.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    // Wrap the definition in a LangChain structured tool for bindTools/invoke compatibility.
    // `execute` is typed as `(args: any)` so it satisfies any Zod-inferred parameter type.
    const langchainTool = tool(definition.execute, {
      name: definition.name,
      description: definition.description,
      schema: definition.schema,
    });
    this.entries.set(definition.name, { definition, langchainTool });
  }

  /**
   * Unregister a tool by name.
   * No-op if the tool is not registered.
   */
  unregister(name: string): void {
    this.entries.delete(name);
  }

  /** Return the LangChain tool wrapper for a given name (for `.invoke()` calls). */
  get(name: string): StructuredToolInterface | undefined {
    return this.entries.get(name)?.langchainTool;
  }

  /** Return the raw ToolDefinition for a given name. */
  getDefinition(name: string): ToolDefinition | undefined {
    return this.entries.get(name)?.definition;
  }

  /** List all registered tools as `{ name, description }` pairs. */
  list(): Array<{ name: string; description: string }> {
    return Array.from(this.entries.values()).map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
    }));
  }

  /** Return all LangChain tool wrappers (used for `llm.bindTools()`). */
  toLangChainTools(): StructuredToolInterface[] {
    return Array.from(this.entries.values()).map(({ langchainTool }) => langchainTool);
  }

  /**
   * Dynamically load tools from a directory.
   *
   * Any `.ts` or `.js` file (excluding `registry.*` and test files) that
   * exports a `toolDefinition` constant is registered automatically.
   * This allows adding new tools without editing any existing file.
   */
  async loadFromDirectory(dirPath: string): Promise<void> {
    const files = await fs.readdir(dirPath);
    const toolFiles = files.filter(
      (f) =>
        (f.endsWith(".ts") || f.endsWith(".js")) &&
        !f.startsWith("registry") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.js")
    );

    for (const file of toolFiles) {
      const filePath = path.join(dirPath, file);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = await import(filePath);
      if (mod.toolDefinition) {
        this.register(mod.toolDefinition as ToolDefinition);
      }
    }
  }
}

/** Module-level singleton shared across the application. */
export const toolRegistry = new ToolRegistry();
