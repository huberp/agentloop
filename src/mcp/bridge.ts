import { z } from "zod";
import type { ToolDefinition } from "../tools/registry";
import type { ToolRegistry } from "../tools/registry";
import { McpClient, type McpServerConfig, type McpToolInfo } from "./client";
import { logger } from "../logger";

/**
 * Convert a JSON Schema property descriptor to a Zod type.
 * Handles the common primitive types; falls back to z.unknown() for complex schemas.
 */
function jsonSchemaPropertyToZod(propertySchema: object): z.ZodTypeAny {
  const s = propertySchema as Record<string, unknown>;
  switch (s["type"]) {
    case "string": {
      const enumValues = s["enum"];
      if (Array.isArray(enumValues) && enumValues.length >= 2) {
        return z.enum(enumValues as [string, string, ...string[]]);
      }
      return z.string();
    }
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Build a Zod object schema from an MCP inputSchema.
 * Each property becomes an optional or required Zod field based on the "required" list.
 */
function buildZodSchema(inputSchema: McpToolInfo["inputSchema"]): z.ZodTypeAny {
  const properties = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let zodType = jsonSchemaPropertyToZod(propSchema as object);
    // Add description if present in the JSON schema
    const desc = (propSchema as Record<string, unknown>)["description"];
    if (typeof desc === "string") {
      zodType = zodType.describe(desc);
    }
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return z.object(shape);
}

/**
 * Convert a single MCP tool definition into an agentloop ToolDefinition,
 * bound to the given McpClient for execution.
 */
function mcpToolToDefinition(tool: McpToolInfo, client: McpClient): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? tool.name,
    schema: buildZodSchema(tool.inputSchema),
    permissions: "safe",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (args: any): Promise<string> => client.callTool(tool.name, args),
  };
}

/**
 * Connect to each configured MCP server, discover its tools,
 * and register them in the given ToolRegistry.
 *
 * Returns the list of active McpClient instances so callers can disconnect them later.
 */
export async function registerMcpTools(
  serverConfigs: McpServerConfig[],
  registry: ToolRegistry
): Promise<McpClient[]> {
  const clients: McpClient[] = [];

  for (const config of serverConfigs) {
    const client = new McpClient(config);

    try {
      await client.connect();
      const tools = await client.listTools();

      for (const tool of tools) {
        const definition = mcpToolToDefinition(tool, client);
        registry.register(definition);
        logger.info({ server: config.name, tool: tool.name }, "Registered MCP tool");
      }

      clients.push(client);
      logger.info({ server: config.name, toolCount: tools.length }, "MCP server connected");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log and continue — a single failing MCP server must not abort the agent
      logger.error({ server: config.name, error: msg }, "Failed to connect MCP server; skipping");
      try {
        await client.disconnect();
      } catch {
        // best-effort cleanup
      }
    }
  }

  return clients;
}
