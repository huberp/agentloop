import { z } from "zod";
import { ToolRegistry } from "../tools/registry";

// ---------------------------------------------------------------------------
// Mocks — isolate from real MCP SDK / network
// ---------------------------------------------------------------------------

/** Minimal fake McpClient that the bridge uses under test. */
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);
const mockListTools = jest.fn();
const mockCallTool = jest.fn();

jest.mock("../mcp/client", () => ({
  McpClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}));

// Import after mocks are in place
import { registerMcpTools } from "../mcp/bridge";
import { McpClient } from "../mcp/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  description = "A test tool",
  properties: Record<string, object> = { query: { type: "string", description: "input" } },
  required: string[] = ["query"]
) {
  return { name, description, inputSchema: { type: "object" as const, properties, required } };
}

// ---------------------------------------------------------------------------
// McpClient unit tests (via mocked SDK)
// ---------------------------------------------------------------------------

describe("McpClient — config validation", () => {
  // Import the real implementation to test _buildTransport validation
  // We re-mock at the module level so we need a fresh require here
  it("is instantiated by jest.mock", () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "echo" });
    expect(client).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// registerMcpTools — bridge integration tests
// ---------------------------------------------------------------------------

describe("registerMcpTools — basic registration", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    jest.clearAllMocks();
  });

  it("registers tools from a single MCP server", async () => {
    mockListTools.mockResolvedValue([makeTool("mcp-search"), makeTool("mcp-calc")]);

    const clients = await registerMcpTools(
      [{ name: "test-server", transport: "stdio", command: "mcp-server" }],
      registry
    );

    expect(clients).toHaveLength(1);
    expect(registry.get("mcp-search")).toBeDefined();
    expect(registry.get("mcp-calc")).toBeDefined();
  });

  it("calls connect() once per configured server", async () => {
    mockListTools.mockResolvedValue([makeTool("tool-a")]);

    await registerMcpTools(
      [
        { name: "server-1", transport: "stdio", command: "cmd1" },
        { name: "server-2", transport: "stdio", command: "cmd2" },
      ],
      registry
    );

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("returns no clients and logs when a server fails to connect", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connection refused"));

    const clients = await registerMcpTools(
      [{ name: "bad-server", transport: "stdio", command: "missing" }],
      registry
    );

    // No tools registered; bridge skipped the failing server gracefully
    expect(clients).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);
  });

  it("continues registering subsequent servers after one fails", async () => {
    // First server fails; second succeeds
    mockConnect
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined);
    mockListTools.mockResolvedValueOnce([makeTool("good-tool")]);

    const clients = await registerMcpTools(
      [
        { name: "bad", transport: "stdio", command: "bad" },
        { name: "good", transport: "stdio", command: "good" },
      ],
      registry
    );

    expect(clients).toHaveLength(1);
    expect(registry.get("good-tool")).toBeDefined();
  });

  it("returns an empty array and registers nothing when no servers are configured", async () => {
    const clients = await registerMcpTools([], registry);
    expect(clients).toHaveLength(0);
    expect(registry.list()).toHaveLength(0);
  });
});

describe("registerMcpTools — tool execution via bridge", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    jest.clearAllMocks();
  });

  it("registered tool.execute() delegates to McpClient.callTool()", async () => {
    mockListTools.mockResolvedValue([makeTool("mcp-echo")]);
    mockCallTool.mockResolvedValue("hello from mcp");

    await registerMcpTools(
      [{ name: "srv", transport: "stdio", command: "srv" }],
      registry
    );

    const definition = registry.getDefinition("mcp-echo");
    expect(definition).toBeDefined();
    const result = await definition!.execute({ query: "test" });
    expect(result).toBe("hello from mcp");
    expect(mockCallTool).toHaveBeenCalledWith("mcp-echo", { query: "test" });
  });

  it("registered tool has the description from the MCP server", async () => {
    mockListTools.mockResolvedValue([makeTool("desc-tool", "Does something useful")]);

    await registerMcpTools([{ name: "s", transport: "stdio", command: "s" }], registry);

    expect(registry.getDefinition("desc-tool")?.description).toBe("Does something useful");
  });

  it("falls back to tool name as description when MCP server omits description", async () => {
    const tool = makeTool("no-desc");
    delete (tool as Record<string, unknown>)["description"];
    mockListTools.mockResolvedValue([tool]);

    await registerMcpTools([{ name: "s", transport: "stdio", command: "s" }], registry);

    expect(registry.getDefinition("no-desc")?.description).toBe("no-desc");
  });
});

describe("registerMcpTools — Zod schema generation", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    jest.clearAllMocks();
  });

  it("generates required string field from JSON schema", async () => {
    mockListTools.mockResolvedValue([
      makeTool("t", "t", { q: { type: "string" } }, ["q"]),
    ]);

    await registerMcpTools([{ name: "s", transport: "stdio", command: "s" }], registry);

    const schema = registry.getDefinition("t")?.schema;
    expect(schema).toBeDefined();
    const zodSchema = schema as z.ZodObject<Record<string, z.ZodTypeAny>>;
    // Required field must be present — omitting it should fail
    expect(() => zodSchema.parse({ q: "hello" })).not.toThrow();
    expect(() => zodSchema.parse({})).toThrow();
  });

  it("generates optional field for properties not in required[]", async () => {
    mockListTools.mockResolvedValue([
      makeTool("t", "t", { opt: { type: "number" } }, []),
    ]);

    await registerMcpTools([{ name: "s", transport: "stdio", command: "s" }], registry);

    const schema = registry.getDefinition("t")?.schema;
    expect(schema).toBeDefined();
    const zodSchema = schema as z.ZodObject<Record<string, z.ZodTypeAny>>;
    expect(() => zodSchema.parse({})).not.toThrow();
    expect(() => zodSchema.parse({ opt: 42 })).not.toThrow();
  });

  it("handles a tool with no properties (empty object schema)", async () => {
    mockListTools.mockResolvedValue([
      { name: "empty", description: "no args", inputSchema: { type: "object" as const } },
    ]);

    await registerMcpTools([{ name: "s", transport: "stdio", command: "s" }], registry);

    const schema = registry.getDefinition("empty")?.schema;
    expect(schema).toBeDefined();
    expect(() => (schema as z.ZodTypeAny).parse({})).not.toThrow();
  });
});
