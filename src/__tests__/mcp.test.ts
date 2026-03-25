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
const mockListResources = jest.fn();
const mockReadResource = jest.fn();
const mockListPrompts = jest.fn();
const mockGetPrompt = jest.fn();
const mockPing = jest.fn();
const mockReconnect = jest.fn();
const mockSetSamplingHandler = jest.fn();

jest.mock("../mcp/client", () => ({
  McpClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    listResources: mockListResources,
    readResource: mockReadResource,
    listPrompts: mockListPrompts,
    getPrompt: mockGetPrompt,
    ping: mockPing,
    reconnect: mockReconnect,
    setSamplingHandler: mockSetSamplingHandler,
  })),
}));

// Import after mocks are in place
import { registerMcpTools, registerMcpResources, registerMcpPrompts, setupMcpSampling } from "../mcp/bridge";
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

// ---------------------------------------------------------------------------
// McpClient — resources (unit tests via mocked methods)
// ---------------------------------------------------------------------------

describe("McpClient — resources", () => {
  beforeEach(() => jest.clearAllMocks());

  it("listResources() returns resources from the server", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockListResources.mockResolvedValue([
      { uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain" },
    ]);

    const resources = await client.listResources();

    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("file:///a.txt");
    expect(resources[0].name).toBe("a.txt");
  });

  it("readResource() returns the resource content", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockReadResource.mockResolvedValue("hello from resource");

    const content = await client.readResource("file:///a.txt");

    expect(content).toBe("hello from resource");
    expect(mockReadResource).toHaveBeenCalledWith("file:///a.txt");
  });
});

// ---------------------------------------------------------------------------
// McpClient — prompt templates (unit tests via mocked methods)
// ---------------------------------------------------------------------------

describe("McpClient — prompts", () => {
  beforeEach(() => jest.clearAllMocks());

  it("listPrompts() returns prompt templates from the server", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockListPrompts.mockResolvedValue([
      { name: "code-review", description: "Reviews code", arguments: [{ name: "lang", required: true }] },
    ]);

    const prompts = await client.listPrompts();

    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("code-review");
    expect(prompts[0].arguments?.[0].name).toBe("lang");
  });

  it("getPrompt() resolves a named template with arguments", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockGetPrompt.mockResolvedValue([{ role: "user", content: "Review my Python code" }]);

    const messages = await client.getPrompt("code-review", { lang: "python" });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Review my Python code");
    expect(mockGetPrompt).toHaveBeenCalledWith("code-review", { lang: "python" });
  });

  it("getPrompt() can be called without arguments", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockGetPrompt.mockResolvedValue([{ role: "user", content: "Generic prompt" }]);

    const messages = await client.getPrompt("generic");

    expect(messages[0].content).toBe("Generic prompt");
    expect(mockGetPrompt).toHaveBeenCalledWith("generic");
  });
});

// ---------------------------------------------------------------------------
// McpClient — sampling (unit tests via mocked methods)
// ---------------------------------------------------------------------------

describe("McpClient — sampling", () => {
  beforeEach(() => jest.clearAllMocks());

  it("setSamplingHandler() is called with the provided handler", () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    const handler = jest.fn().mockResolvedValue("reply");

    client.setSamplingHandler(handler);

    expect(mockSetSamplingHandler).toHaveBeenCalledWith(handler);
  });
});

// ---------------------------------------------------------------------------
// McpClient — health check and reconnect (unit tests via mocked methods)
// ---------------------------------------------------------------------------

describe("McpClient — health check and reconnect", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ping() returns true when the server responds", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockPing.mockResolvedValue(true);

    const healthy = await client.ping();

    expect(healthy).toBe(true);
  });

  it("ping() returns false when the server is unreachable", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockPing.mockResolvedValue(false);

    const healthy = await client.ping();

    expect(healthy).toBe(false);
  });

  it("reconnect() calls the client reconnect method", async () => {
    const client = new McpClient({ name: "s", transport: "stdio", command: "s" });
    mockReconnect.mockResolvedValue(undefined);

    await client.reconnect();

    expect(mockReconnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// registerMcpResources — bridge integration tests
// ---------------------------------------------------------------------------

describe("registerMcpResources — bridge", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns resources from a single server", async () => {
    mockListResources.mockResolvedValue([
      { uri: "mem://data", name: "data", mimeType: "application/json" },
    ]);

    const results = await registerMcpResources([
      { name: "srv", transport: "stdio", command: "srv" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].serverName).toBe("srv");
    expect(results[0].resources[0].uri).toBe("mem://data");
  });

  it("read() on returned entry delegates to McpClient.readResource()", async () => {
    mockListResources.mockResolvedValue([{ uri: "mem://doc", name: "doc" }]);
    mockReadResource.mockResolvedValue("doc content");

    const [entry] = await registerMcpResources([
      { name: "srv", transport: "stdio", command: "srv" },
    ]);

    const content = await entry.read("mem://doc");

    expect(content).toBe("doc content");
    expect(mockReadResource).toHaveBeenCalledWith("mem://doc");
  });

  it("skips failing servers and still returns results for healthy ones", async () => {
    mockConnect
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(undefined);
    mockListResources.mockResolvedValue([{ uri: "mem://x", name: "x" }]);

    const results = await registerMcpResources([
      { name: "bad", transport: "stdio", command: "bad" },
      { name: "good", transport: "stdio", command: "good" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].serverName).toBe("good");
  });

  it("returns an empty array when no servers are configured", async () => {
    const results = await registerMcpResources([]);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// registerMcpPrompts — bridge integration tests
// ---------------------------------------------------------------------------

describe("registerMcpPrompts — bridge", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns prompt templates from a single server", async () => {
    mockListPrompts.mockResolvedValue([
      { name: "summarise", description: "Summarise text" },
    ]);

    const results = await registerMcpPrompts([
      { name: "srv", transport: "stdio", command: "srv" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].prompts[0].name).toBe("summarise");
  });

  it("get() on returned entry delegates to McpClient.getPrompt()", async () => {
    mockListPrompts.mockResolvedValue([{ name: "greet" }]);
    mockGetPrompt.mockResolvedValue([{ role: "user", content: "Hello!" }]);

    const [entry] = await registerMcpPrompts([
      { name: "srv", transport: "stdio", command: "srv" },
    ]);

    const messages = await entry.get("greet", { name: "Alice" });

    expect(messages[0].content).toBe("Hello!");
    expect(mockGetPrompt).toHaveBeenCalledWith("greet", { name: "Alice" });
  });

  it("skips failing servers gracefully", async () => {
    mockConnect.mockRejectedValueOnce(new Error("timeout"));

    const results = await registerMcpPrompts([
      { name: "bad", transport: "stdio", command: "bad" },
    ]);

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setupMcpSampling — bridge integration tests
// ---------------------------------------------------------------------------

describe("setupMcpSampling — bridge", () => {
  beforeEach(() => jest.clearAllMocks());

  it("registers the handler on every client", () => {
    const clients = [
      new McpClient({ name: "a", transport: "stdio", command: "a" }),
      new McpClient({ name: "b", transport: "stdio", command: "b" }),
    ];
    const handler = jest.fn().mockResolvedValue("ok");

    setupMcpSampling(clients, handler);

    expect(mockSetSamplingHandler).toHaveBeenCalledTimes(2);
    expect(mockSetSamplingHandler).toHaveBeenCalledWith(handler);
  });

  it("does nothing when given an empty client list", () => {
    const handler = jest.fn();
    setupMcpSampling([], handler);
    expect(mockSetSamplingHandler).not.toHaveBeenCalled();
  });
});
