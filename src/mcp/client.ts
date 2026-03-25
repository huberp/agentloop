import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Configuration for a single MCP server connection. */
export interface McpServerConfig {
  /** Logical name used to namespace tools from this server. */
  name: string;
  /** Transport type: "stdio" (spawns a subprocess) or "sse" (HTTP/SSE endpoint). */
  transport: "stdio" | "sse";
  /** Executable to spawn — required for stdio transport. */
  command?: string;
  /** Arguments passed to the spawned process — used with stdio transport. */
  args?: string[];
  /** HTTP(S) URL of the SSE endpoint — required for sse transport. */
  url?: string;
}

/** Represents a single MCP tool returned by listTools(). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Thin wrapper around the MCP SDK Client.
 * Handles transport selection, connection lifecycle, and tool discovery/invocation.
 */
export class McpClient {
  private readonly _client: Client;
  private _transport: Transport | null = null;

  constructor(private readonly config: McpServerConfig) {
    this._client = new Client(
      { name: "agentloop", version: "1.0.0" },
      { capabilities: {} }
    );
  }

  /** Connect to the MCP server using the configured transport. */
  async connect(): Promise<void> {
    this._transport = this._buildTransport();
    await this._client.connect(this._transport);
  }

  /** Disconnect from the MCP server and release resources. */
  async disconnect(): Promise<void> {
    await this._client.close();
  }

  /** List all tools exposed by the connected MCP server. */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this._client.listTools();
    return result.tools as McpToolInfo[];
  }

  /**
   * Invoke a tool on the MCP server.
   * Returns the textual content of the response joined by newlines.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this._client.callTool({ name, arguments: args });

    // Extract text from content items; fall back to JSON for non-text content
    const parts = (result.content as Array<{ type: string; text?: string }>).map(
      (item) => (item.type === "text" && item.text != null ? item.text : JSON.stringify(item))
    );
    return parts.join("\n");
  }

  /** Build the transport based on the server config. */
  private _buildTransport(): Transport {
    if (this.config.transport === "stdio") {
      if (!this.config.command) {
        throw new Error(`MCP server "${this.config.name}": "command" is required for stdio transport`);
      }
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
      });
    }

    if (this.config.transport === "sse") {
      if (!this.config.url) {
        throw new Error(`MCP server "${this.config.name}": "url" is required for sse transport`);
      }
      return new SSEClientTransport(new URL(this.config.url));
    }

    throw new Error(`MCP server "${this.config.name}": unsupported transport "${(this.config as McpServerConfig).transport}"`);
  }
}
