import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

/** A resource exposed by an MCP server (e.g. a file, database row, or live feed). */
export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A prompt template exposed by an MCP server. */
export interface McpPromptInfo {
  name: string;
  description?: string;
  /** Named arguments the template accepts. */
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** A single message in a resolved MCP prompt. */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Callback invoked when an MCP server requests an LLM completion (sampling).
 * Receives the conversation messages and optional preferences; must return the
 * assistant's reply text.
 */
export type McpSamplingHandler = (
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  preferences?: Record<string, unknown>
) => Promise<string>;

/**
 * Thin wrapper around the MCP SDK Client.
 * Handles transport selection, connection lifecycle, tool/resource/prompt discovery,
 * tool invocation, health checking, and sampling.
 */
export class McpClient {
  private readonly _client: Client;
  private _transport: Transport | null = null;
  private _samplingHandler: McpSamplingHandler | null = null;
  /** Prevents registerCapabilities from being called more than once on the same SDK client. */
  private _samplingCapabilityRegistered = false;

  constructor(private readonly config: McpServerConfig) {
    this._client = new Client(
      { name: "agentloop", version: "1.0.0" },
      { capabilities: {} }
    );
  }

  /** The logical name of this server as given in its config. */
  get serverName(): string {
    return this.config.name;
  }

  /**
   * Register a callback to handle sampling requests from the MCP server.
   * Must be called before connect() so the capability is advertised on handshake.
   */
  setSamplingHandler(handler: McpSamplingHandler): void {
    this._samplingHandler = handler;

    // Wire the SDK request handler; the capability is declared in connect()
    this._client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      // Flatten each message's content to a plain string for the handler
      const messages = request.params.messages.map((msg) => {
        const c = msg.content as { type: string; text?: string };
        const text = c.type === "text" && c.text != null ? c.text : JSON.stringify(c);
        return { role: msg.role as "user" | "assistant", content: text };
      });

      const reply = await handler(messages, request.params.modelPreferences as Record<string, unknown> | undefined);

      return {
        model: "agentloop",
        role: "assistant" as const,
        content: { type: "text" as const, text: reply },
        stopReason: "endTurn" as const,
      };
    });
  }

  /** Connect to the MCP server using the configured transport. */
  async connect(): Promise<void> {
    // Advertise sampling capability only when a handler has been registered,
    // and only once — the SDK client rejects duplicate capability registrations.
    if (this._samplingHandler && !this._samplingCapabilityRegistered) {
      this._client.registerCapabilities({ sampling: {} });
      this._samplingCapabilityRegistered = true;
    }
    this._transport = this._buildTransport();
    await this._client.connect(this._transport);
  }

  /** Disconnect from the MCP server and release resources. */
  async disconnect(): Promise<void> {
    await this._client.close();
  }

  /**
   * Send a ping and return true if the server responds, false otherwise.
   * Useful for liveness checks before issuing requests.
   */
  async ping(): Promise<boolean> {
    try {
      await this._client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Disconnect and reconnect to the MCP server.
   * Preserves any sampling handler registered before the previous connect().
   */
  async reconnect(): Promise<void> {
    try {
      await this.disconnect();
    } catch {
      // best-effort: ignore errors during teardown
    }
    this._transport = null;
    await this.connect();
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

  /** List all resources exposed by the connected MCP server. */
  async listResources(): Promise<McpResourceInfo[]> {
    const result = await this._client.listResources();
    return result.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /**
   * Read a resource by URI.
   * Text resources are returned as-is; binary blobs are returned as base64 strings.
   * Multiple content items are joined with newlines.
   */
  async readResource(uri: string): Promise<string> {
    const result = await this._client.readResource({ uri });
    const parts = result.contents.map((c) =>
      "text" in c ? c.text : (c as { blob: string }).blob
    );
    return parts.join("\n");
  }

  /** List all prompt templates exposed by the connected MCP server. */
  async listPrompts(): Promise<McpPromptInfo[]> {
    const result = await this._client.listPrompts();
    return result.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
  }

  /**
   * Retrieve and resolve a prompt template by name.
   * Template arguments fill in any placeholders defined by the server.
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptMessage[]> {
    const result = await this._client.getPrompt({ name, arguments: args });
    return result.messages.map((msg) => {
      const c = msg.content as { type: string; text?: string };
      const content = c.type === "text" && c.text != null ? c.text : JSON.stringify(c);
      return { role: msg.role as "user" | "assistant", content };
    });
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
